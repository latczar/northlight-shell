import { createExecutionContext, env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENTS, SETUP } from "../agents";
import { CLIENTS } from "../clients";
import type { JsonObject, SetupItem, ToolDefinition } from "../src/contracts";
import { runTurn } from "../src/loop";
import type { ModelAdapter } from "../src/model";
import { agentSettings } from "../src/settings";
import { isReady } from "../src/setup";
import { Store } from "../src/store";
import { testDeskApi } from "./desk";
import { signUserPass } from "../src/user-auth";
import { allowApprover, APPROVER } from "./access";
import { TOOLS } from "../tools";
import worker from "../src/index";
import type { Env } from "../src/conversation";

afterEach(() => { vi.restoreAllMocks(); });

const auth = { authorization: "Bearer test-token-acme-0123456789abcdef", "content-type": "application/json" };
const beaconAuth = { authorization: "Bearer test-token-beacon-0123456789abcdef", "content-type": "application/json" };
// Third's panel cases run on Beacon's Third (blank defaults); Acme Test Co has its own Third with its own settings.
const clientFor = (agent: string) => CLIENTS.find(client => client.agents.includes(agent) && (agent !== "third" || client.id === "beacon"))!;
const headersFor = (agent: string) => agent === "third" ? beaconAuth : auth;
const usage = { inputTokens: 5, outputTokens: 2 };
const APPROVER_KEY = "test-approver-key-acme-0123456789abcdef";
beforeEach(async () => {
  await allowApprover();
  await env.DASHBOARD.get(env.DASHBOARD.idFromName("beacon")).setApprovers(Number.MAX_SAFE_INTEGER, { third: [APPROVER] }, { third: [APPROVER] });
});
const pass = (who = APPROVER, key = APPROVER_KEY, purpose = "approve", client = "acme") => signUserPass(key, client, who, Math.floor(Date.now() / 1000) + 3600, purpose);

// The worker under test reads these same bindings, so setting one here is what a deployed secret looks like.
const secrets = env as unknown as Record<string, unknown>;
const get = (path: string) => SELF.fetch(`https://brain/v1/agents/${path}`, { headers: headersFor(path.split("/")[0]) });
const put = async (agent: string, settings: unknown, approverPass?: string | null) => SELF.fetch(`https://brain/v1/agents/${agent}/settings`, {
  method: "PUT", headers: { ...headersFor(agent), ...(approverPass === null ? {} : { "x-approver-pass": approverPass ?? await pass(APPROVER, `test-approver-key-${clientFor(agent).id}-0123456789abcdef`, "approve", clientFor(agent).id) }) }, body: JSON.stringify({ settings }),
});
const snapshots = async (agent: string) => (await (await get(`${agent}/data`)).json() as { snapshots: Record<string, { at: number; data: unknown }> }).snapshots;

describe("GET /v1/agents/:agent/setup", () => {
  const kestrel = CLIENTS.find(c => c.id === "kestrel")!;
  const kestrelAuth = { authorization: "Bearer test-token-kestrel-0123456789abcdef" };
  it("lists what each agent needs by name, never a value", async () => {
    const body = await (await SELF.fetch("https://brain/v1/agents/iris/setup", { headers: kestrelAuth })).text();
    const { ready, items } = JSON.parse(body) as { ready: boolean; items: { id: string; kind: string; connected: boolean; missing: string[]; optional?: boolean }[] };
    expect(ready).toBe(true);
    expect(items.find(i => i.id === "website")).toMatchObject({ kind: "setting", connected: true, missing: [] });
    // Iris needs only its website: no GitHub or other keys
    expect(items.map(i => i.id)).toEqual(["website"]);
  });

  it("flips an item to connected once every env var it names is set", () => {
    const setup = (names: string[], settings = kestrel.agentSettings!.iris) => SETUP.iris({ clientId: "kestrel", settings,
      connections: kestrel.connections?.filter(c => c.agents.includes("iris")), has: name => names.includes(name) });
    expect(setup([]).find(i => i.id === "website")).toMatchObject({ connected: true, missing: [] });
    expect(setup([], { ...kestrel.agentSettings!.iris, site: "" }).find(i => i.id === "website")).toMatchObject({ connected: false, missing: ["site"] });
  });

  it("follows the effective settings: Third's items flip when staff save them, and optional items do not block ready", async () => {
    const before = await (await get("third/setup")).json() as { items: { id: string; connected: boolean; missing: string[]; optional?: boolean }[] };
    expect(before.items.find(i => i.id === "site")).toMatchObject({ kind: "setting", connected: false, missing: ["site"] });
    expect((await put("third", { site: "https://www.example.com" })).status).toBe(200);
    const after = await (await get("third/setup")).json() as { items: { id: string; connected: boolean; missing: string[] }[] };
    expect(after.items.find(i => i.id === "site")?.connected).toBe(true);
    expect(after.items.find(i => i.id === "search")?.missing).toEqual(["THIRD_SEARCH_KEY"]);
    expect(isReady([{ id: "a", label: "", kind: "secret", connected: false, missing: ["X"], unlocks: "", optional: true }])).toBe(true);
  });

  it("is 404 for an unknown agent and for another client's agent", async () => {
    for (const path of ["iris/setup", "iris/data", "iris/settings", "nobody/setup"]) {
      expect((await SELF.fetch(`https://brain/v1/agents/${path}`, { headers: auth })).status).toBe(404);
    }
    expect((await SELF.fetch("https://brain/v1/agents/helper/setup")).status).toBe(401);
  });
});

/** A test tool that opts in to a snapshot, run by Helper (who has a permission Acme Test Co really has). */
const tool = (name: string, data: JsonObject, extra: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name, description: name, parameters: { type: "object", properties: {}, additionalProperties: false }, permission: "dashboard.write",
  effect: "read", parallelSafe: false, timeoutMs: 5_000, execute: async () => ({ data }), ...extra,
});

async function runTools(conversationId: string, catalog: Record<string, ToolDefinition>, names: string[]) {
  const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`acme/second/${conversationId}`));
  await runInDurableObject(stub, async (_instance, state) => {
    let step = 0;
    const model: ModelAdapter = {
      async turn() {
        return step++ === 0
          ? { content: "", toolCalls: names.map(name => ({ id: `${conversationId}-${name}`, type: "function" as const, function: { name, arguments: "{}" } })), usage }
          : { content: "ok", toolCalls: [], usage };
      },
    };
    const store = new Store(state.storage);
    store.bind("acme", "second");
    await runTurn({
      store, model, client: CLIENTS.find(c => c.id === "acme")!, agent: { ...AGENTS.second, tools: names }, catalog, conversationId, bindings: env, desk: testDeskApi(), modelKey: () => "key", emit: () => {},
    }, { id: "m1", text: "go" });
  });
}

describe("snapshots", () => {
  it("are saved after a successful, connected result, and merged with the previous one", async () => {
    const counter = tool("snap_count", { connected: true, n: 1 }, {
      snapshots: [{ kind: "snap_merged", merge: (previous, data) => [...(Array.isArray(previous) ? previous : []), data.n] }],
    });
    const plain = tool("snap_plain", { connected: true, value: "last good" }, { snapshots: [{ kind: "snap_plain" }] });
    await runTools("snap-ok-1", { snap_count: counter, snap_plain: plain }, ["snap_count", "snap_plain"]);
    await runTools("snap-ok-2", { snap_count: counter }, ["snap_count"]);
    const saved = await snapshots("second");
    expect(saved.snap_merged.data).toEqual([1, 1]);
    expect(saved.snap_plain.data).toEqual({ connected: true, value: "last good" });
    expect(saved.snap_plain.at).toBeGreaterThan(Date.now() - 60_000);
  });

  it("are not saved when the tool says it is not connected, fails, or merge declines", async () => {
    const off = tool("snap_off", { connected: false, missing: ["X"] }, { snapshots: [{ kind: "snap_off" }] });
    const failing = tool("snap_fail", {}, { snapshots: [{ kind: "snap_fail" }], execute: async () => { throw new Error("boom"); } });
    const declined = tool("snap_declined", { connected: true }, { snapshots: [{ kind: "snap_declined", merge: () => undefined }] });
    await runTools("snap-off-1", { snap_off: off, snap_fail: failing, snap_declined: declined }, ["snap_off", "snap_fail", "snap_declined"]);
    const saved = await snapshots("second");
    expect(saved).not.toHaveProperty("snap_off");
    expect(saved).not.toHaveProperty("snap_fail");
    expect(saved).not.toHaveProperty("snap_declined");
  });

  it("are not saved while the tool waits for approval", async () => {
    const gated = tool("snap_gated", { connected: true }, { effect: "write", snapshots: [{ kind: "snap_gated" }], approval: () => ({ title: "t", summary: "s" }) });
    await runTools("snap-gated-1", { snap_gated: gated }, ["snap_gated"]);
    expect(await snapshots("second")).not.toHaveProperty("snap_gated");
  });

});

describe("settings", () => {
  it("lists the editable keys with their effective values", async () => {
    const view = await (await get("third/settings")).json() as { agent: string; settings: Record<string, unknown>; editable: { key: string; type: string; choices?: string[] }[] };
    expect(view.agent).toBe("third");
    expect(view.editable.map(e => e.key)).toEqual(["site", "competitors", "blogsPerMonth", "publishStatus"]);
    expect(view.editable.find(e => e.key === "publishStatus")).toMatchObject({ type: "choice", choices: ["draft", "publish"] });
    // Internal settings (env names, field slugs) are not part of the view.
    expect(Object.keys(view.settings)).toEqual(view.editable.map(e => e.key));
    expect(((await (await get("helper/settings")).json()) as { editable: unknown[] }).editable).toEqual([]);
  });

  it("refuses a missing, forged or wrong-purpose pass, and anyone who is not an approver", async () => {
    expect((await put("third", { blogsPerMonth: 9 }, null)).status).toBe(401);
    expect((await put("third", { blogsPerMonth: 9 }, "not-a-pass")).status).toBe(401);
    expect((await put("third", { blogsPerMonth: 9 }, await pass(APPROVER, "x".repeat(40)))).status).toBe(401);
    expect((await put("third", { blogsPerMonth: 9 }, await pass(APPROVER, APPROVER_KEY, "dashboard"))).status).toBe(401);
    expect((await put("third", { blogsPerMonth: 9 }, await pass("someone-else", "test-approver-key-beacon-0123456789abcdef", "approve", "beacon"))).status).toBe(403);
    expect((await put("iris", { blogsPerMonth: 9 })).status).toBe(404);
    const view = await (await get("third/settings")).json() as { settings: { blogsPerMonth: number } };
    expect(view.settings.blogsPerMonth).toBe(4);
  });

  it("refuses keys that are not editable and values of the wrong type, naming the field", async () => {
    const bad: [string, unknown, string][] = [
      ["third", { timezone: "UTC" }, "timezone"],
      ["third", { wordpress: { userEnv: "X" } }, "wordpress"],
      ["third", { site: "http://www.example.com" }, "site"],
      ["third", { site: "not a url" }, "site"],
      ["third", { site: 5 }, "site"],
      ["third", { blogsPerMonth: 31 }, "blogsPerMonth"],
      ["third", { blogsPerMonth: -1 }, "blogsPerMonth"],
      ["third", { blogsPerMonth: "4" }, "blogsPerMonth"],
      ["third", { competitors: Array.from({ length: 21 }, (_, i) => `c${i}.com`) }, "competitors"],
      ["third", { competitors: ["x".repeat(201)] }, "competitors"],
      ["third", { publishStatus: "live" }, "publishStatus"],
      ["helper", { anything: "x" }, "anything"],
      ["second", { adsTimezone: "UTC" }, "adsTimezone"],
    ];
    for (const [agent, settings, field] of bad) {
      const response = await put(agent, settings);
      expect(response.status, JSON.stringify(settings)).toBe(400);
      expect(await response.json()).toMatchObject({ error: expect.any(String), field });
    }
    for (const body of [{}, [], "x", null]) expect((await put("third", body)).status).toBe(400);
    // One bad key rejects the whole save.
    expect((await put("third", { blogsPerMonth: 9, publishStatus: "live" })).status).toBe(400);
    expect(((await (await get("third/settings")).json()) as { settings: { blogsPerMonth: number } }).settings.blogsPerMonth).toBe(4);
  });

  it("merges a valid save into what is stored, and the tools see it on the next turn", async () => {
    const saved = await put("third", { blogsPerMonth: 7 });
    expect(saved.status).toBe(200);
    expect((await (await put("third", { competitors: ["  Rival.com ", ""] })).json() as { settings: JsonObject }).settings).toMatchObject({ blogsPerMonth: 7, competitors: ["Rival.com"] });

    expect((await put("third", { site: "https://www.example.com" })).status).toBe(200);

    // my_setup reads the effective settings the turn was given: the saved site makes the site item connected.
    const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName("beacon/third/settings-seen"));
    let seen = "";
    await runInDurableObject(stub, instance => {
      let step = 0;
      instance.model = {
        async turn(request) {
          if (step++ === 0) return { content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "my_setup", arguments: "{}" } }], usage };
          seen = String(request.messages.at(-1)?.content);
          return { content: "ok", toolCalls: [], usage };
        },
      } satisfies ModelAdapter;
    });
    const chat = await SELF.fetch("https://brain/v1/agents/third/conversations/settings-seen/messages", { method: "POST", headers: beaconAuth, body: JSON.stringify({ id: "m1", text: "status?" }) });
    await chat.text();
    expect(JSON.parse(seen).result.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: "site", connected: true })]));
  });

  it("only lets PUT reach the settings route", async () => {
    expect((await SELF.fetch("https://brain/v1/agents/third/setup", { method: "PUT", headers: beaconAuth, body: "{}" })).status).toBe(405);
    expect((await SELF.fetch("https://brain/v1/approvals/x", { method: "PUT", headers: auth, body: "{}" })).status).toBe(405);
  });
});

describe("dashboard storage", () => {
  it("indexes the tables the dashboard reads by agent, conversation and status", async () => {
    const stub = env.DASHBOARD.get(env.DASHBOARD.idFromName("acme"));
    const indexes = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.sql.exec<{ name: string; tbl_name: string }>("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").toArray());
    expect(indexes).toEqual(expect.arrayContaining([
      { name: "cards_agent_updated", tbl_name: "cards" }, { name: "cards_conversation", tbl_name: "cards" }, { name: "approvals_status_created", tbl_name: "approvals" },
    ]));
  });
});

describe("approvals when settings change after the proposal", () => {
  // Each real run leaves a marker, so runs can be counted. The tool reads a setting, like Third's publish_blog does.
  const publish: ToolDefinition = {
    name: "test_settings_publish", description: "Publish.", permission: "dashboard.write", effect: "write", parallelSafe: false, timeoutMs: 5_000,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    approval: () => ({ title: "Publish a post", summary: "A post." }),
    async execute(context) {
      await context.bindings.IMAGES.put(`test-runs/${context.actionId}/${crypto.randomUUID()}`, "1");
      return { data: { site: context.settings.site ?? null } };
    },
  };
  const catalog = { ...TOOLS, test_settings_publish: publish };
  const runs = async (id: string) => (await env.IMAGES.list({ prefix: `test-runs/${id}/` })).objects.length;
  let blogs = 10;

  /** The agent proposes the tool in a fresh conversation, with the settings the route would give it. */
  async function propose(agent: "third" | "helper", conversationId: string): Promise<string> {
    const client = clientFor(agent);
    const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`${client.id}/${agent}/${conversationId}`));
    await runInDurableObject(stub, async (instance, state) => {
      instance.catalog = catalog;
      let step = 0;
      const model: ModelAdapter = {
        async turn() {
          return step++ === 0
            ? { content: "", toolCalls: [{ id: `call-${conversationId}`, type: "function", function: { name: "test_settings_publish", arguments: "{}" } }], usage }
            : { content: "waiting", toolCalls: [], usage };
        },
      };
      const store = new Store(state.storage);
      store.bind(client.id, agent);
      await runTurn({
        store, model, client, agent: { ...AGENTS[agent], tools: [...AGENTS[agent].tools, "test_settings_publish"] }, catalog, conversationId,
        bindings: env, settings: await agentSettings(env, client, agent), desk: testDeskApi(), modelKey: () => "key", emit: () => {},
      }, { id: "m1", text: "publish it" });
    });
    return `call-${conversationId}`;
  }

  const approvalAgent = (id: string) => id === "call-drift-4" ? "helper" : "third";
  const decide = async (id: string, decision: "approve" | "decline") => SELF.fetch(`https://brain/v1/approvals/${id}`, {
    method: "POST", headers: { ...headersFor(approvalAgent(id)), "x-admin-pass": await pass(APPROVER, `test-approver-key-${clientFor(approvalAgent(id)).id}-0123456789abcdef`, "admin", clientFor(approvalAgent(id)).id) }, body: JSON.stringify({ decision }),
  });
  const approval = async (id: string) => (await (await SELF.fetch(`https://brain/v1/approvals/${id}`, { headers: headersFor(approvalAgent(id)) })).json()) as { status: string; result?: { error?: string } };

  async function useCatalog(agent: string, conversationId: string) {
    const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`${clientFor(agent).id}/${agent}/${conversationId}`));
    await runInDurableObject(stub, instance => { instance.catalog = catalog; });
  }

  it("refuses to run an approval whose settings changed, tells the agent, and closes the approval", async () => {
    const id = await propose("third", "drift-1");
    expect((await put("third", { blogsPerMonth: ++blogs })).status).toBe(200);
    await useCatalog("third", "drift-1");
    const response = await decide(id, "approve");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ id, status: "failed", error: "Settings changed since this was proposed; ask the agent to propose it again." });
    expect(await runs(id)).toBe(0);
    expect(await approval(id)).toMatchObject({ status: "failed", result: { error: expect.stringContaining("Settings changed") } });
    const cards = await (await SELF.fetch("https://brain/v1/dashboard", { headers: beaconAuth })).json() as { cards: { id: string; kind: string; title: string }[] };
    expect(cards.cards.find(c => c.id === `approval-${id}`)).toMatchObject({ kind: "alert", title: "Failed: Publish a post" });
    // The agent's conversation got the runtime note, and asking again does not run it either.
    const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName("beacon/third/drift-1"));
    const notes = await runInDurableObject(stub, async (_instance, state) => state.storage.sql.exec<{ body: string }>("SELECT body FROM messages").toArray().map(r => r.body).join("\n"));
    expect(notes).toContain("Settings changed since this was proposed");
    expect((await decide(id, "approve")).status).toBe(200);
    expect(await runs(id)).toBe(0);
  });

  it("still lets a person decline it", async () => {
    const id = await propose("third", "drift-2");
    await env.DASHBOARD.get(env.DASHBOARD.idFromName("beacon")).saveSettings("third", JSON.stringify({ blogsPerMonth: ++blogs }));
    expect((await decide(id, "decline")).status).toBe(200);
    expect(await approval(id)).toMatchObject({ status: "declined" });
    expect(await runs(id)).toBe(0);
  });

  it("runs once when the settings did not change", async () => {
    const id = await propose("third", "drift-3");
    await useCatalog("third", "drift-3");
    const response = await decide(id, "approve");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "done" });
    expect(await runs(id)).toBe(1);
    expect((await decide(id, "approve")).status).toBe(200);
    expect(await runs(id)).toBe(1);
  });

  it("is not blocked by a settings change for another agent", async () => {
    const id = await propose("helper", "drift-4");
    await env.DASHBOARD.get(env.DASHBOARD.idFromName("beacon")).saveSettings("third", JSON.stringify({ blogsPerMonth: ++blogs }));
    await useCatalog("helper", "drift-4");
    expect((await decide(id, "approve")).status).toBe(200);
    expect(await approval(id)).toMatchObject({ status: "done" });
    expect(await runs(id)).toBe(1);
  });
});

