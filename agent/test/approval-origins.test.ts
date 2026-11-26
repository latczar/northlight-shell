import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../src/contracts";
import { Dashboard, type Approval, type Card } from "../src/dashboard";
import { SLACK_USER } from "../src/slack";
import { Store } from "../src/store";
import { adminStuckStep } from "../src/stuck";
import { signUserPass } from "../src/user-auth";
import { readBackSentence } from "../src/voice";
import { TOOLS } from "../tools";

const auth = { authorization: "Bearer test-token-acme-0123456789abcdef", "content-type": "application/json" };
const beaconAuth = { authorization: "Bearer test-token-beacon-0123456789abcdef", "content-type": "application/json" };
const expires = () => Math.floor(Date.now() / 1000) + 3600;
const pass = (client: string, person: string, purpose: string) => signUserPass(`test-approver-key-${client}-0123456789abcdef`, client, person, expires(), purpose);
const dashboard = () => env.DASHBOARD.get(env.DASHBOARD.idFromName("acme"));
const conversation = (cid: string) => env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`acme/helper/${cid}`));
const refusal = { error: "Only the person who asked, or an admin, can decide this request." };

async function legacy(id: string, cid: string, userId?: string, owner = "acme", agent = "helper") {
  await dashboard().propose({ id, agent: "helper", conversationId: cid, tool: "create_record", title: "Legacy request", summary: "", previewJson: "{}" });
  await runInDurableObject(dashboard(), (_instance, state) => {
    state.storage.sql.exec("UPDATE approvals SET source = NULL, requested_by = NULL WHERE id = ?", id);
  });
  if (owner) await runInDurableObject(conversation(cid), (_instance, state) => {
    new Store(state.storage).bind(owner, agent, userId);
  });
}

async function decide(id: string, person: string, admin = false) {
  return SELF.fetch(`https://brain/v1/approvals/${id}`, {
    method: "POST", headers: { ...auth, [admin ? "x-admin-pass" : "x-approver-pass"]: await pass("acme", person, admin ? "admin" : "approve") },
    body: JSON.stringify({ decision: "decline" }),
  });
}

describe("voice approval origins", () => {
  it.each([
    { name: "signed app voice", client: "acme", cid: "voice-signed-person-1700000000000", signed: true, direct: false, source: "app", requestedBy: "signed-person" },
    { name: "signed turn with a job-like id", client: "acme", cid: "job-signed-voice", signed: true, direct: true, source: "app", requestedBy: "signed-person" },
    { name: "anonymous voice with a job-like id", client: "acme", cid: "job-anonymous-voice", signed: false, direct: false, source: "other", requestedBy: null },
    { name: "recorded phone call", client: "beacon", cid: "voice-signed-person-beacon-1700000000000", signed: true, direct: false, source: "phone", requestedBy: null },
  ] as const)("records the trusted ingress for $name", async ({ client, cid, signed, direct, source, requestedBy }) => {
    const agent = "helper";
    const toolName = "create_record";
    const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`${client}/${agent}/${cid}`));
    let executions = 0;
    const task = "Prepare a fixture";
    await runInDurableObject(stub, async instance => {
      const tool: ToolDefinition = {
        name: toolName, description: "Prepare a fixture.", permission: "dashboard.write", effect: "write", parallelSafe: false, timeoutMs: 5_000,
        parameters: { type: "object", properties: {}, additionalProperties: false },
        approval: () => ({ title: "Voice fixture", summary: "A confirmed voice request." }),
        execute: async () => { executions++; return { data: { done: true } }; },
      };
      instance.catalog = { ...TOOLS, [toolName]: tool };
      let step = 0;
      instance.model = { async turn(request) {
        if (step++ === 0) return {
          content: "", usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: [{ id: "proposal", type: "function", function: { name: "propose_change", arguments: JSON.stringify({ task, tool: toolName, args: {} }) } }],
        };
        const text = readBackSentence(task);
        request.onText?.(text);
        return { content: text, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      } };
      instance.slackPost = async () => true;
      if (client === "beacon") await instance.warm("Jess");
    });
    const headers = client === "acme" ? auth : beaconAuth;
    const userAuth = signed ? await signUserPass(`test-signing-key-${client}-0123456789abcdef`, client, "signed-person", expires()) : undefined;
    const say = async (text: string, messages: { role: "user" | "assistant"; content: string }[]) => direct ? new Response(await stub.turn({
      clientId: client, agentId: agent, conversationId: cid, userId: "signed-person", source: "other", voice: true,
      voiceStart: messages.length === 1, input: { id: `direct-${messages.length}`, text },
    })) : SELF.fetch("https://brain/v1/chat/completions", {
      method: "POST", headers, body: JSON.stringify({
        model: agent, messages,
        elevenlabs_extra_body: { conversation_id: cid, user_auth: userAuth, user_id: "victim" },
      }),
    });
    await (await say(task, [{ role: "user", content: task }])).text();
    const response = await say("Yes", [
      { role: "user", content: task },
      { role: "assistant", content: readBackSentence(task) },
      { role: "user", content: "Yes" },
    ]);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("waiting");
    const desk = env.DASHBOARD.get(env.DASHBOARD.idFromName(client));
    const records = JSON.parse(await desk.approvals("pending")).approvals as Approval[];
    const approval = records.find(record => record.conversationId === cid)!;
    expect(approval).toBeDefined();
    expect(approval).toMatchObject({ requestedBy, source });
    const bound = await runInDurableObject(stub, (_instance, state) => new Store(state.storage).meta("user"));
    expect(bound).toBe(client === "beacon" ? SLACK_USER : signed ? "signed-person" : "");
    await desk.setApprovers(Number.MAX_SAFE_INTEGER, { [agent]: ["signed-person", SLACK_USER] }, {});
    if (requestedBy === null) {
      for (const who of ["signed-person", SLACK_USER]) {
        const refused = await SELF.fetch(`https://brain/v1/approvals/${approval.id}`, {
          method: "POST", headers: { ...headers, "x-approver-pass": await pass(client, who, "approve") }, body: JSON.stringify({ decision: "approve" }),
        });
        expect(refused.status).toBe(403);
        expect(await refused.json()).toEqual(refusal);
      }
      expect(executions).toBe(0);
    }
    const decided = await SELF.fetch(`https://brain/v1/approvals/${approval.id}`, {
      method: "POST", headers: { ...headers, [requestedBy ? "x-approver-pass" : "x-admin-pass"]: await pass(client, requestedBy ?? "admin", requestedBy ? "approve" : "admin") },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(decided.status).toBe(200);
    expect(await decided.json()).toMatchObject({ status: "done", requestedBy, source });
    expect(executions).toBe(1);
    await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
  });

  it.each([
    ["signed-person", "app", "signed-person"],
    [SLACK_USER, "other", null],
    [undefined, "other", null],
  ] as const)("uses the same trusted-person rule for a voice stuck step bound to %s", (userId, source, requestedBy) => {
    expect(adminStuckStep({ actionId: "stuck-voice", agent: "helper", conversationId: "job-spoof-stuck", tool: "github_create_repo", label: "Create repo", createdAt: 1, error: "No reply" }, userId, "other"))
      .toMatchObject({ requestedBy, source });
  });
});

describe("legacy approval ownership", () => {
  it("resolves a misleading web id before a decision and refuses the named victim", async () => {
    await legacy("legacy-misleading", "web-victim", "actual-person");
    await dashboard().setApprovers(Number.MAX_SAFE_INTEGER, { helper: ["victim", "actual-person"] }, {});
    expect(JSON.parse((await dashboard().approvalJson("legacy-misleading"))!)).toMatchObject({ requestedBy: null });
    const refused = await decide("legacy-misleading", "victim");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual(refusal);
    expect(JSON.parse((await dashboard().approvalJson("legacy-misleading"))!)).toMatchObject({ status: "pending", requestedBy: "actual-person", source: "app" });
    const accepted = await decide("legacy-misleading", "actual-person");
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ status: "declined", decidedBy: "actual-person", requestedBy: "actual-person" });
  });

  it.each([
    ["unbound", undefined, "acme", "helper"],
    ["missing", undefined, "", "helper"],
    ["team", SLACK_USER, "acme", "helper"],
    ["foreign-client", "victim", "beacon", "helper"],
    ["foreign-agent", "victim", "acme", "second"],
  ] as const)("resolves a %s chat to no requester and refuses approvers", async (name, userId, owner, agent) => {
    const id = `legacy-${name}`;
    await legacy(id, `web-victim-${name}`, userId, owner, agent);
    await dashboard().setApprovers(Number.MAX_SAFE_INTEGER, { helper: ["victim", SLACK_USER] }, {});
    const response = await SELF.fetch(`https://brain/v1/approvals/${id}`, { headers: auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ requestedBy: null, source: "app" });
    const refused = await decide(id, "victim");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual(refusal);
    if (owner === "acme" && agent === "helper") {
      const accepted = await decide(id, "admin", true);
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({ status: "declined", requestedBy: null, decidedBy: "admin" });
    }
  });

  it.each([[undefined, "other", null], [SLACK_USER, "other", null], ["actual-person", "app", "actual-person"]] as const)("resolves legacy voice rows from the bound person %s, never the id", async (userId, source, requestedBy) => {
    const id = `legacy-voice-${userId ?? "unbound"}`;
    await legacy(id, `voice-victim-${userId ?? "unbound"}-1700000000000`, userId);
    const response = await SELF.fetch(`https://brain/v1/approvals/${id}`, { headers: auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ requestedBy, source });
  });

  it("resolves concurrent reads once and persists the origin across later reads and object instances", async () => {
    const cid = "web-victim-once";
    const id = "legacy-once";
    await legacy(id, cid, "original-person");
    let reads = 0;
    await runInDurableObject(conversation(cid), instance => {
      const prototype = Object.getPrototypeOf(instance) as typeof instance;
      const original = prototype.approvalOrigin;
      vi.spyOn(prototype, "approvalOrigin").mockImplementation(async function(this: typeof instance, ...args) { reads++; return original.apply(this, args); });
    });
    try {
      const responses = await Promise.all([
        SELF.fetch(`https://brain/v1/approvals/${id}`, { headers: auth }),
        SELF.fetch("https://brain/v1/approvals?status=pending", { headers: auth }),
        SELF.fetch("https://brain/v1/dashboard", { headers: auth }),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(200);
        await response.json();
      }
      expect(reads).toBe(1);
      await runInDurableObject(conversation(cid), (_instance, state) => new Store(state.storage).setMeta("user", "later-person"));
      const persisted = await runInDurableObject(dashboard(), async (_instance, state) => {
        expect(state.storage.sql.exec("SELECT requested_by, source FROM approvals WHERE id = ?", id).one()).toEqual({ requested_by: "original-person", source: "app" });
        return new Dashboard(state, env).approvalJson(id, "acme");
      });
      expect(JSON.parse(persisted!)).toMatchObject({ requestedBy: "original-person", source: "app" });
      expect(reads).toBe(1);
    } finally {
      await runInDurableObject(conversation(cid), instance => vi.mocked((Object.getPrototypeOf(instance) as typeof instance).approvalOrigin).mockRestore());
    }
  });

  it("resolves approval-card metadata for dashboard and card reads without adding fields to ordinary cards", async () => {
    const id = "legacy-card";
    await legacy(id, "web-victim-card", "card-person");
    await dashboard().post({ id: "ordinary-report", agent: "helper", kind: "report", title: "Shared report", summary: "", dataJson: "{}", conversationId: "web-victim-card" });
    const response = await SELF.fetch("https://brain/v1/dashboard", { headers: auth });
    expect(response.status).toBe(200);
    const cards = (await response.json() as { cards: Card[] }).cards;
    expect(cards.find(card => card.id === `approval-${id}`)).toMatchObject({ requestedBy: "card-person", source: "app" });
    const report = cards.find(card => card.id === "ordinary-report")!;
    expect(report).toBeDefined();
    expect(Object.hasOwn(report, "requestedBy")).toBe(false);
    expect(Object.hasOwn(report, "source")).toBe(false);
    expect(await dashboard().get(`approval-${id}`, "acme")).toMatchObject({ requestedBy: "card-person", source: "app" });
    const accepted = await decide(id, "admin", true);
    expect(accepted.status).toBe(200);
    expect(await dashboard().get(`approval-${id}`)).toMatchObject({ kind: "status", requestedBy: "card-person", source: "app" });
    const listed = await SELF.fetch("https://brain/v1/approvals?status=declined", { headers: auth });
    expect(listed.status).toBe(200);
    expect((await listed.json() as { approvals: Approval[] }).approvals).toContainEqual(expect.objectContaining({ id, requestedBy: "card-person", source: "app" }));
  });
});

describe("trusted ingress boundaries", () => {
  it.each(["job-x", "slack-x", "phone-x", "voice-other-person-123", "voice-signed-person"])("refuses a signed voice pass paired with %s before any turn runs", async cid => {
    let calls = 0;
    await runInDurableObject(conversation(cid), instance => {
      instance.model = { async turn() { calls++; throw new Error("A refused request must not run."); } };
    });
    const response = await SELF.fetch("https://brain/v1/chat/completions", {
      method: "POST", headers: auth, body: JSON.stringify({
        model: "helper", messages: [{ role: "user", content: "Do something" }],
        elevenlabs_extra_body: { conversation_id: cid, user_auth: await signUserPass("test-signing-key-acme-0123456789abcdef", "acme", "signed-person", expires()) },
      }),
    });
    expect(response.status).toBe(400);
    expect(calls).toBe(0);
    expect(await runInDurableObject(conversation(cid), (_instance, state) => new Store(state.storage).meta("owner"))).toBeUndefined();
  });

  it("keeps the phone channel when a call hands work to a background job", async () => {
    const cid = "job-phone-handover";
    const name = `beacon/helper/${cid}`;
    const call = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(name));
    const background = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`${name}-job-1`));
    await runInDurableObject(call, (instance, state) => {
      instance.slackPost = async () => true;
      const store = new Store(state.storage);
      const task = "Prepare a calendar request";
      store.append({ role: "user", content: task });
      const after = store.append({ role: "assistant", content: readBackSentence(task) });
      store.setMeta("pendingChange", JSON.stringify({ task, after, at: Date.now() }));
    });
    await runInDurableObject(background, instance => {
      const tool: ToolDefinition = {
        name: "create_record", description: "Background fixture.", permission: "dashboard.write", effect: "write", parallelSafe: false, timeoutMs: 5_000,
        parameters: { type: "object", properties: {}, additionalProperties: false },
        approval: () => ({ title: "Phone job request", summary: "A handed-over request." }),
        execute: async () => { throw new Error("Must not run before approval."); },
      };
      instance.catalog = { ...TOOLS, create_record: tool };
      instance.slackPost = async () => true;
      let step = 0;
      instance.model = { async turn() {
        return step++ === 0
          ? { content: "", toolCalls: [{ id: "phone-job-origin", type: "function", function: { name: "create_record", arguments: "{}" } }], usage: { inputTokens: 1, outputTokens: 1 } }
          : { content: "Waiting for approval.", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      } };
    });
    try {
      await new Response(await call.turn({ clientId: "beacon", agentId: "helper", conversationId: cid, userId: SLACK_USER, source: "phone", caller: "Jess", voice: true, input: { id: "handover-yes", text: "Yes" } })).text();
      await vi.waitFor(async () => {
        const desk = env.DASHBOARD.get(env.DASHBOARD.idFromName("beacon"));
        if (!await desk.approvalJson("phone-job-origin")) await runInDurableObject(background, instance => instance.alarm());
        expect(JSON.parse((await desk.approvalJson("phone-job-origin")) ?? "null")).toMatchObject({ source: "phone", requestedBy: null, status: "pending" });
      }, { timeout: 8_000 });
    } finally {
      await runInDurableObject(call, (_instance, state) => state.storage.deleteAlarm());
      await runInDurableObject(background, (_instance, state) => state.storage.deleteAlarm());
    }
  });

  it("keeps approval and dashboard lists available when one legacy lookup fails, without granting its requester rights", async () => {
    const cid = "web-private-lookup-failure";
    const id = "legacy-lookup-failure";
    await legacy(id, cid, "lookup-owner");
    await legacy("legacy-lookup-healthy", "web-private-lookup-healthy", "healthy-owner");
    await dashboard().setApprovers(Number.MAX_SAFE_INTEGER, { helper: ["lookup-owner"] }, {});
    await runInDurableObject(conversation(cid), instance => {
      const prototype = Object.getPrototypeOf(instance) as typeof instance;
      const original = prototype.approvalOrigin;
      vi.spyOn(prototype, "approvalOrigin").mockImplementation(async function(this: typeof instance, ...args) {
        if (args[2] === cid) throw new TypeError("Private provider details must not be logged.");
        return original.apply(this, args);
      });
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const list = await SELF.fetch("https://brain/v1/approvals?status=pending", { headers: auth });
      expect(list.status).toBe(200);
      const approvals = (await list.json() as { approvals: Approval[] }).approvals;
      expect(approvals.find(approval => approval.id === id)).toMatchObject({ requestedBy: null, status: "pending" });
      expect(approvals.find(approval => approval.id === "legacy-lookup-healthy")).toMatchObject({ requestedBy: "healthy-owner", source: "app" });
      const response = await SELF.fetch("https://brain/v1/dashboard", { headers: auth });
      expect(response.status).toBe(200);
      const cards = (await response.json() as { cards: Card[] }).cards;
      expect(cards.find(card => card.id === `approval-${id}`)).toMatchObject({ requestedBy: null });
      expect(cards.find(card => card.id === "approval-legacy-lookup-healthy")).toMatchObject({ requestedBy: "healthy-owner" });
      expect(await runInDurableObject(dashboard(), (_instance, state) =>
        state.storage.sql.exec("SELECT source, requested_by FROM approvals WHERE id = ?", id).one())).toEqual({ source: null, requested_by: null });
      const refused = await decide(id, "lookup-owner");
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual(refusal);
      const accepted = await decide(id, "admin", true);
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({ status: "declined", requestedBy: null, decidedBy: "admin" });
      expect(logged.mock.calls.length).toBeGreaterThan(0);
      expect(logged.mock.calls).toEqual(logged.mock.calls.map(() => ["TypeError"]));
    } finally {
      logged.mockRestore();
      await runInDurableObject(conversation(cid), instance => vi.mocked((Object.getPrototypeOf(instance) as typeof instance).approvalOrigin).mockRestore());
    }
  });
});
