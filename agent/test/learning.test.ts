import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { AGENTS } from "../agents";
import { CLIENTS } from "../clients";
import type { JsonObject, ToolDefinition } from "../src/contracts";
import type { Lesson } from "../src/learning";
import { runTurn } from "../src/loop";
import type { ModelAdapter, ModelTurnRequest } from "../src/model";
import { quotesPerson } from "../src/review";
import { Store } from "../src/store";
import { testDeskApi } from "./desk";
import { signUserPass } from "../src/user-auth";
import { allowApprover, APPROVER } from "./access";

const auth = { authorization: "Bearer test-token-acme-0123456789abcdef", "content-type": "application/json" };
beforeEach(async () => { await allowApprover(); });
const approverPass = (who = APPROVER) => signUserPass("test-approver-key-acme-0123456789abcdef", "acme", who, Math.floor(Date.now() / 1000) + 3600, "approve");
const usage = { inputTokens: 5, outputTokens: 2 };
const call = (id: string, name: string, args: JsonObject) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

// Each test uses its own client store name, so lessons from one test never leak into another.
const learning = (name: string) => env.LEARNING.get(env.LEARNING.idFromName(name));
const proposal = (text: string, over: Partial<Lesson> = {}) => ({ agent: "second", kind: "preference" as const, text, evidence: "say it like this", conversationId: "c1", ...over });

const decide = async (id: string, decision: string, pass?: string | null) => SELF.fetch(`https://brain/v1/lessons/${id}`, {
  method: "POST", body: JSON.stringify({ decision }),
  headers: { ...auth, ...(pass === null ? {} : { "x-approver-pass": pass ?? await approverPass() }) },
});

describe("lessons store", () => {
  it("only active lessons reach a run; removing one blocks the same text from coming back", async () => {
    const store = learning("store-1");
    await store.propose("l1", proposal("Report Google and Meta separately, never as one total."));
    expect(await store.active("third")).toEqual([]);

    expect((await store.decide("l1", "approve", "p1")).ok).toBe(true);
    expect((await store.active("second")).map(l => l.text)).toEqual(["Report Google and Meta separately, never as one total."]);
    expect(await store.active("third")).toEqual([]);

    expect(await store.decide("l1", "remove", "p1")).toMatchObject({ ok: true, lesson: { status: "removed" } });
    expect(await store.active("third")).toEqual([]);
    expect(await store.propose("l2", proposal("report google and meta separately — never as one total"))).toMatchObject({ ok: false });
    expect(await store.decide("l1", "approve", "p1")).toMatchObject({ ok: false, status: 409 });
  });

  it("refuses duplicates, applies client-wide lessons to every agent, and replaces on approval", async () => {
    const store = learning("store-2");
    await store.propose("a", proposal("Call the owner Jay, not Mr. Robinson.", { agent: null }));
    expect(await store.propose("b", proposal("Call the owner Jay, not Mr. Robinson.", { agent: null }))).toMatchObject({ ok: false });
    await store.decide("a", "approve", "p1");
    expect((await store.active("third")).map(l => l.id)).toEqual(["a"]);

    await store.propose("c", proposal("Call the owner Jay or JR, both are fine.", { agent: null, replaces: "a" }));
    await store.decide("c", "approve", "p1");
    expect((await store.active("helper")).map(l => l.id)).toEqual(["c"]);
  });
});

describe("reviewer evidence", () => {
  const lines = [{ seq: 1, role: "user" as const, text: "Please never  compare Meta to Google." }, { seq: 2, role: "assistant" as const, text: "I will keep them separate." }];

  it("accepts only the person's own words (or a decline reason), never the agent's", () => {
    expect(quotesPerson("never compare meta to google", { lines })).toBe(true);
    expect(quotesPerson("I will keep them separate", { lines })).toBe(false);
    expect(quotesPerson("too salesy", { lines, declines: [{ title: "publish_blog", reason: "Too salesy for our brand." }] })).toBe(true);
  });
});

describe("learning end to end", () => {
  it("a person's correction becomes a proposal, and only after approval reaches the agent's next run", async () => {
    const conversationId = "learn-e2e";
    const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`acme/second/${conversationId}`));
    const systems: string[] = [];
    await runInDurableObject(stub, async instance => {
      instance.model = {
        async turn(request: ModelTurnRequest) {
          const system = String(request.messages[0].content);
          if (!system.startsWith("You review")) {
            systems.push(system);
            return { content: "Understood.", toolCalls: [], usage };
          }
          const step = request.messages.filter(m => m.role === "tool").length;
          if (step === 0) return { content: "", toolCalls: [
            call("p1", "lesson_propose", { text: "Report Google and Meta separately.", kind: "preference", scope: "this_agent", evidence: "keep Google and Meta separate" }),
            call("p2", "lesson_propose", { text: "Say understood after every message.", kind: "preference", scope: "this_agent", evidence: "Understood." }),
          ], usage };
          return { content: "", toolCalls: [call("d", "review_done", {})], usage };
        },
      } satisfies ModelAdapter;
      const read = async (text: string, id: string) => {
        await new Response(await instance.turn({ clientId: "acme", agentId: "second", conversationId, userId: "person-1", input: { id, text } })).text();
      };
      await read("From now on keep Google and Meta separate in reports.", "m1");
      await instance.alarm();
    });

    const { lessons } = await (await SELF.fetch("https://brain/v1/agents/second/lessons", { headers: auth })).json() as { lessons: Lesson[] };
    // The proposal quoting the agent was refused in code; the person's correction waits for approval.
    expect(lessons.map(l => [l.text, l.status, l.evidence])).toEqual([["Report Google and Meta separately.", "proposed", "keep Google and Meta separate"]]);
    expect(systems[0]).not.toContain("Report Google and Meta separately.");

    expect((await decide(lessons[0].id, "approve", null)).status).toBe(401);
    expect((await decide(lessons[0].id, "approve", await approverPass("someone-else"))).status).toBe(403);
    expect(await (await decide(lessons[0].id, "approve")).json()).toMatchObject({ lesson: { status: "active", decidedBy: APPROVER } });

    // A scheduled job (its own conversation, no person) still gets the approved lesson.
    const job = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName("acme/second/learn-e2e-job"));
    await runInDurableObject(job, async instance => {
      instance.model = { async turn(request: ModelTurnRequest) { systems.push(String(request.messages[0].content)); return { content: "Checked.", toolCalls: [], usage }; } };
      await new Response(await instance.turn({ clientId: "acme", agentId: "second", conversationId: "learn-e2e-job", input: { id: "job-1", text: "Daily ads check" } })).text();
    });
    expect(systems.at(-1)).toContain("(preference) Report Google and Meta separately.");
  });

  it("a failed review loses nothing: the same correction is learned when the review runs again", async () => {
    const conversationId = "learn-retry";
    const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`acme/second/${conversationId}`));
    let reviewerUp = false;
    const texts = await runInDurableObject(stub, async instance => {
      instance.model = {
        async turn(request: ModelTurnRequest) {
          if (!String(request.messages[0].content).startsWith("You review")) return { content: "Noted.", toolCalls: [], usage };
          if (!reviewerUp) throw new Error("provider down");
          return request.messages.some(m => m.role === "tool")
            ? { content: "", toolCalls: [call("d", "review_done", {})], usage }
            : { content: "", toolCalls: [call("p", "lesson_propose", { text: "Send the weekly report on Fridays.", kind: "procedure", scope: "this_agent", evidence: "send the weekly report on Fridays" })], usage };
        },
      } satisfies ModelAdapter;
      await new Response(await instance.turn({ clientId: "acme", agentId: "second", conversationId, userId: "person-2", input: { id: "m1", text: "Please send the weekly report on Fridays." } })).text();
      await instance.alarm();
      const afterFailure = (await learning("acme").list("second")).map(l => l.text);
      reviewerUp = true;
      await instance.alarm();
      return { afterFailure, afterRetry: (await learning("acme").list("second")).map(l => l.text) };
    });
    expect(texts.afterFailure).not.toContain("Send the weekly report on Fridays.");
    expect(texts.afterRetry).toContain("Send the weekly report on Fridays.");
  });

  it("a message that arrives while a review is running is reviewed next, not dropped", async () => {
    const conversationId = "learn-overlap";
    const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`acme/second/${conversationId}`));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const texts = await runInDurableObject(stub, async instance => {
      instance.model = {
        async turn(request: ModelTurnRequest) {
          if (!String(request.messages[0].content).startsWith("You review")) return { content: "Noted.", toolCalls: [], usage };
          if (request.messages.some(m => m.role === "tool")) return { content: "", toolCalls: [call("d", "review_done", {})], usage };
          const transcript = String(request.messages[1].content);
          if (transcript.includes("Mondays")) {
            await gate;
            return { content: "", toolCalls: [call("a", "lesson_propose", { text: "Hold the team call on Mondays.", kind: "procedure", scope: "this_agent", evidence: "hold the team call on Mondays" })], usage };
          }
          return { content: "", toolCalls: [call("b", "lesson_propose", { text: "Copy JR on every invoice question.", kind: "procedure", scope: "this_agent", evidence: "copy JR on every invoice question" })], usage };
        },
      } satisfies ModelAdapter;
      const say = async (id: string, text: string) => { await new Response(await instance.turn({ clientId: "acme", agentId: "second", conversationId, userId: "person-3", input: { id, text } })).text(); };
      await say("m1", "Please hold the team call on Mondays.");
      const running = instance.alarm();
      await say("m2", "And copy JR on every invoice question.");
      release();
      await running;
      await instance.alarm();
      return (await learning("acme").list("second")).map(l => l.text);
    });
    expect(texts).toEqual(expect.arrayContaining(["Hold the team call on Mondays.", "Copy JR on every invoice question."]));
  });

  it("a long backlog is reviewed oldest first in chunks, so an early correction is never skipped", async () => {
    const conversationId = "learn-backlog";
    const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`acme/second/${conversationId}`));
    const texts = await runInDurableObject(stub, async (instance, state) => {
      const store = new Store(state.storage);
      store.bind("acme", "second", "person-4");
      // An early correction, then far more than one review's worth of chatter (as after a day of failed reviews).
      store.append({ role: "user", content: "Send invoices to Casey in accounting." });
      for (let i = 0; i < 120; i++) store.append({ role: i % 2 ? "assistant" : "user", content: `Chatter line ${i}.` });
      store.setMeta("conversation", conversationId);
      store.setMeta("turnsSinceReview", "1");
      instance.model = {
        async turn(request: ModelTurnRequest) {
          if (request.messages.some(m => m.role === "tool")) return { content: "", toolCalls: [call("d", "review_done", {})], usage };
          return String(request.messages[1].content).includes("Casey")
            ? { content: "", toolCalls: [call("p", "lesson_propose", { text: "Send invoices to Casey in accounting.", kind: "fact", scope: "this_agent", evidence: "Send invoices to Casey in accounting." })], usage }
            : { content: "", toolCalls: [call("d", "review_done", {})], usage };
        },
      } satisfies ModelAdapter;
      await instance.alarm();
      await instance.alarm();
      return { lessons: (await learning("acme").list("second")).map(l => l.text), reviewedTo: Number(store.meta("reviewedSeq")), queued: store.meta("turnsSinceReview") };
    });
    expect(texts.lessons).toContain("Send invoices to Casey in accounting.");
    // Two chunks of at most 80 lines cover all 121, and nothing stays queued.
    expect(texts.reviewedTo).toBe(121);
    expect(texts.queued).toBe("0");
  });
});

describe("verify after write", () => {
  it("marks a write uncertain when the read-back finds nothing, so it is never reported done", async () => {
    let created = false;
    const tool: ToolDefinition = {
      name: "test_create", description: "x", parameters: { type: "object", properties: {} }, permission: "dashboard.write", effect: "write",
      parallelSafe: false, timeoutMs: 5_000, verifyAfterWrite: true,
      async execute() { return { data: { created: true } }; },
      async reconcile() { return created ? { status: "succeeded", result: { data: {} } } : { status: "absent" }; },
    };
    // One conversation per case: an uncertain write blocks further calls to that tool in its conversation.
    const statusOf = (conversationId: string) => runInDurableObject(env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`acme/second/${conversationId}`)), async (_instance, state) => {
      const store = new Store(state.storage);
      store.bind("acme", "second");
      let step = 0;
      const model: ModelAdapter = { async turn() { step++; return step === 1 ? { content: "", toolCalls: [call("t1", "test_create", {})], usage } : { content: "Done.", toolCalls: [], usage }; } };
      const agent = { ...AGENTS.second, tools: ["test_create"] };
      await runTurn({ store, model, client: CLIENTS.find(c => c.id === "acme")!, agent, catalog: { test_create: tool }, conversationId, bindings: env, desk: testDeskApi(), modelKey: () => "k", emit: () => {} }, { id: "m1", text: "create it" });
      return store.action("t1")!.status;
    });
    expect(await statusOf("verify-absent")).toBe("uncertain");
    created = true;
    expect(await statusOf("verify-found")).toBe("succeeded");
  });
});
