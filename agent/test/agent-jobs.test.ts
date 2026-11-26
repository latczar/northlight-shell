import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENTS } from "../agents";
import { CLIENTS } from "../clients";
import type { Conversation } from "../src/conversation";
import type { ToolCall, ToolDefinition } from "../src/contracts";
import { applyProgress, humanize, JOB_ACTIVE_MESSAGE, JOB_MAX_MS, jobView, loadJob, loadQueue, newJob, saveJob, type Job, type JobView } from "../src/jobs";
import { runTurn } from "../src/loop";
import type { ModelAdapter } from "../src/model";
import { Store } from "../src/store";
import { signUserPass } from "../src/user-auth";
import { allowApprover } from "./access";
import { TOOLS } from "../tools";
import { noDesk } from "./desk";

const auth = { authorization: "Bearer test-token-acme-0123456789abcdef", "content-type": "application/json" };
const USER_KEY = "test-signing-key-acme-0123456789abcdef";
const APPROVER_KEY = "test-approver-key-acme-0123456789abcdef";
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
const userPass = (who = "person-1") => signUserPass(USER_KEY, "acme", who, inAnHour());
const approverPass = () => signUserPass(APPROVER_KEY, "acme", "person-1", inAnHour(), "approve");
beforeEach(async () => { await allowApprover("person-1"); });
const usage = { inputTokens: 5, outputTokens: 2 };

const toolCall = (id: string, name: string, args: object): ToolCall => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const progress = (id: string, args: object) => toolCall(id, "update_progress", args);
const direction = { business: "Acme", concept: "A warm bakery", mood: "Morning light", signature: "Rising bread", pages: ["Home"], brand: {
  mode: "own", source: "https://bakery.example/", logo: "https://bakery.example/logo.svg",
  colors: [{ role: "primary", hex: "#123456" }, { role: "background", hex: "#ffffff" }],
  fonts: {
    heading: { name: "Inter", stylesheet: "https://fonts.googleapis.com/css2?family=Inter", kind: "free-web-font" },
    body: { name: "Inter", stylesheet: "https://fonts.googleapis.com/css2?family=Inter", kind: "free-web-font" },
  },
} };

interface Step { text?: string; calls?: ToolCall[] }
/** A model that plays `steps` in order (the last one repeats) and records the last message of every request. */
function scripted(steps: Step[], seen: string[]): ModelAdapter {
  let i = 0;
  return {
    async turn(request) {
      seen.push(String(request.messages.at(-1)?.content));
      const step = steps[Math.min(i++, steps.length - 1)];
      if (step.text) request.onText?.(step.text);
      return { content: step.text ?? "", toolCalls: step.calls ?? [], usage };
    },
  };
}

const inside = <T>(cid: string, fn: (instance: Conversation, store: Store, state: DurableObjectState) => Promise<T> | T) =>
  runInDurableObject(env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`acme/helper/${cid}`)), (instance, state) => fn(instance, new Store(state.storage), state));
const view = (cid: string) => inside(cid, (_i, store): JobView | undefined => { const job = loadJob(store); return job ? jobView(job, loadQueue(store).length) : undefined; });
const lines = (cid: string) => inside(cid, (_i, store) => store.transcript(50).lines.map(l => [l.role, l.text]));
/** Nothing waits for the real alarm in a finished test. */
const quiet = (cid: string) => inside(cid, (_i, _s, state) => state.storage.deleteAlarm());
/** Drives the alarm by hand until the job reaches `status` (the real alarm may get there first; the two never run together). Idle polls do not touch the alarm, so no review runs early. */
const until = (cid: string, status: string) => vi.waitFor(async () => {
  if ((await view(cid))?.status !== status) await inside(cid, instance => instance.alarm());
  expect((await view(cid))?.status).toBe(status);
}, { timeout: 8_000, interval: 40 });

/** Starts a job the way the route does, with a scripted model. */
async function begin(cid: string, steps: Step[], input = { id: "m1", text: "Change the hero" }) {
  const seen: string[] = [];
  await inside(cid, instance => { instance.model = scripted(steps, seen); });
  const started = await inside(cid, instance => instance.startJob({ clientId: "acme", agentId: "helper", conversationId: cid, userId: "person-1", input }));
  return { started, seen };
}

/** A job saved by hand, not armed: the test drives it with alarm(). */
const seed = (cid: string, steps: Step[], make: (store: Store) => Job) => {
  const seen: string[] = [];
  return inside(cid, (instance, store) => {
    instance.model = scripted(steps, seen);
    store.bind("acme", "helper", "person-1");
    store.setMeta("conversation", cid);
    saveJob(store, make(store));
    return seen;
  });
};

const decide = async (id: string, decision: "approve" | "decline") =>
  SELF.fetch(`https://brain/v1/approvals/${id}`, { method: "POST", headers: { ...auth, "x-approver-pass": await approverPass() }, body: JSON.stringify({ decision }) });

describe("background jobs", () => {
  it("runs from the alarm to done over the routes: progress, the agent's reply in the chat, no request held open", async () => {
    const cid = "jobs-route-1";
    await inside(cid, instance => {
      instance.model = scripted([
        { calls: [progress("p1", { steps: ["Look at the site", "Change the hero", "Check it opens"], done: 0, current: "Looking at the site" }), toolCall("t1", "current_time", { timezone: "America/Chicago" })] },
        { calls: [progress("p2", { done: 2 })] },
        { text: "The hero is changed." },
      ], []);
    });
    const headers = { ...auth, "x-user-pass": await userPass() };
    const start = await SELF.fetch(`https://brain/v1/agents/helper/conversations/${cid}/jobs`, { method: "POST", headers, body: JSON.stringify({ id: "m1", text: "Change the hero" }) });
    expect(start.status).toBe(202);
    const body = await start.json() as { job: JobView; queued?: boolean };
    expect(body.job).toMatchObject({ id: "m1", status: "running", queued: 0, steps: [], current: null });
    expect(body).not.toHaveProperty("queued");

    await vi.waitFor(async () => {
      const got = await (await SELF.fetch(`https://brain/v1/agents/helper/conversations/${cid}/job`, { headers })).json() as { job: JobView };
      expect(got.job.status).toBe("done");
    }, { timeout: 8_000, interval: 50 });
    const done = (await (await SELF.fetch(`https://brain/v1/agents/helper/conversations/${cid}/job`, { headers })).json() as { job: JobView }).job;
    expect(Object.keys(done).sort()).toEqual(["current", "finishedAt", "id", "queued", "startedAt", "status", "steps", "updatedAt"]);
    expect(done.steps).toEqual([{ label: "Look at the site", state: "done" }, { label: "Change the hero", state: "done" }, { label: "Check it opens", state: "done" }]);
    expect(done.current).toBeNull();
    expect(done.finishedAt).toBeGreaterThanOrEqual(done.startedAt);
    const messages = await (await SELF.fetch(`https://brain/v1/agents/helper/conversations/${cid}/messages`, { headers })).json() as { messages: { role: string; text: string }[] };
    expect(messages.messages.map(m => [m.role, m.text])).toEqual([["user", "Change the hero"], ["assistant", "The hero is changed."]]);
    await quiet(cid);
  });

  it("starts nothing twice for one message id, and answers 202 with the same job", async () => {
    const cid = "jobs-dedupe-1";
    const { started, seen } = await begin(cid, [{ text: "Done." }]);
    expect(started).toMatchObject({ job: { id: "m1" } });
    const again = await inside(cid, instance => instance.startJob({ clientId: "acme", agentId: "helper", conversationId: cid, userId: "person-1", input: { id: "m1", text: "Change the hero" } }));
    expect(again.job.id).toBe("m1");
    expect(again.queued).toBeUndefined();
    await until(cid, "done");
    const after = await inside(cid, instance => instance.startJob({ clientId: "acme", agentId: "helper", conversationId: cid, userId: "person-1", input: { id: "m1", text: "Change the hero" } }));
    expect(after.job).toMatchObject({ id: "m1", status: "done" });
    expect(seen).toHaveLength(1);
    await quiet(cid);
  });

  it("check_back_in ends the segment, shows the wait, and resumes with a runtime note once it is due", async () => {
    const cid = "jobs-wait-1";
    const { seen } = await begin(cid, [
      { calls: [progress("p1", { steps: ["Save the code", "Build a preview", "Show it"], done: 1, current: "Waiting for the build" }), toolCall("w1", "check_back_in", { seconds: 30, reason: "see if the preview is READY" })] },
      { text: "The preview is ready." },
    ]);
    await until(cid, "waiting");
    expect(await view(cid)).toMatchObject({
      status: "waiting", current: "Waiting for the build",
      steps: [{ label: "Save the code", state: "done" }, { label: "Build a preview", state: "active" }, { label: "Show it", state: "pending" }],
    });
    // Not due yet: nothing runs.
    await inside(cid, instance => instance.alarm());
    expect(seen).toHaveLength(1);

    await inside(cid, (instance, store) => {
      const job = loadJob(store)!;
      expect(job.dueAt).toBeGreaterThan(Date.now() + 20_000);
      saveJob(store, { ...job, dueAt: Date.now() - 1 });
      return instance.alarm();
    });
    await until(cid, "done");
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain("Time to check back: see if the preview is READY");
    expect(await lines(cid)).toEqual([["user", "Change the hero"], ["assistant", "The preview is ready."]]);
    await quiet(cid);
  });

  it("waits for a person's approval, then the approval resumes the same job", async () => {
    const cid = "web-jobs-approve-1";
    const { seen } = await begin(cid, [
      { calls: [progress("p1", { steps: ["Pitch the design", "Build it"] }), toolCall("dir-approve-1", "approve_record", direction)] },
      { text: "The direction is waiting for your approval." },
      { text: "Approved, I'm starting the build." },
    ]);
    await until(cid, "needs_approval");
    expect(await view(cid)).toMatchObject({ status: "needs_approval", steps: [{ state: "active" }, { state: "pending" }] });
    expect(seen).toHaveLength(2);

    expect((await decide("dir-approve-1", "approve")).status).toBe(200);
    await until(cid, "done");
    // A repeated approval resumes nothing a second time.
    expect((await decide("dir-approve-1", "approve")).status).toBe(200);
    await inside(cid, instance => instance.decide("acme", "helper", cid, "dir-approve-1", true, ""));
    await until(cid, "done");
    expect(seen).toHaveLength(3);
    expect(seen[2]).toContain("approve_record (dir-approve-1): A person approved it and it went through");
    expect((await lines(cid)).at(-1)).toEqual(["assistant", "Approved, I'm starting the build."]);
    await quiet(cid);
  });

  it("resumes the job after a decline too, so the agent can tell the person", async () => {
    const cid = "web-jobs-decline-1";
    const { seen } = await begin(cid, [
      { calls: [toolCall("dir-decline-1", "approve_record", direction)] },
      { text: "Waiting for approval." },
      { text: "Understood, no design for now." },
    ]);
    await until(cid, "needs_approval");
    expect((await decide("dir-decline-1", "decline")).status).toBe(200);
    await until(cid, "done");
    expect(seen.at(-1)).toContain("A person declined it");
    expect((await lines(cid)).at(-1)).toEqual(["assistant", "Understood, no design for now."]);
    await quiet(cid);
  });

  it("stops at 30 minutes with a clear line in the chat and no model call", async () => {
    const cid = "jobs-time-1";
    const seen = await seed(cid, [{ text: "never" }], store => ({ ...newJob({ id: "m1", text: "Go" }, store.spentUsd()), usedMs: JOB_MAX_MS }));
    await until(cid, "stopped");
    expect(await view(cid)).toMatchObject({ status: "stopped", error: expect.stringContaining("30-minute time limit") });
    expect((await lines(cid)).at(-1)).toEqual(["assistant", "I stopped this job because it reached its 30-minute time limit. Tell me how you'd like to continue."]);
    expect(seen).toEqual([]);
    await quiet(cid);
  });

  it("stops at Helper's $8 of job spend, before and during a segment", async () => {
    const before = "jobs-cost-1";
    const seenBefore = await seed(before, [{ text: "never" }], store => newJob({ id: "m1", text: "Go" }, store.spentUsd() - 8));
    await until(before, "stopped");
    expect((await lines(before)).at(-1)?.[1]).toContain("$8 spending limit");
    expect(seenBefore).toEqual([]);

    // A hair of allowance is left: the model call is refused before it is made.
    const during = "jobs-cost-2";
    const seenDuring = await seed(during, [{ text: "never" }], store => newJob({ id: "m1", text: "Go" }, store.spentUsd() - (8 - 1e-9)));
    await until(during, "stopped");
    expect(await view(during)).toMatchObject({ status: "stopped", error: expect.stringContaining("$8 spending limit") });
    expect((await lines(during)).at(-1)?.[1]).toContain("$8 spending limit");
    expect(seenDuring).toEqual([]);
    await Promise.all([quiet(before), quiet(during)]);
  });

  it("gives a job its own $8 even after the conversation has passed the $10 chat cap", async () => {
    const cid = "jobs-own-allowance";
    const seen = await seed(cid, [{ text: "Done." }], store => {
      store.reserve("earlier-work", 0, 0, 12, Date.now());
      return newJob({ id: "m1", text: "Go" }, store.spentUsd());
    });
    await until(cid, "done");
    expect(seen).toHaveLength(1);
    expect((await lines(cid)).at(-1)).toEqual(["assistant", "Done."]);
    await quiet(cid);
  });

  it("queues a message sent while a job runs, says so, and runs it after the job in order", async () => {
    const cid = "jobs-queue-1";
    const { seen } = await begin(cid, [
      { calls: [toolCall("w1", "check_back_in", { seconds: 30, reason: "build" })] },
      { text: "First done." },
      { text: "Second done." },
    ]);
    await until(cid, "waiting");
    const send = (id: string, text: string) => inside(cid, instance => instance.startJob({ clientId: "acme", agentId: "helper", conversationId: cid, userId: "person-1", input: { id, text } }));
    const queued = await send("m2", "Also change the footer");
    expect(queued).toMatchObject({ queued: true, job: { id: "m1", status: "waiting", queued: 1 } });
    // The same queued message again is not queued twice.
    expect(await send("m2", "Also change the footer")).toMatchObject({ queued: true, job: { queued: 1 } });
    expect(await send("m1", "Change the hero")).toMatchObject({ job: { id: "m1", queued: 1 } });

    await inside(cid, (instance, store) => { saveJob(store, { ...loadJob(store)!, dueAt: Date.now() - 1 }); return instance.alarm(); });
    await vi.waitFor(async () => {
      await inside(cid, instance => instance.alarm());
      expect(await view(cid)).toMatchObject({ id: "m2", status: "done", queued: 0 });
    }, { timeout: 8_000, interval: 40 });
    expect(await lines(cid)).toEqual([["user", "Change the hero"], ["assistant", "First done."], ["user", "Also change the footer"], ["assistant", "Second done."]]);
    expect(seen).toHaveLength(3);
    await quiet(cid);
  });

  it("refuses more than 10 waiting messages", async () => {
    const cid = "jobs-queue-2";
    await begin(cid, [{ calls: [toolCall("w1", "check_back_in", { seconds: 30, reason: "build" })] }]);
    await until(cid, "waiting");
    for (let i = 0; i < 10; i++) await inside(cid, instance => instance.startJob({ clientId: "acme", agentId: "helper", conversationId: cid, userId: "person-1", input: { id: `q${i}`, text: "more" } }));
    await expect(inside(cid, instance => instance.startJob({ clientId: "acme", agentId: "helper", conversationId: cid, userId: "person-1", input: { id: "q10", text: "more" } }))).rejects.toThrow("Too many messages");
    await quiet(cid);
  });

  it("picks up a segment a restart interrupted: the open tool call is answered, the message is not added twice", async () => {
    const cid = "jobs-crash-1";
    const seen = await seed(cid, [{ text: "Back after the restart." }], store => {
      const at = Date.now();
      const call = toolCall("c-crash", "current_time", { timezone: "America/Chicago" });
      store.addInput("m1", at);
      store.append({ role: "user", content: "Change the hero" });
      store.append({ role: "assistant", content: null, tool_calls: [call] });
      store.putAction({ id: "c-crash", tool: "current_time", args: { timezone: "America/Chicago" }, status: "running", attempts: 1, createdAt: at, updatedAt: at });
      return { ...newJob({ id: "m1", text: "Change the hero" }, 0, at), tool: "Checking the time", dueAt: at + 360_000 };
    });
    // The watchdog time has come and nothing is driving the job (a fresh object after the restart).
    await inside(cid, (instance, store) => { saveJob(store, { ...loadJob(store)!, dueAt: Date.now() - 1 }); return instance.alarm(); });
    await until(cid, "done");
    expect(seen).toHaveLength(1);
    const tool = await inside(cid, (_i, store) => store.messages().map(m => m.message).find(m => m.role === "tool"));
    expect(tool).toMatchObject({ tool_call_id: "c-crash", content: expect.stringContaining("Interrupted") });
    expect(await lines(cid)).toEqual([["user", "Change the hero"], ["assistant", "Back after the restart."]]);
    await quiet(cid);
  });

  it("fails with a plain line in the chat when the model errors, and the next message starts a fresh job", async () => {
    const cid = "jobs-fail-1";
    await inside(cid, instance => { instance.model = { async turn() { throw new Error("boom"); } }; });
    await inside(cid, instance => instance.startJob({ clientId: "acme", agentId: "helper", conversationId: cid, userId: "person-1", input: { id: "m1", text: "Go" } }));
    await until(cid, "failed");
    expect(await view(cid)).toMatchObject({ status: "failed", error: "I hit a problem: something went wrong. Ask me to try again." });
    expect((await lines(cid)).at(-1)).toEqual(["assistant", "I hit a problem: something went wrong. Ask me to try again."]);
    const seen: string[] = [];
    await inside(cid, instance => { instance.model = scripted([{ text: "Fine now." }], seen); });
    expect(await inside(cid, instance => instance.startJob({ clientId: "acme", agentId: "helper", conversationId: cid, userId: "person-1", input: { id: "m2", text: "Again" } }))).toMatchObject({ job: { id: "m2", status: "running" } });
    await until(cid, "done");
    await quiet(cid);
  });
});

describe("job routes", () => {
  const url = (cid: string, tail: string) => `https://brain/v1/agents/helper/conversations/${cid}/${tail}`;

  it("needs the client token and a user pass, and shows a job only to its person", async () => {
    const cid = "jobs-auth-1";
    expect((await SELF.fetch(url(cid, "job"))).status).toBe(401);
    expect((await SELF.fetch(url(cid, "job"), { headers: auth })).status).toBe(401); // no user pass
    expect((await SELF.fetch(url(cid, "jobs"), { method: "POST", headers: auth, body: JSON.stringify({ id: "m1", text: "hi" }) })).status).toBe(401);
    const mine = { ...auth, "x-user-pass": await userPass("person-1") };
    expect(await (await SELF.fetch(url(cid, "job"), { headers: mine })).json()).toEqual({ job: null });
    await inside(cid, instance => { instance.model = scripted([{ calls: [toolCall("w1", "check_back_in", { seconds: 30, reason: "x" })] }], []); });
    expect((await SELF.fetch(url(cid, "jobs"), { method: "POST", headers: mine, body: JSON.stringify({ id: "m1", text: "hi" }) })).status).toBe(202);
    const other = { ...auth, "x-user-pass": await userPass("person-2") };
    expect((await SELF.fetch(url(cid, "job"), { headers: other })).status).toBe(404);
    expect((await SELF.fetch(url(cid, "jobs"), { method: "POST", headers: other, body: JSON.stringify({ id: "m2", text: "hi" }) })).status).toBe(409);
    expect((await SELF.fetch(url(cid, "jobs"), { method: "POST", headers: mine, body: JSON.stringify({ text: "hi" }) })).status).toBe(400);
    expect((await SELF.fetch(url(cid, "jobs"), { method: "POST", headers: mine, body: JSON.stringify({ id: "m3", text: "  " }) })).status).toBe(400);
    expect((await SELF.fetch(url("x", "jobs"), { method: "GET", headers: mine })).status).toBe(404);
    await quiet(cid);
  });

  it("queued: true on the route while a job runs", async () => {
    const cid = "jobs-queue-route-1";
    await inside(cid, instance => { instance.model = scripted([{ calls: [toolCall("w1", "check_back_in", { seconds: 30, reason: "x" })] }], []); });
    const headers = { ...auth, "x-user-pass": await userPass() };
    await SELF.fetch(url(cid, "jobs"), { method: "POST", headers, body: JSON.stringify({ id: "m1", text: "one" }) });
    const second = await SELF.fetch(url(cid, "jobs"), { method: "POST", headers, body: JSON.stringify({ id: "m2", text: "two" }) });
    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({ queued: true, job: { id: "m1", queued: 1 } });
    await quiet(cid);
  });

  it("keeps typed messages and voice from running a second loop beside a job", async () => {
    const cid = "voice-person-1-jobs-busy-1";
    await begin(cid, [{ calls: [toolCall("w1", "check_back_in", { seconds: 30, reason: "build" })] }]);
    await until(cid, "waiting");
    const headers = { ...auth, "x-user-pass": await userPass() };
    const typed = await SELF.fetch(url(cid, "messages"), { method: "POST", headers, body: JSON.stringify({ id: "s1", text: "hello?", userAuth: await userPass() }) });
    expect(typed.status).toBe(409);
    expect(await typed.json()).toEqual({ error: JOB_ACTIVE_MESSAGE });
    const voice = await SELF.fetch("https://brain/v1/chat/completions", {
      method: "POST", headers: auth,
      body: JSON.stringify({ model: "helper", messages: [{ role: "user", content: "hello?" }], elevenlabs_extra_body: { conversation_id: cid, user_auth: await userPass() } }),
    });
    expect(voice.status).toBe(200);
    expect(await voice.text()).toContain("still working on your last request");
    expect((await lines(cid)).map(l => l[1])).toEqual(["Change the hero"]);
    await quiet(cid);
  });
});

describe("progress and labels", () => {
  it("keeps the agent's steps, clamps what it reports, and shows the tool's label until the agent names a step", () => {
    const job = newJob({ id: "m1", text: "x" }, 0);
    applyProgress(job, { steps: ["One", "Two", "Three"], done: 9 });
    expect(job.done).toBe(3);
    applyProgress(job, { done: 1, current: "Doing two" });
    expect(jobView(job, 0)).toMatchObject({ current: "Doing two", steps: [{ state: "done" }, { state: "active" }, { state: "pending" }] });
    applyProgress(job, { done: 2 });
    expect(job.current).toBeUndefined();
    job.tool = "Building a preview on Vercel";
    expect(jobView(job, 0).current).toBe("Building a preview on Vercel");
    expect(jobView({ ...job, status: "failed" }, 0).steps.map(s => s.state)).toEqual(["done", "done", "failed"]);
    expect(jobView({ ...job, status: "done" }, 0)).toMatchObject({ current: null, steps: [{ state: "done" }, { state: "done" }, { state: "done" }] });
  });

  it("gives every Iris tool and every shared tool a plain-words label; the rest fall back to the humanized name", () => {
    const irisAndShared = AGENTS.iris.tools.map(name => TOOLS[name]);
    expect(irisAndShared.length).toBeGreaterThan(5);
    for (const tool of irisAndShared) expect(tool.label?.length, tool.name).toBeGreaterThan(8);
    expect(TOOLS.review_site_page.label).toBe("Checking page metadata");
    expect(TOOLS.page_audit.label).toBe("Running a page audit");
    expect(humanize("github_push_files")).toBe("Github push files");
  });

  it("sets the job's current step to the running tool's label (or its humanized name) and clears it afterwards", async () => {
    const labels: (string | null)[] = [];
    const unlabeled: ToolDefinition = { ...TOOLS.current_time, name: "check_the_weather", label: undefined };
    const progressed: unknown[] = [];
    await inside("jobs-label-1", (_instance, store) => runTurn({
      store,
      model: scripted([
        { calls: [toolCall("a", "current_time", { timezone: "America/Chicago" })] },
        { calls: [progress("b", { steps: ["One"], current: "Starting" })] },
        { calls: [toolCall("c", "check_the_weather", { timezone: "America/Chicago" })] },
        { text: "ok" },
      ], []),
      client: CLIENTS.find(c => c.id === "acme")!, agent: { ...AGENTS.helper, tools: [...AGENTS.helper.tools, "check_the_weather"] }, catalog: { ...TOOLS, check_the_weather: unlabeled },
      conversationId: "c", bindings: env, desk: noDesk, modelKey: () => "k", emit: () => {},
      job: { update: p => { progressed.push(p); }, tool: label => { labels.push(label); } },
    }, { id: "m1", text: "go" }));
    expect(labels).toEqual(["Checking the time", null, "Updating progress", null, "Check the weather", null]);
    expect(progressed).toEqual([{ steps: ["One"], current: "Starting" }]);
  });

  it("update_progress does nothing outside a job, and check_back_in refuses there", async () => {
    const ctx = { actionId: "a" } as never;
    expect((await TOOLS.update_progress.execute(ctx, { steps: ["One"] })).data).toEqual({ saved: false });
    await expect(TOOLS.check_back_in.execute(ctx, { seconds: 30, reason: "x" })).rejects.toMatchObject({ definite: true });
  });
});
