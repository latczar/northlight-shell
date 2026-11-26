import { createExecutionContext, env, runInDurableObject, SELF, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENTS } from "../agents";
import { createRecord as createRepo, recordKey } from "./fixtures/demo";
import { CLIENTS } from "../clients";
import type { ActionRecord, AdminStuckStep, ToolDefinition } from "../src/contracts";
import { Conversation } from "../src/conversation";
import { Dashboard } from "../src/dashboard";
import worker from "../src/index";
import { loadJob, newJob, saveJob, saveQueue } from "../src/jobs";
import { runTurn } from "../src/loop";
import type { ModelAdapter } from "../src/model";
import { Store } from "../src/store";
import { signUserPass } from "../src/user-auth";
import { TOOLS } from "../tools";
import { noDesk } from "./desk";

const auth = { authorization: "Bearer test-token-acme-0123456789abcdef", "content-type": "application/json" };
const userKey = "test-signing-key-acme-0123456789abcdef";
const adminKey = "test-approver-key-acme-0123456789abcdef";
const expiry = () => Math.floor(Date.now() / 1000) + 3600;
const user = (id = "sai") => signUserPass(userKey, "acme", id, expiry());
const admin = (purpose = "admin", client = "acme", expires = expiry()) => signUserPass(adminKey, client, "robin", expires, purpose);
const stub = (cid: string) => env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`acme/helper/${cid}`));
const url = (cid: string, action?: string) => `https://brain/v1/agents/helper/conversations/${cid}/stuck${action ? `/${action}` : ""}`;
// These tests exercise authorization and durable state, not the shared per-minute ingress budget.
const routeEnv = { ...env, CLIENT_LIMITER: { limit: async () => ({ success: true }) },
  MEDIA_LIMITER: env.CLIENT_LIMITER, LEADS_LIMITER: env.CLIENT_LIMITER, LEAD_INTAKE_LIMITER: env.CLIENT_LIMITER };
const fetchRoute = (input: string, init: RequestInit) => worker.fetch(new Request(input, init), routeEnv, createExecutionContext());
const clear = async (cid: string, action = "a1", headers?: Record<string, string>, body: unknown = { outcome: "not_created" }) =>
  fetchRoute(url(cid, action), { method: "POST", headers: { ...auth, ...(headers ?? { "x-user-pass": await user() }) }, body: JSON.stringify(body) });
const list = async (cid: string, who = "sai") => fetchRoute(url(cid), { headers: { ...auth, "x-user-pass": await user(who) } });
async function inboxLoad() {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request("https://brain/v1/stuck", { headers: { ...auth, "x-admin-pass": await admin() } }), routeEnv, ctx);
  expect(response.status).toBe(200);
  const body = await response.json() as { steps: AdminStuckStep[]; complete: boolean };
  return { body, settled: waitOnExecutionContext(ctx) };
}

async function inboxState(): Promise<{ steps: AdminStuckStep[]; complete: boolean }> {
  const load = await inboxLoad();
  await load.settled;
  return env.DASHBOARD.get(env.DASHBOARD.idFromName("acme")).stuck();
}
const inbox = async () => (await inboxState()).steps;
async function seed(cid: string, fields: Partial<ActionRecord> = {}, who: string | undefined = "sai") {
  await runInDurableObject(stub(cid), (_instance, state) => {
    const store = new Store(state.storage);
    store.bind("acme", "helper", who);
    store.putAction({ id: "a1", tool: "create_record", args: { name: cid, directionApprovalId: "direction" }, status: "uncertain", error: "GitHub gave no answer.", attempts: 1, createdAt: 100, updatedAt: 100, ...fields });
  });
}
const saved = (cid: string) => runInDurableObject(stub(cid), (_instance, state) => {
  const store = new Store(state.storage);
  return { action: store.action("a1"), messages: store.messages(), uncertain: store.actions("uncertain"), transcript: store.transcript(100).lines };
});
const claim = (cid: string) => recordKey("acme", "projects", cid);
async function putClaim(cid: string, actionId: string, pending = true) {
  await env.IMAGES.put(claim(cid), JSON.stringify({ repo: cid, actionId, pending, createdAt: "2026-01-01" }));
}
const usage = { inputTokens: 5, outputTokens: 2 };
function calling(actionId: string): ModelAdapter {
  let round = 0;
  return { async turn() {
    return round++ === 0
      ? { content: "", toolCalls: [{ id: actionId, type: "function", function: { name: createRepo.name, arguments: JSON.stringify({ name: "checked-retry", directionApprovalId: "direction" }) } }], usage }
      : { content: "Noted.", toolCalls: [], usage };
  } };
}
async function run(cid: string, tool: ToolDefinition, actionId: string, who: string | null = "sai", source: AdminStuckStep["source"] = "app") {
  await runInDurableObject(stub(cid), async (instance, state) => {
    const store = new Store(state.storage);
    store.bind("acme", "helper", who ?? undefined);
    await env.DASHBOARD.get(env.DASHBOARD.idFromName("acme")).registerConversation("helper", cid);
    instance.catalog = { ...TOOLS, [tool.name]: tool };
    await runTurn({ store, model: calling(actionId), client: CLIENTS.find(c => c.id === "acme")!, agent: AGENTS.helper,
      catalog: instance.catalog, conversationId: cid, userId: who ?? undefined, source, bindings: env, desk: noDesk, modelKey: () => "test-key", emit: () => {},
    }, { id: `message-${actionId}`, text: "Create the repo" });
  });
}

beforeEach(async () => {
  await runInDurableObject(env.DASHBOARD.get(env.DASHBOARD.idFromName("acme")), (_dashboard, state) => {
    state.storage.sql.exec("DELETE FROM stuck_steps; DELETE FROM stuck_reconcile; DELETE FROM stuck_reconcile_agents; DELETE FROM conversations");
  });
});

describe("checked stuck steps", () => {
  it("lets the owner list and backfill once, then clear with a durable audit and runtime-only note", async () => {
    const cid = "web-stuck-owner";
    await seed(cid);
    expect(await inbox()).toEqual([]);
    for (let i = 0; i < 2; i++) {
      const response = await list(cid);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ steps: [{ actionId: "a1", agent: "helper", conversationId: cid, tool: "create_record", label: `Create the record "${cid}"`, createdAt: 100, error: "GitHub gave no answer." }] });
    }
    expect(await inbox()).toHaveLength(1);
    expect((await clear(cid)).status).toBe(200);
    const state = await saved(cid);
    expect(state.action).toMatchObject({ status: "failed", checkedBy: "sai", checkedAt: expect.any(Number), error: "Checked by a person: it was not created. It may be tried again." });
    expect(state.uncertain).toEqual([]);
    expect(state.messages.map(row => row.message)).toEqual([{ role: "user", content: "[Runtime note, not from the user] A person checked the earlier create_record request a1: it was not created. You may try it again if the person still wants it." }]);
    expect(state.transcript).toEqual([]);
    expect(await inbox()).toEqual([]);
    const again = await clear(cid);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, already: true });
    expect((await saved(cid)).messages).toHaveLength(1);
  });

  it("refuses another person's list and clear, absent passes, and foreign clients", async () => {
    const cid = "web-stuck-private";
    await seed(cid);
    expect((await list(cid, "other")).status).toBe(404);
    expect((await clear(cid, "a1", { "x-user-pass": await user("other") })).status).toBe(404);
    expect((await SELF.fetch(url(cid), { headers: auth })).status).toBe(401);
    expect((await clear(cid, "a1", {})).status).toBe(401);
    expect((await SELF.fetch(url(cid), { headers: { ...auth, authorization: "Bearer test-token-kestrel-0123456789abcdef", "x-user-pass": await user() } })).status).toBe(404);
    expect((await saved(cid)).action?.status).toBe("uncertain");
    expect(await inbox()).toEqual([]);
  });

  it("lets a client admin list and clear somebody else's chat without per-agent approval rights", async () => {
    const cid = "web-stuck-admin";
    await seed(cid);
    expect((await list(cid)).status).toBe(200);
    expect(await inbox()).toMatchObject([{ requestedBy: "sai", source: "app", conversationId: cid }]);
    const response = await clear(cid, "a1", { "x-admin-pass": await admin() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect((await saved(cid)).action?.checkedBy).toBe("robin");
  });

  it("accepts either authority when both headers are sent", async () => {
    await seed("web-stuck-either-owner");
    expect((await clear("web-stuck-either-owner", "a1", { "x-user-pass": await user(), "x-admin-pass": "expired" })).status).toBe(200);
    await seed("web-stuck-either-admin");
    expect((await clear("web-stuck-either-admin", "a1", { "x-user-pass": await user("other"), "x-admin-pass": await admin() })).status).toBe(200);
  });

  it("rejects forged, expired, wrong-purpose and wrong-client admin passes with 401", async () => {
    await seed("web-stuck-bad-admin");
    for (const pass of ["bad", await admin("approve"), await admin("admin", "beacon"), await admin("admin", "acme", Math.floor(Date.now() / 1000) - 1)]) {
      expect((await SELF.fetch("https://brain/v1/stuck", { headers: { ...auth, "x-admin-pass": pass } })).status).toBe(401);
      expect((await clear("web-stuck-bad-admin", "a1", { "x-admin-pass": pass })).status).toBe(401);
    }
    expect((await SELF.fetch("https://brain/v1/stuck", { headers: auth })).status).toBe(401);
  });

  it("refuses missing or short approver keys with 403", async () => {
    for (const key of [undefined, "short"]) {
      const testEnv = { ...env, APPROVER_SIGNING_KEY_ACME: key, MEDIA_LIMITER: env.CLIENT_LIMITER, LEADS_LIMITER: env.CLIENT_LIMITER, LEAD_INTAKE_LIMITER: env.CLIENT_LIMITER };
      const headers = { ...auth, "x-admin-pass": await admin() };
      const response = await worker.fetch(new Request("https://brain/v1/stuck", { headers }), testEnv, createExecutionContext());
      expect(response.status).toBe(403);
      const post = await worker.fetch(new Request(url("web-any", "a1"), { method: "POST", headers, body: JSON.stringify({ outcome: "not_created" }) }), testEnv, createExecutionContext());
      expect(post.status).toBe(403);
    }
  });

  it("requires the exact outcome body, an existing uncertain action, and an opt-in tool", async () => {
    const cid = "web-stuck-invalid";
    await seed(cid);
    for (const body of [null, [], {}, { outcome: "created" }, { outcome: "not_created", extra: true }]) expect((await clear(cid, "a1", undefined, body)).status).toBe(400);
    expect((await clear(cid, "absent")).status).toBe(404);
    for (const status of ["succeeded", "running", "failed", "intent", "awaiting_approval"] as const) {
      await runInDurableObject(stub(cid), (_instance, state) => { const store = new Store(state.storage); store.putAction({ ...store.action("a1")!, status }); });
      expect((await clear(cid)).status).toBe(409);
    }
    await seed("web-stuck-domain", { tool: "buy_domain" });
    expect((await clear("web-stuck-domain")).status).toBe(409);
    const response = await list("web-stuck-domain");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ steps: [] });
  });

  it("refuses a confirmed project without changing its record, action, history or dashboard row", async () => {
    const cid = "web-stuck-confirmed";
    await seed(cid);
    await putClaim(cid, "a1", false);
    expect((await list(cid)).status).toBe(200);
    const before = await saved(cid);
    const rows = await inbox();
    const record = await (await env.IMAGES.get(claim(cid)))!.text();
    const response = await clear(cid);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: expect.stringContaining("recorded as created") });
    expect(await saved(cid)).toEqual(before);
    expect(await inbox()).toEqual(rows);
    expect(await (await env.IMAGES.get(claim(cid)))!.text()).toBe(record);
  });

  it("marks only this action's pending claim as checked and keeps a different request's claim", async () => {
    for (const [cid, actionId] of [["web-stuck-own-claim", "a1"], ["web-stuck-other-claim", "another-action"]]) {
      await seed(cid);
      await putClaim(cid, actionId);
      expect((await clear(cid)).status).toBe(200);
      const record = await env.IMAGES.get(claim(cid));
      if (actionId === "a1") expect(await record!.json()).toMatchObject({ actionId, pending: true, checkedAt: expect.any(Number) });
      else {
        const savedClaim = await record!.json();
        expect(savedClaim).toMatchObject({ actionId, pending: true });
        expect(savedClaim).not.toHaveProperty("checkedAt");
      }
    }
  });

  it("serializes simultaneous clicks: one hook, one audit and one runtime note", async () => {
    const cid = "web-stuck-double";
    await seed(cid);
    let calls = 0;
    await runInDurableObject(stub(cid), instance => {
      instance.catalog = { ...TOOLS, create_record: { ...createRepo, checkedRetry: { ...createRepo.checkedRetry!, async clear(context, args) { calls++; await createRepo.checkedRetry!.clear(context, args); } } } };
    });
    await putClaim(cid, "a1");
    const responses = await Promise.all([clear(cid), clear(cid)]);
    for (const response of responses) expect(response.status).toBe(200);
    expect(await Promise.all(responses.map(response => response.json()))).toEqual(expect.arrayContaining([{ ok: true }, { ok: true, already: true }]));
    expect(calls).toBe(1);
    expect((await saved(cid)).messages).toHaveLength(1);
    expect(await (await env.IMAGES.get(claim(cid)))!.json()).toMatchObject({ pending: true, actionId: "a1", checkedAt: expect.any(Number) });
  });

  it("keeps the tool locked until checked, then admits a new create request in that conversation", async () => {
    const cid = "web-stuck-retry";
    await seed(cid);
    let calls = 0;
    const tool = { ...createRepo, snapshots: undefined, async execute() { calls++; return { data: { created: true } }; } };
    await run(cid, tool, "before");
    expect(calls).toBe(0);
    expect((await clear(cid)).status).toBe(200);
    await run(cid, tool, "after");
    expect(calls).toBe(1);
    const action = await runInDurableObject(stub(cid), (_instance, state) => new Store(state.storage).action("after"));
    expect(action?.status).toBe("succeeded");
  });

  it("queues a check behind a running turn rather than changing its history mid-turn", async () => {
    const cid = "web-stuck-running";
    await seed(cid);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    await runInDurableObject(stub(cid), instance => { instance.model = { async turn() { entered(); await held; return { content: "Finished.", toolCalls: [], usage }; } }; });
    const turn = SELF.fetch(`https://brain/v1/agents/helper/conversations/${cid}/messages`, { method: "POST", headers: auth, body: JSON.stringify({ id: "held", text: "Hello", userAuth: await user() }) }).then(response => { expect(response.status).toBe(200); return response.text(); });
    await started;
    const checking = clear(cid);
    try {
      const response = await list(cid);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ steps: [{ actionId: "a1" }] });
      expect((await saved(cid)).action?.status).toBe("uncertain");
    }
    finally { release(); }
    await turn;
    expect((await checking).status).toBe(200);
    const messages = (await saved(cid)).messages.map(row => row.message);
    expect(messages.at(-2)).toEqual({ role: "assistant", content: "Finished." });
    expect(messages.at(-1)?.content).toContain("A person checked");
  });

  it("does not resurrect a cleared step when an unqueued owner backfill finishes late", async () => {
    const cid = "web-stuck-backfill-race";
    await seed(cid);
    const put = Dashboard.prototype.putStuck;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const paused = vi.spyOn(Dashboard.prototype, "putStuck").mockImplementation(async function(this: Dashboard, step) {
      entered();
      await held;
      await put.call(this, step);
    });
    const reading = list(cid);
    try {
      await started;
      expect((await clear(cid)).status).toBe(200);
      release();
      const response = await reading;
      expect(response.status).toBe(200);
      expect(await inbox()).toEqual([]);
    } finally {
      release();
      try { await reading; } finally { paused.mockRestore(); }
    }
  });

  it("refuses a running job immediately without changes, then permits the check once it is done", async () => {
    const cid = "web-stuck-busy-job";
    await seed(cid);
    await putClaim(cid, "a1");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await runInDurableObject(stub(cid), (instance, state) => {
      saveJob(new Store(state.storage), newJob({ id: "busy", text: "Do other work" }, 0));
      Object.assign(instance, { queue: held });
    });
    const before = await saved(cid);
    const jobBefore = await runInDurableObject(stub(cid), (_instance, state) => loadJob(new Store(state.storage)));
    try {
      const response = await clear(cid);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "This chat is busy with another task right now. Try again when it has finished." });
      expect(await saved(cid)).toEqual(before);
      expect(await runInDurableObject(stub(cid), (_instance, state) => loadJob(new Store(state.storage)))).toEqual(jobBefore);
      expect(await (await env.IMAGES.get(claim(cid)))!.json()).toMatchObject({ pending: true, actionId: "a1" });
      expect(await inbox()).toEqual([]);
      expect((await clear(cid, "a1", { "x-user-pass": await user("other") })).status).toBe(404);
      const responseWhileBusy = await list(cid);
      expect(responseWhileBusy.status).toBe(200);
      expect(await responseWhileBusy.json()).toMatchObject({ steps: [{ actionId: "a1" }] });
    } finally {
      release();
    }
    await runInDurableObject(stub(cid), (_instance, state) => {
      const store = new Store(state.storage);
      saveJob(store, { ...loadJob(store)!, status: "done" });
    });
    expect((await clear(cid)).status).toBe(200);
    expect((await saved(cid)).action?.status).toBe("failed");
    expect(await (await env.IMAGES.get(claim(cid)))!.json()).toMatchObject({ pending: true, actionId: "a1", checkedAt: expect.any(Number) });
  });

  it("allows waiting and approval-waiting jobs, but refuses queued job inputs", async () => {
    for (const status of ["waiting", "needs_approval", "done"] as const) {
      const cid = `web-stuck-${status}`;
      await seed(cid);
      await runInDurableObject(stub(cid), (_instance, state) => {
        const store = new Store(state.storage);
        saveJob(store, { ...newJob({ id: "job", text: "Other work" }, 0), status });
        saveQueue(store, [{ id: "next", text: "Next task" }]);
      });
      const response = await clear(cid);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "This chat is busy with another task right now. Try again when it has finished." });
      expect((await saved(cid)).action?.status).toBe("uncertain");
      await runInDurableObject(stub(cid), (_instance, state) => saveQueue(new Store(state.storage), []));
      expect((await clear(cid)).status).toBe(200);
    }
  });

  it("keeps tool and recovery outcomes when the stuck index fails, logs names only, and backfills later", async () => {
    const putFailure = vi.spyOn(Dashboard.prototype, "putStuck").mockRejectedValue(new TypeError("Private provider details"));
    const removeFailure = vi.spyOn(Dashboard.prototype, "removeStuck").mockRejectedValue(new TypeError("Private provider details"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const tool: ToolDefinition = { ...createRepo, snapshots: undefined, async execute() { return { data: { created: true } }; } };
      await run("web-stuck-index-success", tool, "a1");
      expect((await saved("web-stuck-index-success")).action?.status).toBe("succeeded");
      await run("web-stuck-index-uncertain", { ...tool, async execute() { throw new Error("Lost reply"); } }, "a1");
      const uncertain = await saved("web-stuck-index-uncertain");
      expect(uncertain.action).toMatchObject({ status: "uncertain", error: "The tool failed." });
      expect(uncertain.messages.at(-1)?.message).toEqual({ role: "assistant", content: "Noted." });
      const cid = "web-stuck-index-recovery";
      await seed(cid, { status: "running" });
      await runInDurableObject(stub(cid), async (instance, state) => {
        const store = new Store(state.storage);
        store.append({ role: "assistant", content: null, tool_calls: [{ id: "a1", type: "function", function: { name: createRepo.name, arguments: JSON.stringify(store.action("a1")!.args) } }] });
        await runTurn({ store, model: { async turn() { return { content: "Confirmed.", toolCalls: [], usage }; } }, client: CLIENTS.find(c => c.id === "acme")!, agent: AGENTS.helper,
          catalog: { ...instance.catalog, create_record: { ...tool, async reconcile() { return { status: "succeeded", result: { data: { created: true } } }; } } },
          conversationId: cid, userId: "sai", bindings: env, desk: noDesk, modelKey: () => "key", emit: () => {},
        }, { id: "recover", text: "What happened?" });
      });
      expect((await saved(cid)).action?.status).toBe("succeeded");
      expect(errors.mock.calls).toEqual(Array.from({ length: 3 }, () => ["stuck index update failed", "TypeError"]));
    } finally {
      putFailure.mockRestore();
      removeFailure.mockRestore();
      errors.mockRestore();
    }
    expect(await inbox()).toMatchObject([{ conversationId: "web-stuck-index-uncertain" }]);
    const response = await list("web-stuck-index-uncertain");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ steps: [{ actionId: "a1" }] });
  });

  it("reconciles pre-release steps and stale rows on the first admin load, but not again within ten minutes", async () => {
    const cid = "web-stuck-pre-release";
    const stale = "web-stuck-no-longer-uncertain";
    const empty = "web-stuck-never-created";
    await seed(cid);
    await seed(stale, { status: "failed" });
    const dashboard = env.DASHBOARD.get(env.DASHBOARD.idFromName("acme"));
    for (const id of [cid, stale, empty]) await dashboard.registerConversation("helper", id);
    await dashboard.putStuck({ actionId: "a1", agent: "helper", conversationId: stale, tool: "create_record", label: "Old repo request", createdAt: 100, error: "old", requestedBy: "sai", source: "app" });
    const before = await runInDurableObject(stub(empty), (_instance, state) => state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").toArray());
    const current = Conversation.prototype.currentStuck;
    const reads = vi.spyOn(Conversation.prototype, "currentStuck").mockImplementation(function(this: Conversation, clientId, agentId, conversationId) {
      return current.call(this, clientId, agentId, conversationId);
    });
    try {
      expect(await inbox()).toMatchObject([{ conversationId: cid, requestedBy: "sai", source: "app" }]);
      expect(reads).toHaveBeenCalledTimes(3);
      expect(await inbox()).toMatchObject([{ conversationId: cid }]);
      expect(reads).toHaveBeenCalledTimes(3);
      await runInDurableObject(env.DASHBOARD.get(env.DASHBOARD.idFromName("acme")), (_instance, state) => {
        state.storage.sql.exec("UPDATE stuck_reconcile SET started_at = ?", Date.now() - 10 * 60_000 - 1);
      });
      expect(await inbox()).toMatchObject([{ conversationId: cid }]);
      expect(reads).toHaveBeenCalledTimes(6);
      expect(await runInDurableObject(stub(empty), (_instance, state) => state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").toArray())).toEqual(before);
    } finally {
      reads.mockRestore();
    }
  });

  it("keeps a failing conversation's indexed rows and continues reconciling other chats", async () => {
    const failing = "web-stuck-reconcile-unavailable";
    const healthy = "web-stuck-reconcile-healthy";
    await seed(failing);
    await seed(healthy);
    const dashboard = env.DASHBOARD.get(env.DASHBOARD.idFromName("acme"));
    for (const id of [failing, healthy]) await dashboard.registerConversation("helper", id);
    await dashboard.putStuck({ actionId: "a1", agent: "helper", conversationId: failing, tool: "create_record", label: "Existing row", createdAt: 100, error: "saved error", requestedBy: "sai", source: "app" });
    const current = Conversation.prototype.currentStuck;
    const reads = vi.spyOn(Conversation.prototype, "currentStuck").mockImplementation(function(this: Conversation, clientId, agentId, conversationId) {
      if (conversationId === failing) return Promise.reject(new TypeError("Private provider details"));
      return current.call(this, clientId, agentId, conversationId);
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const steps = await inbox();
      expect(steps).toHaveLength(2);
      expect(steps.find(step => step.conversationId === failing)).toMatchObject({ label: "Existing row", error: "saved error" });
      expect(steps.find(step => step.conversationId === healthy)).toMatchObject({ requestedBy: "sai", source: "app" });
      expect(errors.mock.calls).toEqual([["stuck reconcile failed", "TypeError"]]);
    } finally {
      reads.mockRestore();
      errors.mockRestore();
    }
  });

  it("pages through every registered chat without throttling an unfinished pass and retains failure state until a clean pass", async () => {
    const ids = Array.from({ length: 200 }, (_, index) => `job-stuck-page-${String(index).padStart(3, "0")}`);
    const late = "web-stuck-page-late";
    ids.push(late);
    await seed(ids[0]);
    await seed(late);
    await runInDurableObject(env.DASHBOARD.get(env.DASHBOARD.idFromName("acme")), async dashboard => {
      for (const id of ids) await dashboard.registerConversation("helper", id);
    });
    let fail = true;
    const current = Conversation.prototype.currentStuck;
    const reads = vi.spyOn(Conversation.prototype, "currentStuck").mockImplementation(function(this: Conversation, clientId, agentId, conversationId) {
      if (fail && conversationId === ids[0]) return Promise.reject(new TypeError("Temporary read failure"));
      return current.call(this, clientId, agentId, conversationId);
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const first = await inboxState();
      expect(first).toEqual({ steps: [], complete: false });
      expect(reads).toHaveBeenCalledTimes(200);
      expect(new Set(reads.mock.calls.map(call => call[2]))).toEqual(new Set(ids.slice(0, 200)));
      const second = await inboxState();
      expect(second.complete).toBe(false);
      expect(second.steps).toMatchObject([{ conversationId: late, requestedBy: "sai" }]);
      expect(reads).toHaveBeenCalledTimes(201);
      expect(await inboxState()).toEqual(second);
      expect(reads).toHaveBeenCalledTimes(201);
      fail = false;
      await runInDurableObject(env.DASHBOARD.get(env.DASHBOARD.idFromName("acme")), (_dashboard, state) => {
        state.storage.sql.exec("UPDATE stuck_reconcile SET started_at = ?", Date.now() - 10 * 60_000 - 1);
      });
      const nextPass = await inboxState();
      expect(nextPass.complete).toBe(false);
      expect(nextPass.steps).toHaveLength(2);
      expect(reads).toHaveBeenCalledTimes(401);
      const finished = await inboxState();
      expect(finished.complete).toBe(true);
      expect(finished.steps).toHaveLength(2);
      expect(reads).toHaveBeenCalledTimes(402);
      expect(await inboxState()).toEqual(finished);
      expect(reads).toHaveBeenCalledTimes(402);
      expect(errors.mock.calls).toEqual([["stuck reconcile failed", "TypeError"]]);
    } finally {
      reads.mockRestore();
      errors.mockRestore();
    }
  }, 30_000);

  it("atomically claims a page so concurrent admin reads do not scan it twice", async () => {
    const cid = "web-stuck-page-claim";
    await seed(cid);
    await env.DASHBOARD.get(env.DASHBOARD.idFromName("acme")).registerConversation("helper", cid);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const current = Conversation.prototype.currentStuck;
    const reads = vi.spyOn(Conversation.prototype, "currentStuck").mockImplementation(async function(this: Conversation, clientId, agentId, conversationId) {
      entered();
      await held;
      return current.call(this, clientId, agentId, conversationId);
    });
    const first = await inboxLoad();
    try {
      await started;
      expect(first.body).toEqual({ steps: [], complete: false });
      const second = await inboxLoad();
      expect(second.body).toEqual({ steps: [], complete: false });
      await second.settled;
      expect(reads).toHaveBeenCalledTimes(1);
      release();
      await first.settled;
      const finished = await inboxState();
      expect(finished.complete).toBe(true);
      expect(finished.steps).toMatchObject([{ conversationId: cid }]);
      expect(reads).toHaveBeenCalledTimes(1);
    } finally {
      release();
      try { await first.settled; } finally { reads.mockRestore(); }
    }
  });

  it("keeps the last finished sweep result while a new page is claimed, and replaces it only when that sweep finishes", async () => {
    const cid = "web-stuck-last-finished";
    await seed(cid);
    const dashboard = env.DASHBOARD.get(env.DASHBOARD.idFromName("acme"));
    await dashboard.registerConversation("helper", cid);
    expect((await inboxState()).complete).toBe(true);
    await runInDurableObject(dashboard, (_instance, state) => {
      state.storage.sql.exec("UPDATE stuck_reconcile SET started_at = ?", Date.now() - 10 * 60_000 - 1);
    });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const reads = vi.spyOn(Conversation.prototype, "currentStuck").mockImplementation(async () => {
      entered();
      await held;
      throw new TypeError("Temporary read failure");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const load = await inboxLoad();
    try {
      await started;
      expect(load.body.complete).toBe(true);
      const concurrent = await inboxLoad();
      expect(concurrent.body.complete).toBe(true);
      await concurrent.settled;
      expect(reads).toHaveBeenCalledTimes(1);
      release();
      await load.settled;
      expect((await inboxState()).complete).toBe(false);
      expect(reads).toHaveBeenCalledTimes(1);
      expect(errors.mock.calls).toEqual([["stuck reconcile failed", "TypeError"]]);
    } finally {
      release();
      try { await load.settled; }
      finally { reads.mockRestore(); errors.mockRestore(); }
    }
  });

  it("records new uncertain loop actions with their trusted ingress channel, newest first", async () => {
    const origins = [
      { cid: "job-stuck-app", source: "app", who: "sai" },
      { cid: "web-stuck-phone", source: "phone", who: "team" },
      { cid: "phone-stuck-slack", source: "slack", who: "team" },
      { cid: "slack-stuck-scheduled", source: "scheduled", who: null },
      { cid: "job-stuck-other", source: "other", who: null },
    ] as const;
    const tool = { ...createRepo, async execute() { throw new Error("Lost reply"); } };
    for (const [index, { cid, source, who }] of origins.entries()) {
      await run(cid, tool, `uncertain-${index}`, who, source);
      await runInDurableObject(stub(cid), (_instance, state) => expect(new Store(state.storage).action(`uncertain-${index}`)?.status).toBe("uncertain"));
    }
    const rows = await inbox();
    expect(rows).toHaveLength(5);
    expect(rows.map(row => row.createdAt)).toEqual(rows.map(row => row.createdAt).sort((a, b) => b - a));
    for (const { cid, source } of origins) expect(rows.find(row => row.conversationId === cid)).toMatchObject({ source, requestedBy: source === "app" ? "sai" : null });
  });

  it("records uncertain restart recovery without executing the write again", async () => {
    const cid = "web-stuck-recovery";
    await seed(cid, { status: "running" });
    await putClaim(cid, "a1");
    await runInDurableObject(stub(cid), async (instance, state) => {
      const store = new Store(state.storage);
      store.append({ role: "assistant", content: null, tool_calls: [{ id: "a1", type: "function", function: { name: createRepo.name, arguments: JSON.stringify(store.action("a1")!.args) } }] });
      await runTurn({ store, model: { async turn() { return { content: "A person must check.", toolCalls: [], usage }; } }, client: CLIENTS.find(c => c.id === "acme")!, agent: AGENTS.helper,
        catalog: instance.catalog, conversationId: cid, userId: "sai", bindings: env, desk: noDesk, modelKey: () => "key", emit: () => {},
      }, { id: "recover", text: "What happened?" });
    });
    expect(await inbox()).toMatchObject([{ conversationId: cid, requestedBy: "sai", source: "app", error: "Interrupted before finishing." }]);
    expect((await saved(cid)).action?.status).toBe("uncertain");
    expect(await (await env.IMAGES.get(claim(cid)))!.json()).toMatchObject({ pending: true, actionId: "a1" });
  });

  it("removes a stuck row when restart reconciliation confirms the action instead", async () => {
    const cid = "web-stuck-reconciled";
    await seed(cid);
    expect((await list(cid)).status).toBe(200);
    expect(await inbox()).toHaveLength(1);
    await runInDurableObject(stub(cid), async (instance, state) => {
      const store = new Store(state.storage);
      store.append({ role: "assistant", content: null, tool_calls: [{ id: "a1", type: "function", function: { name: createRepo.name, arguments: JSON.stringify(store.action("a1")!.args) } }] });
      const tool: ToolDefinition = { ...createRepo, snapshots: undefined, async reconcile() { return { status: "succeeded", result: { data: { repo: "example-org/confirmed" } } }; } };
      await runTurn({ store, model: { async turn() { return { content: "Confirmed.", toolCalls: [], usage }; } }, client: CLIENTS.find(c => c.id === "acme")!, agent: AGENTS.helper,
        catalog: { ...instance.catalog, create_record: tool }, conversationId: cid, userId: "sai", bindings: env, desk: noDesk, modelKey: () => "key", emit: () => {},
      }, { id: "reconciled", text: "What happened?" });
    });
    expect((await saved(cid)).action?.status).toBe("succeeded");
    expect(await inbox()).toEqual([]);
  });

  it("removes the reset agent's stuck rows while retaining another agent's rows", async () => {
    const cid = "web-stuck-reset";
    await seed(cid);
    expect((await list(cid)).status).toBe(200);
    await runInDurableObject(env.DASHBOARD.get(env.DASHBOARD.idFromName("acme")), dashboard => dashboard.putStuck({ actionId: "other", agent: "second", conversationId: "other", tool: "test", label: "Other step", createdAt: 200, error: "unknown", requestedBy: null, source: "other" }));
    const pass = await signUserPass("test-dashboard-key-acme-0123456789abcdef", "acme", "staff", expiry(), "dashboard");
    const response = await SELF.fetch("https://brain/v1/agents/helper/reset", { method: "POST", headers: { ...auth, "x-dashboard-pass": pass }, body: "{}" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ done: true });
    expect(await inbox()).toMatchObject([{ agent: "second", actionId: "other" }]);
    expect((await saved(cid)).action).toBeUndefined();
  });
});
