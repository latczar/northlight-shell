import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation, Env } from "../src/conversation";
import type { Dashboard } from "../src/dashboard";
import worker from "../src/index";
import { newJob, saveJob } from "../src/jobs";
import { Store } from "../src/store";
import { signUserPass } from "../src/user-auth";

const auth = { authorization: "Bearer test-token-acme-0123456789abcdef", "content-type": "application/json" };
const pass = (person = "alice") => signUserPass("test-signing-key-acme-0123456789abcdef", "acme", person, Math.floor(Date.now() / 1000) + 3600);
const stub = (cid: string) => env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`acme/helper/${cid}`));
const dashboard = env.DASHBOARD.get(env.DASHBOARD.idFromName("acme"));

beforeEach(async () => {
  await runInDurableObject(dashboard, (_instance, state) => state.storage.sql.exec("DELETE FROM conversations"));
});

async function seedCall(cid: string) {
  await runInDurableObject(stub(cid), (_instance, state) => {
    const store = new Store(state.storage);
    store.bind("acme", "helper", "alice");
    store.setMeta("appCallStartedAt", String(Date.now()));
    store.setMeta("appCallActivityAt", String(Date.now()));
  });
  await dashboard.registerAppCall("helper", cid, "alice", Date.now());
}

async function status() {
  const response = await SELF.fetch("https://brain/v1/agents/helper/calls", { headers: { ...auth, "x-user-pass": await pass() } });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ calls: { conversationId: string; jobs: { conversationId: string; status: string; error?: string }[] }[] }>;
}

async function speak(cid: string, text: string) {
  const response = await SELF.fetch("https://brain/v1/chat/completions", {
    method: "POST", headers: auth, body: JSON.stringify({ model: "helper", messages: [{ role: "user", content: text }],
      elevenlabs_extra_body: { conversation_id: cid, user_auth: await pass() } }),
  });
  const body = await response.text();
  return { status: response.status, body };
}

describe("call status hardening", () => {
  it("omits a stopped job's spoken text error while retaining runtime failed errors", async () => {
    const cid = "voice-alice-stopped-private";
    await seedCall(cid);
    await runInDurableObject(stub(cid), (_instance, state) => {
      const store = new Store(state.storage);
      saveJob(store, { ...newJob({ id: "stopped", text: "Private request" }, 0), status: "stopped", error: "Private spoken answer. I stopped because of a limit." });
      store.setMeta("callJobs", "1");
      store.setMeta("callJobConversations", JSON.stringify([`${cid}-job-1`]));
    });
    await runInDurableObject(stub(`${cid}-job-1`), async (instance, state) => {
      const store = new Store(state.storage);
      store.bind("acme", "helper", "alice");
      store.setMeta("conversation", `${cid}-job-1`);
      instance.model = { async turn() { throw new TypeError("Private provider payload"); } };
      saveJob(store, newJob({ id: "failed", text: "Private job task" }, 0));
      await instance.alarm();
      await state.storage.deleteAlarm();
    });
    const { calls } = await status();
    expect(calls[0].jobs[0]).toMatchObject({ status: "stopped" });
    expect(calls[0].jobs[0]).not.toHaveProperty("error");
    expect(calls[0].jobs[1]).toMatchObject({ status: "failed", error: "I hit a problem: something went wrong. Ask me to try again." });
    expect(JSON.stringify(calls)).not.toContain("Private");
  });

  it("answers a voice turn despite dashboard registration failure and retries registration on the next turn", async () => {
    const cid = "voice-alice-register-failure";
    let registrations = 0;
    await runInDurableObject(dashboard, instance => {
      const prototype = Object.getPrototypeOf(instance) as Dashboard;
      const original = prototype.registerAppCall;
      vi.spyOn(prototype, "registerAppCall").mockImplementation(async function (this: Dashboard, ...args) {
        registrations++;
        if (registrations === 1) throw new Error("Dashboard unavailable");
        return original.apply(this, args);
      });
    });
    await runInDurableObject(stub(cid), instance => {
      instance.model = { async turn(request) {
        request.onText?.("Still answering normally");
        return { content: "Still answering normally", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      } };
    });
    try {
      const first = await speak(cid, "Hello");
      expect(first.status).toBe(200);
      expect(first.body).toContain("Still answering normally");
      expect(await runInDurableObject(stub(cid), (_instance, state) => new Store(state.storage).meta("appCallRegistered"))).toBeUndefined();
      expect((await speak(cid, "Another question")).status).toBe(200);
      await vi.waitFor(async () => expect(await runInDurableObject(stub(cid), (_instance, state) => new Store(state.storage).meta("appCallRegistered"))).toBe("1"));
      expect(registrations).toBe(2);
    } finally {
      await runInDurableObject(dashboard, instance => vi.mocked((Object.getPrototypeOf(instance) as Dashboard).registerAppCall).mockRestore());
      await runInDurableObject(stub(cid), (_instance, state) => state.storage.deleteAlarm());
    }
  });

  it("registers a successful call only once across voice turns", async () => {
    const cid = "voice-alice-register-once";
    let registrations = 0;
    await runInDurableObject(dashboard, instance => {
      const prototype = Object.getPrototypeOf(instance) as Dashboard;
      const original = prototype.registerAppCall;
      vi.spyOn(prototype, "registerAppCall").mockImplementation(async function (this: Dashboard, ...args) { registrations++; return original.apply(this, args); });
    });
    await runInDurableObject(stub(cid), instance => {
      instance.model = { async turn() { return { content: "Hello", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }; } };
    });
    try {
      expect((await speak(cid, "First turn")).status).toBe(200);
      // A status read observes the background registration without making the reply wait for it.
      await vi.waitFor(async () => expect((await status()).calls.some(call => call.conversationId === cid)).toBe(true));
      expect((await speak(cid, "Second turn")).status).toBe(200);
      expect(registrations).toBe(1);
    } finally {
      await runInDurableObject(dashboard, instance => vi.mocked((Object.getPrototypeOf(instance) as Dashboard).registerAppCall).mockRestore());
      await runInDurableObject(stub(cid), (_instance, state) => state.storage.deleteAlarm());
    }
  });

  it("reads only successfully started child ids recorded by the call, not allocated job slots", async () => {
    const cid = "voice-alice-sparse-children";
    await seedCall(cid);
    await runInDurableObject(stub(cid), (_instance, state) => {
      const store = new Store(state.storage);
      store.setMeta("callJobs", "10");
      store.setMeta("callJobConversations", JSON.stringify([`${cid}-job-2`]));
    });
    await runInDurableObject(stub(`${cid}-job-2`), (_instance, state) => {
      const store = new Store(state.storage);
      store.bind("acme", "helper", "alice");
      saveJob(store, { ...newJob({ id: "child", text: "Private input" }, 0), status: "done" });
    });
    let unstartedReads = 0;
    await runInDurableObject(stub(`${cid}-job-1`), instance => {
      const prototype = Object.getPrototypeOf(instance) as Conversation;
      const original = prototype.callJobState;
      vi.spyOn(prototype, "callJobState").mockImplementation(async function (this: Conversation, ...args) {
        if (this === instance) { unstartedReads++; throw new Error("Unstarted child must not be read"); }
        return original.apply(this, args);
      });
    });
    try {
      const { calls } = await status();
      expect(calls[0].jobs.map(job => job.conversationId)).toEqual([`${cid}-job-2`]);
      expect(unstartedReads).toBe(0);
    } finally {
      await runInDurableObject(stub(`${cid}-job-1`), instance => vi.mocked((Object.getPrototypeOf(instance) as Conversation).callJobState).mockRestore());
    }
  });

  it("limits one signed person's tabs without consuming the shared allowance or blocking another person", async () => {
    const shared = vi.fn(async () => ({ success: true }));
    const client = vi.fn(async () => ({ success: false }));
    const person = vi.fn(async ({ key }: { key: string }) => ({ success: key !== "acme/alice" }));
    const bindings = { ...env, STATUS_LIMITER: { limit: shared }, STATUS_PERSON_LIMITER: { limit: person }, CLIENT_LIMITER: { limit: client } } as unknown as Env;
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const blocked = await worker.fetch(new Request("https://brain/v1/agents/helper/calls", { headers: { ...auth, "x-user-pass": await pass("alice") } }), bindings, ctx);
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: "Too many requests" });
    expect(shared).not.toHaveBeenCalled();
    const allowed = await worker.fetch(new Request("https://brain/v1/agents/helper/calls", { headers: { ...auth, "x-user-pass": await pass("bob") } }), bindings, ctx);
    expect(allowed.status).toBe(200);
    expect(person.mock.calls).toEqual([[{ key: "acme/alice" }], [{ key: "acme/bob" }]]);
    expect(shared).toHaveBeenCalledExactlyOnceWith({ key: "acme" });
    expect(client).not.toHaveBeenCalled();
  });

  it("skips one unreadable call while listing the other readable calls", async () => {
    const broken = "voice-alice-unreadable";
    const good = "voice-alice-readable";
    await seedCall(broken);
    await seedCall(good);
    await runInDurableObject(stub(broken), instance => {
      const prototype = Object.getPrototypeOf(instance) as Conversation;
      const original = prototype.callState;
      vi.spyOn(prototype, "callState").mockImplementation(async function (this: Conversation, ...args) {
        if (this === instance) throw new Error("Call state unavailable");
        return original.apply(this, args);
      });
    });
    try {
      expect((await status()).calls.map(call => call.conversationId)).toEqual([good]);
    } finally {
      await runInDurableObject(stub(broken), instance => vi.mocked((Object.getPrototypeOf(instance) as Conversation).callState).mockRestore());
    }
  });
});
