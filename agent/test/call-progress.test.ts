import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/conversation";
import { newJob, saveJob, type Job, type JobStatus, type JobView } from "../src/jobs";
import { Store } from "../src/store";
import { signUserPass } from "../src/user-auth";
import { readBackSentence } from "../src/voice";
import { TOOLS } from "../tools";

const auth = { authorization: "Bearer test-token-acme-0123456789abcdef", "content-type": "application/json" };
const usage = { inputTokens: 1, outputTokens: 1 };
const pass = (person = "alice") => signUserPass("test-signing-key-acme-0123456789abcdef", "acme", person, Math.floor(Date.now() / 1000) + 3600);
const stub = (cid: string, client = "acme", agent = "helper") => env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`${client}/${agent}/${cid}`));
type Call = { conversationId: string; startedAt: number; lastActivityAt: number; turnRunning: boolean; current: string | null; jobs: (JobView & { conversationId: string; done: number; approvalId?: string })[] };

beforeEach(async () => {
  // Durable Object storage is shared by tests in this file; each case owns its call index.
  await runInDurableObject(env.DASHBOARD.get(env.DASHBOARD.idFromName("acme")), (_instance, state) => {
    state.storage.sql.exec("DELETE FROM conversations");
  });
});

async function status(person = "alice") {
  const response = await SELF.fetch("https://brain/v1/agents/helper/calls", { headers: { ...auth, "x-user-pass": await pass(person) } });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return response.json() as Promise<{ calls: Call[] }>;
}

async function voice(cid: string, person = "alice", text = "Private spoken request") {
  const messages = await runInDurableObject(stub(cid), (_instance, state) => new Store(state.storage).messages().map(row => row.message)
    .filter(message => typeof message.content === "string"
      && (message.role === "assistant" && !message.tool_calls || message.role === "user" && !message.content.startsWith("[Runtime note"))));
  messages.push({ role: "user", content: text });
  return SELF.fetch("https://brain/v1/chat/completions", {
    method: "POST", headers: auth, body: JSON.stringify({ model: "helper", messages,
      elevenlabs_extra_body: { conversation_id: cid, user_auth: await pass(person) } }),
  });
}

async function createCall(cid: string, person = "alice") {
  await runInDurableObject(stub(cid), instance => {
    instance.model = { async turn() { return { content: "Private assistant transcript", toolCalls: [], usage }; } };
  });
  const response = await voice(cid, person);
  expect(response.status).toBe(200);
  await response.text();
  await runInDurableObject(stub(cid), (_instance, state) => state.storage.deleteAlarm());
}

async function seedJob(cid: string, status: JobStatus, person = "alice", client = "acme", agent = "helper") {
  await runInDurableObject(stub(cid), (_instance, state) => {
    const store = new Store(state.storage);
    store.bind(client, agent, person);
    const job: Job = { ...newJob({ id: `job-${status}`, text: "Private job input" }, 0), status, plan: ["Read site", "Build preview"], done: 1, tool: "Checking preview" };
    if (status === "done" || status === "failed") job.finishedAt = Date.now();
    saveJob(store, job);
    store.note("Private job reply");
    if (status === "needs_approval") store.putAction({ id: "approve-call-job", tool: "vercel_publish", args: { private: "Private tool argument" }, status: "awaiting_approval", attempts: 0, createdAt: Date.now(), updatedAt: Date.now() });
  });
}

describe("person-owned call status", () => {
  it("lists only the bound person's app calls and their jobs, not other clients, agents, typed chats or phone calls", async () => {
    const own = "voice-alice-own";
    await createCall(own);
    await seedJob(own, "done");
    await createCall("voice-bob-own", "bob");
    await runInDurableObject(stub(own), (_instance, state) => new Store(state.storage).setMeta("callJobConversations", JSON.stringify([1, 2, 3, 4].map(n => `${own}-job-${n}`))));
    await seedJob(`${own}-job-1`, "running");
    await seedJob(`${own}-job-2`, "running", "bob");
    await seedJob(`${own}-job-3`, "running", "alice", "beacon");
    await seedJob(`${own}-job-4`, "running", "alice", "acme", "second");
    for (const [cid, client, agent, voiceTurn, source] of [
      ["voice-alice-typed", "acme", "helper", false, "app"],
      ["phone-alice", "acme", "helper", true, "phone"],
      ["voice-alice-other-client", "beacon", "helper", true, "app"],
      ["voice-alice-other-agent", "acme", "second", true, "app"],
    ] as const) {
      const other = stub(cid, client, agent);
      await runInDurableObject(other, instance => {
        instance.model = { async turn() { return { content: "Fixture", toolCalls: [], usage }; } };
      });
      await new Response(await other.turn({ clientId: client, agentId: agent, conversationId: cid, userId: "alice", voice: voiceTurn, source, input: { id: "m1", text: "Private request" } })).text();
      await runInDurableObject(other, (_instance, state) => state.storage.deleteAlarm());
    }
    const { calls } = await status();
    expect(calls.map(call => call.conversationId)).toEqual([own]);
    expect(calls[0].jobs.map(job => job.conversationId)).toEqual([own, `${own}-job-1`]);
    expect(calls[0]).toMatchObject({ turnRunning: false, current: null });
    expect(calls[0].lastActivityAt).toBeGreaterThanOrEqual(calls[0].startedAt);
    expect(calls[0]).not.toHaveProperty("running");
  });

  it("returns no calls to another signed person", async () => {
    await createCall("voice-alice-private");
    expect(await status("mallory")).toEqual({ calls: [] });
  });

  it("does not trust a forged voice prefix or a stale index over the conversation's bound person", async () => {
    const cid = "voice-alice-forged";
    await runInDurableObject(stub(cid), (instance, state) => {
      new Store(state.storage).bind("acme", "helper", "mallory");
      instance.model = { async turn() { return { content: "Private", toolCalls: [], usage }; } };
    });
    const forged = await voice(cid);
    expect(forged.status).toBe(409);
    expect(await status()).toEqual({ calls: [] });
    // Even corrupted/stale registry metadata cannot override the authoritative person binding.
    await runInDurableObject(stub(cid), (_instance, state) => {
      const store = new Store(state.storage);
      store.setMeta("appCallStartedAt", String(Date.now()));
      store.setMeta("appCallActivityAt", String(Date.now()));
    });
    await env.DASHBOARD.get(env.DASHBOARD.idFromName("acme")).registerAppCall("helper", cid, "alice", Date.now());
    expect(await status()).toEqual({ calls: [] });
  });

  it("projects running, approval, done and failed jobs without transcripts or tool arguments", async () => {
    const cid = "voice-alice-states";
    await createCall(cid);
    const states = ["running", "needs_approval", "done", "failed"] as const;
    await runInDurableObject(stub(cid), (_instance, state) => new Store(state.storage).setMeta("callJobConversations", JSON.stringify(states.map((_, i) => `${cid}-job-${i + 1}`))));
    for (const [i, state] of states.entries()) await seedJob(`${cid}-job-${i + 1}`, state);
    const body = await status();
    const jobs = body.calls[0].jobs;
    expect(jobs.map(job => job.status)).toEqual(states);
    expect(jobs[0]).toMatchObject({ current: "Checking preview", done: 1, queued: 0, steps: [{ label: "Read site", state: "done" }, { label: "Build preview", state: "active" }] });
    expect(jobs[1]).toMatchObject({ approvalId: "approve-call-job" });
    expect(jobs[2]).toMatchObject({ current: null, done: 2, finishedAt: expect.any(Number) });
    expect(jobs[3]).toMatchObject({ current: null, done: 1, finishedAt: expect.any(Number), steps: [{ label: "Read site", state: "done" }, { label: "Build preview", state: "failed" }] });
    expect(JSON.stringify(body)).not.toMatch(/Private|transcript|arguments|"args"|"text"|"input"/);
    expect(Object.keys(jobs[0]).sort()).toEqual(["conversationId", "current", "done", "id", "queued", "startedAt", "status", "steps", "updatedAt"]);
  });

  it("shows the catalogue's current step label only while a real voice tool runs", async () => {
    const cid = "voice-alice-live-label";
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    await runInDurableObject(stub(cid), instance => {
      instance.catalog = { ...TOOLS, current_time: { ...TOOLS.current_time, label: "Checking the time", async execute() { entered(); await held; return { data: { time: "noon" } }; } } };
      let turn = 0;
      instance.model = { async turn() {
        return turn++ === 0 ? { content: "", toolCalls: [{ id: "clock", type: "function", function: { name: "current_time", arguments: JSON.stringify({ timezone: "UTC" }) } }], usage }
          : { content: "Private final answer", toolCalls: [], usage };
      } };
    });
    const response = await voice(cid);
    const body = response.text();
    try {
      await started;
      const { calls } = await status();
      expect(calls[0]).toMatchObject({ current: "Checking the time", turnRunning: true });
    } finally {
      release();
      await body;
      await runInDurableObject(stub(cid), (_instance, state) => state.storage.deleteAlarm());
    }
    expect((await status()).calls[0]).toMatchObject({ current: null, turnRunning: false });
  });

  it("keeps a real signed call's background job visible after its voice turn finishes", async () => {
    const cid = "voice-alice-handover";
    const task = "Build a preview";
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await runInDurableObject(stub(cid), instance => {
      let step = 0;
      instance.model = { async turn(request) {
        if (step++ === 0) return {
          content: "", usage,
          toolCalls: [{ id: "proposal", type: "function", function: { name: "propose_change", arguments: JSON.stringify({ task }) } }],
        };
        const text = readBackSentence(task);
        request.onText?.(text);
        return { content: text, toolCalls: [], usage };
      } };
    });
    await (await voice(cid, "alice", task)).text();
    await runInDurableObject(stub(`${cid}-job-1`), instance => {
      instance.model = { async turn() { await held; return { content: "Preview ready", toolCalls: [], usage }; } };
    });
    try {
      const response = await voice(cid, "alice", "Yes");
      expect(response.status).toBe(200);
      await response.text();
      const { calls } = await status();
      expect(calls[0]).toMatchObject({ conversationId: cid, turnRunning: false, jobs: [{ conversationId: `${cid}-job-1`, status: "running" }] });
      expect(await runInDurableObject(stub(cid), (_instance, state) => JSON.parse(new Store(state.storage).meta("callJobConversations") || "[]"))).toEqual([`${cid}-job-1`]);
    } finally { release(); }
    await vi.waitFor(async () => expect((await status()).calls[0].jobs[0].status).toBe("done"), { timeout: 8_000, interval: 50 });
    for (const id of [cid, `${cid}-job-1`]) await runInDurableObject(stub(id), (_instance, state) => state.storage.deleteAlarm());
  });

  it("bounds recent calls to the newest twenty started within twenty-four hours", async () => {
    expect(await status()).toEqual({ calls: [] });
    const now = Date.now();
    for (let i = 0; i < 22; i++) {
      const cid = `voice-alice-cap-${i}`;
      const at = i === 21 ? now - 25 * 60 * 60_000 : now - i * 1000;
      await runInDurableObject(stub(cid), (_instance, state) => {
        const store = new Store(state.storage);
        store.bind("acme", "helper", "alice");
        store.setMeta("appCallStartedAt", String(at));
        store.setMeta("appCallActivityAt", String(at));
      });
      await env.DASHBOARD.get(env.DASHBOARD.idFromName("acme")).registerAppCall("helper", cid, "alice", at);
    }
    const { calls } = await status();
    expect(calls.map(call => call.conversationId)).toEqual(Array.from({ length: 20 }, (_, i) => `voice-alice-cap-${i}`));
  });

  it("requires client and signed-person auth and hides disallowed agents", async () => {
    const url = "https://brain/v1/agents/helper/calls";
    for (const headers of [{}, auth, { ...auth, "x-user-pass": "forged" }]) expect((await SELF.fetch(url, { headers })).status).toBe(401);
    const headers = { ...auth, "x-user-pass": await pass() };
    expect((await SELF.fetch("https://brain/v1/agents/iris/calls", { headers })).status).toBe(404);
    expect(await status()).toEqual({ calls: [] });
  });

  it("counts call status only against STATUS_LIMITER, including its 429, and leaves other reads on CLIENT_LIMITER", async () => {
    const client = vi.fn(async () => ({ success: false }));
    const statusLimit = vi.fn(async () => ({ success: true }));
    const bindings = { ...env, CLIENT_LIMITER: { limit: client }, STATUS_LIMITER: { limit: statusLimit } } as unknown as Env;
    const headers = { ...auth, "x-user-pass": await pass() };
    const request = () => new Request("https://brain/v1/agents/helper/calls", { headers });
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    expect((await worker.fetch(request(), bindings, ctx)).status).toBe(200);
    expect(statusLimit).toHaveBeenCalledExactlyOnceWith({ key: "acme" });
    expect(client).not.toHaveBeenCalled();
    statusLimit.mockResolvedValue({ success: false });
    const limited = await worker.fetch(request(), bindings, ctx);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "Too many requests" });
    expect(client).not.toHaveBeenCalled();
    expect((await worker.fetch(new Request("https://brain/v1/agents", { headers }), bindings, ctx)).status).toBe(429);
    expect(client).toHaveBeenCalledExactlyOnceWith({ key: "acme" });
  });
});
