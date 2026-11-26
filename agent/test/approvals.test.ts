import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENTS } from "../agents";
import { CLIENTS } from "../clients";
import type { Conversation } from "../src/conversation";
import type { ToolDefinition } from "../src/contracts";
import { Dashboard, type Approval } from "../src/dashboard";
import { ModelProtocolError } from "../src/errors";
import { runTurn } from "../src/loop";
import type { ModelAdapter } from "../src/model";
import { Store } from "../src/store";
import { signUserPass } from "../src/user-auth";
import { allowApprover, APPROVER } from "./access";
import { TOOLS } from "../tools";
import { testDeskApi } from "./desk";

const auth = { authorization: "Bearer test-token-acme-0123456789abcdef", "content-type": "application/json" };
const usage = { inputTokens: 5, outputTokens: 2 };

/** A write tool that needs approval; each real run leaves a marker in R2, so runs can be counted. */
const publish: ToolDefinition = {
  // A permission Acme Test Co really has, so the decision (which uses the real client config) may run it.
  name: "test_publish", description: "Publish a post.", permission: "dashboard.write", effect: "write", parallelSafe: false, timeoutMs: 5_000,
  parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false },
  approval: (_context, args) => ({ title: `Publish "${args.title}"`, summary: "A new post.", preview: { title: args.title } }),
  async execute(context, args) {
    await context.bindings.IMAGES.put(`test-runs/${context.actionId}/${crypto.randomUUID()}`, "1");
    return { data: { published: args.title } };
  },
};
// Same tool behind a permission Acme Test Co's real config does not have: to test a permission lost after proposing.
const publishRevoked: ToolDefinition = { ...publish, name: "test_publish_revoked", permission: "test.revoked" };
const publishChoices: ToolDefinition = {
  ...publish, name: "test_publish_choices",
  approval: () => ({ title: "Pick a title", summary: "Only the chosen title is published.", choices: [
    { id: "first", label: "First", detail: "$10 a year", note: "Helper's pick", args: { title: "Chosen first" } },
    { id: "second", label: "Second", detail: "$12 a year", args: { title: "Chosen second" } },
  ], defaultChoice: "first" }),
};
const sizedChoices = Object.fromEntries([1, 2, 5, 6].map(count => [`test_choices_${count}`, {
  ...publish, name: `test_choices_${count}`,
  approval: () => ({ title: "Choose", summary: "Choose one.", choices: Array.from({ length: count }, (_, i) => ({ id: String(i), label: `Option ${i}`, args: { title: `Choice ${i}` } })) }),
} satisfies ToolDefinition]));
const catalog = { ...TOOLS, ...sizedChoices, test_publish: publish, test_publish_revoked: publishRevoked, test_publish_choices: publishChoices };

async function runs(actionId: string) {
  return (await env.IMAGES.list({ prefix: `test-runs/${actionId}/` })).objects.length;
}

/** Has Helper (with a test tool) propose a publish in a fresh conversation; returns the approval id. */
async function propose(conversationId: string, title: string, tool = "test_publish", userId: string | null = APPROVER, source: Approval["source"] = "app"): Promise<{ id: string; toolResult: string }> {
  const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`acme/helper/${conversationId}`));
  return runInDurableObject(stub, async (instance, state) => {
    instance.catalog = catalog;
    let step = 0, toolResult = "";
    const model: ModelAdapter = {
      async turn(request) {
        if (step++ === 0) return { content: "", toolCalls: [{ id: `call-${conversationId}`, type: "function", function: { name: tool, arguments: JSON.stringify({ title }) } }], usage };
        toolResult = String(request.messages.at(-1)?.content);
        return { content: "It's waiting for approval.", toolCalls: [], usage };
      },
    };
    instance.model = model;
    const store = new Store(state.storage);
    store.bind("acme", "helper", userId ?? undefined);
    // The proposing turn may use the tool; a decision later uses Acme Test Co's real config.
    const client = { ...CLIENTS.find(c => c.id === "acme")!, permissions: [...CLIENTS.find(c => c.id === "acme")!.permissions, publishRevoked.permission] };
    await runTurn({
      store, model, client, agent: { ...AGENTS.helper, tools: [...AGENTS.helper.tools, tool] }, catalog, conversationId,
      userId: userId ?? undefined, source, bindings: env, desk: testDeskApi(), modelKey: () => "key", emit: () => {},
    }, { id: "m1", text: "publish it" });
    return { id: `call-${conversationId}`, toolResult };
  });
}

const APPROVER_KEY = "test-approver-key-acme-0123456789abcdef";
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
beforeEach(async () => { await allowApprover(); });
const approverPass = (who = APPROVER, key = APPROVER_KEY, purpose = "approve") => signUserPass(key, "acme", who, inAnHour(), purpose);
const adminPass = () => signUserPass(APPROVER_KEY, "acme", "app-admin", inAnHour(), "admin");

const decide = async (id: string, decision: string, reason = "", pass?: string | null) =>
  SELF.fetch(`https://brain/v1/approvals/${id}`, {
    method: "POST",
    headers: { ...auth, ...(pass === null ? {} : pass === undefined ? { "x-admin-pass": await adminPass() } : { "x-approver-pass": pass }) },
    body: JSON.stringify({ decision, reason }),
  });

describe("approvals", () => {
  it.each([1, 2, 5, 6])("accepts only two to five choices: %i", async count => {
    const { id, toolResult } = await propose(`choice-count-${count}`, "Original", `test_choices_${count}`);
    const card = await env.DASHBOARD.get(env.DASHBOARD.idFromName("acme")).approvalJson(id);
    if (count === 2 || count === 5) {
      expect(JSON.parse(card!).choices).toHaveLength(count);
      expect(toolResult).toContain("awaitingApproval");
    } else {
      expect(card).toBeUndefined();
      expect(toolResult).toContain("two to five");
    }
    expect(await runs(id)).toBe(0);
  });
  it.each([true, false])("refuses a Slack choice-card press and directs the person to the app: approve=%s", async approve => {
    const conversationId = `slack-choices-${approve}`;
    const { id } = await propose(conversationId, "Original", "test_publish_choices");
    const sent: unknown[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    });
    try {
      await runInDurableObject(env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`acme/helper/${conversationId}`)), async (instance, state) => {
        const store = new Store(state.storage);
        await instance.queueSlackDecision("acme", "helper", { id, approve, decidedBy: "person", name: "Person", title: "Pick a title", responseUrl: "https://hooks.slack.com/actions/test", blocks: [] });
        // Test seam: exercise the queued alarm handler without running unrelated alarm work.
        const handler = instance as unknown as { runSlackDecisions(store: Store): Promise<void> };
        await handler.runSlackDecisions(store);
      });
      expect(sent).toContainEqual(expect.objectContaining({ text: expect.stringContaining("Open the app") }));
      expect(JSON.parse((await env.DASHBOARD.get(env.DASHBOARD.idFromName("acme")).approvalJson(id))!)).toMatchObject({ status: "pending" });
      expect(await runs(id)).toBe(0);
    } finally { fetchMock.mockRestore(); }
  });
  it.each([true, false])("refuses a legacy Go live card in Slack even without choices: approve=%s", async approve => {
    const conversationId = `slack-legacy-go-live-${approve}`;
    const id = `legacy-go-live-${approve}`;
    const dashboard = env.DASHBOARD.get(env.DASHBOARD.idFromName("acme"));
    await dashboard.propose({ id, agent: "helper", conversationId, tool: "propose_go_live", title: "Go live: Acme", summary: "Legacy one-domain card", previewJson: "{}" });
    const sent: unknown[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    });
    try {
      await runInDurableObject(env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`acme/helper/${conversationId}`)), async (instance, state) => {
        const store = new Store(state.storage);
        store.bind("acme", "helper");
        await instance.queueSlackDecision("acme", "helper", { id, approve, decidedBy: "person", name: "Person", title: "Go live: Acme", responseUrl: "https://hooks.slack.com/actions/test", blocks: [] });
        // Test seam: drive only the queued decision handler.
        const handler = instance as unknown as { runSlackDecisions(store: Store): Promise<void> };
        await handler.runSlackDecisions(store);
      });
      expect(sent).toContainEqual(expect.objectContaining({ text: expect.stringContaining("Open the app") }));
      expect(JSON.parse((await dashboard.approvalJson(id))!)).toMatchObject({ status: "pending" });
      expect(await runs(id)).toBe(0);
    } finally { fetchMock.mockRestore(); }
  });
  it("files a proposal instead of running the tool, and lists it as pending", async () => {
    const { id, toolResult } = await propose("appr-1", "Spring sale");
    expect(await runs(id)).toBe(0);
    expect(toolResult).toContain("awaitingApproval");
    const response = await SELF.fetch("https://brain/v1/approvals?status=pending", { headers: auth });
    expect(response.status).toBe(200);
    const pending = await response.json() as { approvals: Approval[] };
    expect(pending.approvals.find(a => a.id === id)).toMatchObject({ title: 'Publish "Spring sale"', preview: { title: "Spring sale" } });
  });

  it("runs an approved action exactly once, even when approved twice, and refuses a later decline", async () => {
    const { id } = await propose("appr-2", "Summer menu");
    const first = await decide(id, "approve");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: "done", decidedBy: "app-admin", requestedBy: APPROVER, source: "app" });
    expect((await decide(id, "approve")).status).toBe(200);
    expect(await runs(id)).toBe(1);
    expect((await decide(id, "decline")).status).toBe(409);
    expect(await runs(id)).toBe(1);
  });

  it("accepts only one of two concurrent opposite decisions", async () => {
    const { id } = await propose("approval-race", "Homepage description");
    const [approve, decline] = await Promise.all([decide(id, "approve"), decide(id, "decline")]);
    expect([approve.status, decline.status].sort()).toEqual([200, 409]);
    const approved = approve.status === 200;
    const winner = approved ? approve : decline;
    expect(await winner.json()).toMatchObject({ status: approved ? "done" : "declined" });
    expect((await decide(id, approved ? "approve" : "decline")).status).toBe(200);
    expect(await runs(id)).toBe(approved ? 1 : 0);
  });

  it("never runs a declined action, tells the agent, and refuses a later approve", async () => {
    const { id } = await propose("appr-3", "Off-brand post");
    const declined = await decide(id, "decline", "wrong tone");
    expect(declined.status).toBe(200);
    expect(await declined.json()).toMatchObject({ status: "declined", reason: "wrong tone" });
    expect((await decide(id, "approve")).status).toBe(409);
    expect(await runs(id)).toBe(0);

    const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName("acme/helper/appr-3"));
    const note = await runInDurableObject(stub, (_i, state) => new Store(state.storage).messages().map(r => r.message).at(-1));
    expect(note).toMatchObject({ role: "user", content: expect.stringContaining("declined: wrong tone") });
  });

  it("refuses a decision without a valid approver pass, whatever the client token", async () => {
    const { id } = await propose("appr-4", "Unapproved");
    expect((await decide(id, "approve", "", null)).status).toBe(401); // client token only
    expect((await decide(id, "approve", "", "robin.9999999999.00")).status).toBe(401); // malformed
    expect((await decide(id, "approve", "", await approverPass(APPROVER, "x".repeat(40)))).status).toBe(401); // wrong key
    expect((await decide(id, "approve", "", await approverPass(APPROVER, APPROVER_KEY, ""))).status).toBe(401); // a memory-style pass
    expect((await decide(id, "approve", "", await approverPass("mallory"))).status).toBe(403); // not on the approvers list
    expect(await runs(id)).toBe(0);
    const response = await SELF.fetch(`https://brain/v1/approvals/${id}`, { headers: auth });
    expect(response.status).toBe(200);
    const still = await response.json();
    expect(still).toMatchObject({ status: "pending" });
  });

  it("does not run an approved action whose permission the client no longer has", async () => {
    const { id } = await propose("appr-5", "Lost permission", "test_publish_revoked");
    const response = await decide(id, "approve");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "failed" });
    expect(await runs(id)).toBe(0);
  });

  it("returns 404 for an unknown approval and 400 for a decision that is neither approve nor decline", async () => {
    expect((await SELF.fetch("https://brain/v1/approvals/not-a-real-id", { headers: auth })).status).toBe(404);
    expect((await decide("anything", "maybe")).status).toBe(400);
  });
});

describe("continuing after an approval", () => {
  /** Swaps in a model that records the last message it was shown and answers; returns those records. */
  async function watch(conversationId: string): Promise<string[]> {
    const seen: string[] = [];
    await runInDurableObject(env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`acme/helper/${conversationId}`)), instance => {
      instance.model = { async turn(request) { seen.push(String(request.messages.at(-1)?.content)); request.onText?.("Carrying on."); return { content: "Carrying on.", toolCalls: [], usage }; } };
    });
    return seen;
  }
  const inside = <T>(conversationId: string, fn: (instance: Conversation, store: Store) => Promise<T> | T) =>
    runInDurableObject(env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`acme/helper/${conversationId}`)), (instance, state) => fn(instance, new Store(state.storage)));
  /** Waits for everything queued in the conversation, follow-up included. */
  const settle = (conversationId: string) => inside(conversationId, instance => (instance as unknown as { queue: Promise<unknown> }).queue);

  it("runs exactly one follow-up turn after an approval, shown in history as the agent's reply only", async () => {
    const { id } = await propose("cont-1", "Spring sale");
    const seen = await watch("cont-1");
    expect((await decide(id, "approve")).status).toBe(200);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await settle("cont-1");
    expect(seen[0]).toContain("test_publish (call-cont-1): A person approved it and it went through");
    expect(seen[0]).toContain("Continue with the next step");

    const { lines, input } = await inside("cont-1", (_i, store) => ({ lines: store.transcript(50).lines, input: store.input(`approved-${id}`) }));
    expect(lines.map(l => [l.role, l.text])).toEqual([["user", "publish it"], ["assistant", "It's waiting for approval."], ["assistant", "Carrying on."]]);
    expect(input?.reply).toBe("Carrying on.");
  });

  it("tells the person in the chat when the follow-up turn fails, instead of leaving them waiting", async () => {
    const { id } = await propose("cont-6", "Autumn menu");
    await runInDurableObject(env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName("acme/helper/cont-6")), instance => {
      instance.model = { async turn() { throw new ModelProtocolError("The model reply was cut off by its output limit."); } };
    });
    expect((await decide(id, "approve")).status).toBe(200);
    await vi.waitFor(async () => {
      await settle("cont-6");
      const lines = await inside("cont-6", (_i, store) => store.transcript(50).lines);
      expect(lines.at(-1)).toMatchObject({ role: "assistant", text: "I hit a problem: The model reply was cut off by its output limit. Ask me to try again." });
    });
  });

  it("does not start a second turn when the same approval reaches the conversation again", async () => {
    const { id } = await propose("cont-2", "Summer menu");
    const seen = await watch("cont-2");
    await decide(id, "approve");
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await settle("cont-2");
    await inside("cont-2", async instance => { for (let i = 0; i < 2; i++) await instance.decide("acme", "helper", "cont-2", id, true, ""); });
    await settle("cont-2");
    expect(seen).toHaveLength(1);
    expect(await runs(id)).toBe(1);
  });

  it("does not continue when the approved action failed", async () => {
    const { id } = await propose("cont-3", "Lost permission", "test_publish_revoked");
    const seen = await watch("cont-3");
    const response = await decide(id, "approve");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "failed" });
    // Give a wrongly started follow-up time to reach the queue, then let it finish.
    await new Promise(resolve => setTimeout(resolve, 300));
    await settle("cont-3");
    expect(seen).toHaveLength(0);
    expect(await inside("cont-3", (_i, store) => store.input(`approved-${id}`))).toBeUndefined();
  });

  it("runs nothing after a decline, a stale approval or an unknown action", async () => {
    const declined = await propose("cont-4", "Off-brand post");
    const seenDeclined = await watch("cont-4");
    // No reason: a reason would start a lesson review, which is a model call of its own.
    await decide(declined.id, "decline");
    await settle("cont-4");
    expect(seenDeclined).toHaveLength(0);
    expect(await inside("cont-4", (_i, store) => store.input(`approved-${declined.id}`))).toBeUndefined();

    const stale = await propose("cont-5", "Changed settings");
    const seenStale = await watch("cont-5");
    const outcomes = await inside("cont-5", async instance => [
      (await instance.decide("acme", "helper", "cont-5", stale.id, true, "", "not-the-current-fingerprint")).status,
      (await instance.decide("acme", "helper", "cont-5", "no-such-action", true, "")).status,
    ]);
    await settle("cont-5");
    expect(outcomes).toEqual(["stale", "missing"]);
    expect(seenStale).toHaveLength(0);
    expect(await runs(stale.id)).toBe(0);
  });
});

describe("approval requesters and sources", () => {
  const dashboard = () => env.DASHBOARD.get(env.DASHBOARD.idFromName("acme"));
  const refusal = { error: "Only the person who asked, or an admin, can decide this request." };

  it.each([
    ["web-not-the-bound-person", "app", APPROVER],
    ["phone-request-origin", "phone", null],
    ["slack-request-origin", "slack", null],
    ["job-request-origin", "scheduled", null],
    ["test-request-origin", "other", null],
  ] as const)("stores the trusted ingress origin for %s", async (cid, source, requestedBy) => {
    const { id } = await propose(cid, "Origin", publish.name, requestedBy, source);
    const stored = await runInDurableObject(dashboard(), (_instance, state) =>
      state.storage.sql.exec("SELECT requested_by, source FROM approvals WHERE id = ?", id).one());
    expect(stored).toEqual({ requested_by: requestedBy, source });
    const one = await SELF.fetch(`https://brain/v1/approvals/${id}`, { headers: auth });
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ id, source, requestedBy });
    const list = await SELF.fetch("https://brain/v1/approvals?status=pending", { headers: auth });
    expect(list.status).toBe(200);
    expect((await list.json() as { approvals: Approval[] }).approvals).toContainEqual(expect.objectContaining({ id, source, requestedBy }));
    await dashboard().propose({ id, agent: "helper", conversationId: "web-someone-else", requestedBy: "someone-else", source: "app", tool: publish.name, title: "Changed", summary: "", previewJson: "{}" });
    expect(JSON.parse((await dashboard().approvalJson(id))!)).toMatchObject({ source, requestedBy });
  });

  it("keeps a new unbound app proposal anonymous instead of trusting its conversation id", async () => {
    const { id } = await propose("web-not-a-proven-person", "Anonymous", publish.name, null);
    expect(JSON.parse((await dashboard().approvalJson(id))!)).toMatchObject({ requestedBy: null, source: "app" });
    const response = await decide(id, "approve", "", await approverPass());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(refusal);
    expect(await runs(id)).toBe(0);
  });

  it("adds nullable columns to an old table and resolves old requesters from bound chats", async () => {
    const legacy = env.DASHBOARD.get(env.DASHBOARD.newUniqueId());
    await runInDurableObject(env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName("acme/helper/web-old-person")), (_instance, state) => {
      new Store(state.storage).bind("acme", "helper", "old-person");
    });
    const records = await runInDurableObject(legacy, async (_instance, state) => {
      state.storage.sql.exec("ALTER TABLE approvals DROP COLUMN requested_by");
      state.storage.sql.exec("ALTER TABLE approvals DROP COLUMN source");
      for (const cid of ["web-old-person", "phone-old", "slack-old", "job-old", "test-old"]) {
        state.storage.sql.exec("INSERT INTO approvals (id, agent, conversation_id, tool, title, summary, preview, status, created_at) VALUES (?, 'helper', ?, 'test_publish', 'Old', '', '{}', 'pending', 1)", cid, cid);
      }
      const migrated = new Dashboard(state, env);
      expect(state.storage.sql.exec("SELECT requested_by, source FROM approvals WHERE id = 'web-old-person'").one()).toEqual({ requested_by: null, source: null });
      return JSON.parse(await migrated.approvals(undefined, "acme")).approvals as Approval[];
    });
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "web-old-person", requestedBy: "old-person", source: "app" }),
      expect.objectContaining({ id: "phone-old", requestedBy: null, source: "phone" }),
      expect.objectContaining({ id: "slack-old", requestedBy: null, source: "slack" }),
      expect.objectContaining({ id: "job-old", requestedBy: null, source: "scheduled" }),
      expect.objectContaining({ id: "test-old", requestedBy: null, source: "other" }),
    ]));
  });

  it("lets the requester with approve rights decide once, returning the stored outcome on repeats", async () => {
    const { id } = await propose("web-requester-decision", "Requested");
    const pass = await approverPass();
    const first = await decide(id, "approve", "", pass);
    expect(first.status).toBe(200);
    const outcome = await first.json();
    expect(outcome).toMatchObject({ status: "done", decidedBy: APPROVER, requestedBy: APPROVER, source: "app" });
    const repeat = await decide(id, "approve", "", pass);
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual(outcome);
    expect((await decide(id, "decline", "", pass)).status).toBe(409);
    expect(await runs(id)).toBe(1);
  });

  it("refuses another approver of the same agent without changing the request, card, action or chat", async () => {
    const { id } = await propose("web-other-approver", "Private request");
    await dashboard().setApprovers(Number.MAX_SAFE_INTEGER, { helper: [APPROVER, "other-approver"] }, {});
    const before = await dashboard().approvalJson(id);
    const cards = await dashboard().list(200);
    const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName("acme/helper/web-other-approver"));
    const snapshot = () => runInDurableObject(stub, (_instance, state) => {
      const store = new Store(state.storage);
      return { messages: store.messages(), action: store.action(id) };
    });
    const chat = await snapshot();
    for (const decision of ["approve", "decline", "revise"]) {
      const response = await decide(id, decision, "", await approverPass("other-approver"));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual(refusal);
    }
    expect(await dashboard().approvalJson(id)).toBe(before);
    expect(await dashboard().list(200)).toBe(cards);
    expect(await snapshot()).toEqual(chat);
    expect(await runs(id)).toBe(0);
  });

  it("refuses the requester without this agent's approve right", async () => {
    const { id } = await propose("web-requester-without-right", "No right");
    await allowApprover(APPROVER, ["second"]);
    const response = await decide(id, "approve", "", await approverPass());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(refusal);
    expect(JSON.parse((await dashboard().approvalJson(id))!)).toMatchObject({ status: "pending" });
    expect(await runs(id)).toBe(0);
  });

  it.each(["phone-admin-only", "slack-admin-only", "job-admin-only", "test-admin-only"])("refuses every approver pass for an anonymous %s request but lets an admin decide", async cid => {
    const { id } = await propose(cid, "Admin only", publish.name, null, "other");
    await dashboard().setApprovers(Number.MAX_SAFE_INTEGER, { helper: [APPROVER, "other-approver"] }, {});
    for (const who of [APPROVER, "other-approver", "app-admin"]) {
      const response = await decide(id, "decline", "", await approverPass(who));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual(refusal);
    }
    expect(JSON.parse((await dashboard().approvalJson(id))!).status).toBe("pending");
    const response = await decide(id, "approve");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ requestedBy: null, status: "done", decidedBy: "app-admin" });
    expect(await runs(id)).toBe(1);
  });

  it("lets an admin decide someone else's app request without per-agent rights", async () => {
    const { id } = await propose("web-admin-decides", "For admin");
    await dashboard().setApprovers(Number.MAX_SAFE_INTEGER, {}, {});
    const response = await decide(id, "decline");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "declined", requestedBy: APPROVER, source: "app", decidedBy: "app-admin" });
    expect((await decide(id, "decline")).status).toBe(200);
    expect((await decide(id, "approve")).status).toBe(409);
  });
});
