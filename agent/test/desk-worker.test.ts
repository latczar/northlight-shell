import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENTS } from "../agents";
import { CLIENTS } from "../clients";
import deskEntry from "../desk";
import { ids, presence, send, type DeskEnv } from "../desk/service";
import { writeFingerprint, type DeskLogEntry } from "../src/connections";
import type { ClientConfig, PlannedRequest, ToolContext, ToolDefinition } from "../src/contracts";
import type { DeskApi, DeskReply, DeskRequest } from "../src/desk-api";
import { deskClientContext, loadDeskState, type DeskClientInput } from "../src/desk-client";
import { ToolError } from "../src/errors";
import { toolBindings } from "../src/bindings";
import { ownsContext } from "../desk/service";
import { runTurn, type TurnDeps } from "../src/loop";
import type { ModelAdapter } from "../src/model";
import { Store } from "../src/store";

// Two layers. The brain's `DESK` binding is the real desk bundled as an auxiliary Worker (vitest.config.ts), so
// `desk` is a genuine RPC call; its outbound requests are answered with an echo of what it would have sent.
// Cases that need other clients, secrets or hosts call the desk's functions (desk/service.ts) with a fake env.

// Awaiting inside keeps a rejected RPC call from also surfacing as an unhandled rejection of the stub's own promise.
const desk: DeskApi = {
  presence: async (clientId, agentId) => await env.DESK.presence(clientId, agentId),
  ids: async (clientId, agentId) => await env.DESK.ids(clientId, agentId),
  send: async request => await env.DESK.send(request),
  mediaUploadUrl: async (clientId, key, contentType, size, meta) => await env.DESK.mediaUploadUrl(clientId, key, contentType, size, meta),
};
const OPENAI = "https://api.openai.com/v1/images/generations";
const log = async (client: string): Promise<DeskLogEntry[]> => (JSON.parse(await env.DASHBOARD.get(env.DASHBOARD.idFromName(client)).requestLog(50)) as { entries: DeskLogEntry[] }).entries;
const request = (extra: Partial<DeskRequest> = {}): DeskRequest => ({
  clientId: "acme", agentId: "second", toolName: "t", actionId: crypto.randomUUID(), connection: "openai_images", url: OPENAI, method: "POST",
  headers: { "content-type": "application/json" }, body: "{}", ...extra,
});
async function echoOf(reply: DeskReply) {
  if (reply.status !== "response") throw new Error(`expected a response, got ${reply.status}`);
  return reply.response.json() as Promise<{ url: string; method: string; headers: Record<string, string>; body: string }>;
}

describe("desk Worker over RPC", () => {
  it("answers presence with names and true/false only, never a value", async () => {
    const result = await desk.presence("acme", "second");
    expect(result).toEqual({ OPENAI_DESK_API_KEY: true });
    expect(Object.values(result).every(value => typeof value === "boolean")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("test-openai-desk-key");
    // The desk's OpenAI key is its own: the brain's model key name is not one of Second's connection names.
    expect(result).not.toHaveProperty("OPENAI_API_KEY");
    // Helper has no connections of its own for this client: nothing to report, not even the desk's shared keys.
    expect(await desk.presence("acme", "helper")).toEqual({});
    // No connection declares identifiers, so there are none to report.
    expect(await desk.ids("acme", "second")).toEqual({});
  });

  it("adds the credential, redacts it from the answer and writes the connection log itself", async () => {
    const echo = await echoOf(await desk.send(request({ toolName: "rpc_probe" })));
    expect(echo.url).toBe(OPENAI);
    // The outside service saw the key (the echo carries it back), the caller never does.
    expect(echo.headers.authorization).toBe("Bearer [REDACTED]");
    expect(JSON.stringify(echo)).not.toContain("test-openai-desk-key");
    const entry = (await log("acme")).find(e => e.tool === "rpc_probe");
    expect(entry).toMatchObject({ agent: "second", connection: "openai_images", method: "POST", host: "api.openai.com", outcome: "sent", status: 200 });
  });

  it("refuses an unknown client, another agent's connection, an outside host and a tool-set credential", async () => {
    expect(await desk.send(request({ clientId: "nobody" }))).toMatchObject({ status: "refused", definite: true, message: expect.stringMatching(/Unknown client/) });
    await expect(desk.presence("nobody", "second")).rejects.toThrow(/Unknown client/);
    expect(await desk.send(request({ agentId: "ghost" }))).toMatchObject({ status: "refused", message: expect.stringMatching(/Unknown agent/) });
    // Helper is a acme agent, but openai_images belongs to Second.
    expect(await desk.send(request({ agentId: "helper" }))).toMatchObject({ status: "refused", definite: true, message: expect.stringMatching(/no "openai_images" connection/) });
    expect(await desk.send(request({ connection: "stripe" }))).toMatchObject({ status: "refused" });
    expect(await desk.send(request({ url: "https://evil.example.com/v1/images/generations", toolName: "evil_probe" }))).toMatchObject({ status: "refused", message: expect.stringMatching(/not a host/) });
    expect(await desk.send(request({ headers: { Authorization: "Bearer mine" } }))).toMatchObject({ status: "refused", message: expect.stringMatching(/credential header/) });
    expect((await log("acme")).find(e => e.tool === "evil_probe")).toMatchObject({ outcome: "refused", host: "evil.example.com" });
  });

  it("validates every argument", async () => {
    const bad = (extra: object) => desk.send({ ...request(), ...extra } as DeskRequest);
    for (const extra of [{ method: "NOT A METHOD" }, { headers: { a: 1 } }, { body: 5 }, { url: "" }, { redirect: "sideways" }, { approved: ["not-a-fingerprint"] }, { planning: "yes" }]) {
      expect(await bad(extra)).toMatchObject({ status: "refused", definite: true, message: expect.stringMatching(/Bad request/) });
    }
    expect(await desk.send(null as unknown as DeskRequest)).toMatchObject({ status: "refused", message: "Bad request." });
  });

  it("has no public face: its default entry answers 404", async () => {
    expect((await deskEntry.fetch()).status).toBe(404);
  });
});

describe("the brain's connection handle", () => {
  const client = CLIENTS.find(c => c.id === "acme")!;
  const context = async (extra: Partial<DeskClientInput> = {}, via: DeskApi = desk) =>
    deskClientContext({
      desk: via, state: await loadDeskState(via, "acme", "second"), client, agentId: "second", toolName: "handle_probe", actionId: "a1",
      signal: new AbortController().signal, ...extra,
    });

  it("forwards through the desk, knows what is set up from presence, and a refusal is a definite ToolError", async () => {
    const second = await context();
    const openai = second.connection("openai_images");
    expect(openai.missing).toEqual([]);
    expect(second.hasSecret("OPENAI_DESK_API_KEY")).toBe(true);
    const response = await openai.fetch(OPENAI, { method: "POST", body: "{}" });
    expect((await response.json() as { headers: Record<string, string> }).headers.authorization).toBe("Bearer [REDACTED]");
    expect((await log("acme")).some(e => e.tool === "handle_probe" && e.outcome === "sent")).toBe(true);
    await expect(openai.fetch("https://evil.example.com/x", { method: "POST" })).rejects.toMatchObject({ definite: true, message: expect.stringMatching(/not a host/) });
    expect(() => second.connection("nope")).toThrow(/no "nope" connection/);
    const helper = await context({ agentId: "helper" });
    expect(() => helper.connection("openai_images")).toThrow(ToolError);
  });

  it("reads as not set up when the desk cannot answer", async () => {
    const down: DeskApi = { presence: async () => { throw new Error("down"); }, ids: async () => ({}), send: async () => { throw new Error("down"); }, mediaUploadUrl: async () => { throw new Error("down"); } };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const second = await context({}, down);
    expect(second.connection("openai_images").missing).toEqual(["OPENAI_DESK_API_KEY"]);
    expect(second.hasSecret("OPENAI_DESK_API_KEY")).toBe(false);
    vi.restoreAllMocks();
  });

  it("records planned writes without sending, and spends an approval once", async () => {
    const planning: PlannedRequest[] = [];
    const planned = (await context({ planning })).connection("openai_images");
    expect((await planned.fetch(OPENAI, { method: "POST", body: "{}" })).status).toBe(204);
    expect(planning).toEqual([{ connection: "openai_images", method: "POST", url: OPENAI, body: "{}" }]);

    const print = await writeFingerprint({ connection: "openai_images", method: "POST", url: OPENAI, body: "{}" });
    const actionId = await fileApproval("handle_probe", [print]);
    const approved = new Map([[print, 1]]);
    const sent = (await context({ approved, actionId })).connection("openai_images");
    await sent.fetch(OPENAI, { method: "POST", body: "{}" });
    expect(approved.get(print)).toBe(0);
    await expect(sent.fetch(OPENAI, { method: "POST", body: "{}" })).rejects.toThrow(/not the one a person approved/);
    // A request that is not the approved one is refused and uses nothing up.
    const other = new Map([[print, 1]]);
    await expect((await context({ approved: other, actionId })).connection("openai_images").fetch(OPENAI, { method: "POST", body: "changed" })).rejects.toThrow(/not the one a person approved/);
    expect(other.get(print)).toBe(1);
  });

  it("returns a reserved approval without dispatching when cancelled during fingerprinting", async () => {
    const body = JSON.stringify({ probe: crypto.randomUUID() });
    const print = await writeFingerprint({ connection: "openai_images", method: "POST", url: OPENAI, body });
    const approved = new Map([[print, 1]]);
    const controller = new AbortController();
    const reason = new Error("cancelled during fingerprinting");
    const send = vi.fn(desk.send);
    const connection = deskClientContext({
      desk: { ...desk, send }, state: { presence: {}, ids: {} }, client, agentId: "second",
      toolName: "cancel_fingerprint_probe", actionId: crypto.randomUUID(), signal: controller.signal, approved,
    }).connection("openai_images");
    let resume!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const hook = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
      entered();
      await paused;
      return digest(algorithm, data);
    });
    try {
      const result = connection.fetch(OPENAI, { method: "POST", body });
      await started;
      controller.abort(reason);
      resume();
      await expect(result).rejects.toMatchObject({ name: "ToolError", definite: true, message: "Not sent: the request was cancelled before dispatch." });
      expect(send).not.toHaveBeenCalled();
      expect(approved.get(print)).toBe(1);
    } finally {
      resume();
      hook.mockRestore();
    }
  });

  it("gives an approval back when the desk refuses the request that reserved it", async () => {
    // The brain's own map matches this request, so it reserves the approval; the desk then refuses (nothing stored for
    // this action), and the reserved count must come back.
    const print = await writeFingerprint({ connection: "openai_images", method: "POST", url: OPENAI, body: "{}" });
    const approved = new Map([[print, 1]]);
    const connection = (await context({ approved, actionId: crypto.randomUUID() })).connection("openai_images");
    await expect(connection.fetch(OPENAI, { method: "POST", body: "{}" })).rejects.toThrow(/No person has approved/);
    expect(approved.get(print)).toBe(1);
  });
});

/** Files a proposal for `tool` (agent second, client acme) with this write plan in the brain's Dashboard, as the loop does. */
async function fileApproval(tool: string, plan: string[], decision: "approve" | "decline" | "pending" = "approve", agent = "second"): Promise<string> {
  const id = crypto.randomUUID();
  const dashboard = env.DASHBOARD.get(env.DASHBOARD.idFromName("acme"));
  await dashboard.propose({ id, agent, conversationId: "c1", tool, title: "t", summary: "s", previewJson: "{}", writePlan: plan });
  if (decision !== "pending") await dashboard.decide(id, decision === "approve", "tester", "");
  return id;
}

describe("the desk checks approvals itself", () => {
  it("refuses fingerprints a person did not approve: forged, not in the stored plan, or from an action nobody approved", async () => {
    const print = await writeFingerprint({ connection: "openai_images", method: "POST", url: OPENAI, body: "{}" });
    const forged = "ab".repeat(32);
    const send = (actionId: string, approved: string[], extra: Partial<DeskRequest> = {}) =>
      desk.send(request({ toolName: "approved_probe", actionId, approved, ...extra }));

    // The real thing: approved, in the plan, once.
    const good = await fileApproval("approved_probe", [print]);
    const reply = await send(good, [print]);
    expect(reply).toMatchObject({ status: "response", consumed: print });
    expect((await echoOf(reply)).headers.authorization).toBe("Bearer [REDACTED]");

    const refused = (reply: DeskReply, message: RegExp) => expect(reply).toMatchObject({ status: "refused", definite: true, message: expect.stringMatching(message) });
    refused(await send(good, [forged]), /not in the plan/);
    refused(await send(good, [print, forged]), /not in the plan/);
    // Asked twice for a plan that lists it once.
    refused(await send(good, [print, print]), /not in the plan/);
    // A plan of an action that is still pending, was declined, or is another agent's or tool's.
    refused(await send(await fileApproval("approved_probe", [print], "pending"), [print]), /No person has approved/);
    refused(await send(await fileApproval("approved_probe", [print], "decline"), [print]), /No person has approved/);
    refused(await send(await fileApproval("approved_probe", [print], "approve", "helper"), [print]), /No person has approved/);
    refused(await send(await fileApproval("other_tool", [print]), [print]), /No person has approved/);
    refused(await send(crypto.randomUUID(), [print]), /No person has approved/);
    // A finished action cannot be approved again.
    const finished = await fileApproval("approved_probe", [print]);
    await env.DASHBOARD.get(env.DASHBOARD.idFromName("acme")).finish(finished, "done", "{}");
    refused(await send(finished, [print]), /No person has approved/);
  });

  it("sends an approved request once: a repeat and two concurrent sends go out one time; a listing used twice in the plan twice", async () => {
    const print = await writeFingerprint({ connection: "openai_images", method: "POST", url: OPENAI, body: "{}" });
    const sentBy = async (tool: string) => (await log("acme")).filter(entry => entry.tool === tool && entry.outcome === "sent").length;
    const send = (actionId: string, toolName: string, extra: Partial<DeskRequest> = {}) => desk.send(request({ toolName, actionId, approved: [print], ...extra }));
    const sends = (replies: DeskReply[]) => replies.filter(reply => reply.status === "response").length;
    const already = { status: "refused", definite: true, message: expect.stringMatching(/already sent/) };

    // Sequential repeat.
    const once = await fileApproval("replay_seq", [print]);
    expect((await send(once, "replay_seq")).status).toBe("response");
    expect(await send(once, "replay_seq")).toMatchObject(already);
    expect(await sentBy("replay_seq")).toBe(1);

    // Concurrent: the Dashboard object lets exactly one through.
    const race = await fileApproval("replay_race", [print]);
    const replies = await Promise.all([send(race, "replay_race"), send(race, "replay_race"), send(race, "replay_race")]);
    expect(sends(replies)).toBe(1);
    expect(replies.filter(reply => reply.status === "refused")).toHaveLength(2);
    expect(await sentBy("replay_race")).toBe(1);

    // A plan that lists the write twice allows it twice, no more.
    const twice = await fileApproval("replay_twice", [print, print]);
    expect(sends(await Promise.all([send(twice, "replay_twice"), send(twice, "replay_twice"), send(twice, "replay_twice")]))).toBe(2);
    expect(await sentBy("replay_twice")).toBe(2);

    // Refused before sending (the request is not the one approved): the approval is given back and still works once.
    const given = await fileApproval("replay_back", [print]);
    expect(await send(given, "replay_back", { body: "changed" })).toMatchObject({ status: "refused", message: expect.stringMatching(/not the one a person approved/) });
    expect(await sentBy("replay_back")).toBe(0);
    expect((await send(given, "replay_back")).status).toBe("response");
    expect(await send(given, "replay_back")).toMatchObject(already);
    expect(await sentBy("replay_back")).toBe(1);
  });
});

describe("tool contexts", () => {
  it("get only the platform bindings: no secret, no DESK, even when the turn is handed the whole env", async () => {
    expect(Object.keys(toolBindings(env)).sort()).toEqual(["DASHBOARD", "IMAGES", "LEADS", "MEDIA", "MEMORY", "USAGE"]);
    // Tools can ask whether intake is enabled and obtain their site's intake address, never read leads.
    expect(Object.keys(toolBindings(env).LEADS!.get(env.LEADS.idFromName("acme")))).toEqual(["intakeFor", "intakeEnabled"]);
    let seen: ToolContext | undefined;
    let missing: string[] = [];
    let have: boolean[] = [];
    const peek: ToolDefinition = {
      name: "peek", description: "x", parameters: { type: "object", properties: {}, additionalProperties: false },
      permission: "test.peek", effect: "read", parallelSafe: true, timeoutMs: 5_000,
      async execute(context) { seen = context; missing = context.connection("openai_images").missing; have = [context.hasSecret("OPENAI_API_KEY"), context.hasSecret("OPENAI_DESK_API_KEY")]; return { data: {} }; },
    };
    const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName("acme/second/peek"));
    await runInDurableObject(stub, async (_instance, state) => {
      const store = new Store(state.storage);
      store.bind("acme", "second");
      let step = 0;
      const model: ModelAdapter = { async turn() {
        step++;
        return step === 1 ? { content: "", toolCalls: [{ id: "p1", type: "function", function: { name: "peek", arguments: "{}" } }], usage: { inputTokens: 1, outputTokens: 1 } }
          : { content: "ok", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      } };
      const deps: TurnDeps = {
        store, model, client: { ...CLIENTS.find(c => c.id === "acme")!, permissions: [...CLIENTS.find(c => c.id === "acme")!.permissions, "test.peek"] }, agent: { ...AGENTS.second, tools: ["peek"] },
        catalog: { peek }, conversationId: "peek", bindings: env, desk, modelKey: () => "k", emit: () => {},
      };
      await runTurn(deps, { id: "m1", text: "peek" });
    });
    expect(Object.keys(seen!.bindings).sort()).toEqual(["DASHBOARD", "IMAGES", "LEADS", "MEDIA", "MEMORY", "USAGE"]);
    expect("DESK" in seen!.bindings).toBe(false);
    // `missing` came from the desk's presence, fetched before the tool ran.
    expect(missing).toEqual([]);
    // No tool-facing secret reader, and hasSecret answers from the desk: the brain's own OPENAI_API_KEY (the model key) is not Second's.
    expect("secret" in seen!).toBe(false);
    expect(have).toEqual([false, true]);
  });

  it("gives tools a Dashboard that cannot save settings, record decisions or touch write plans", async () => {
    const dashboardOf = (bindings: ToolContext["bindings"]) => bindings.DASHBOARD.get(bindings.DASHBOARD.idFromName("acme")) as unknown as Record<string, unknown>;
    const stub = dashboardOf(toolBindings(env));
    expect(Object.keys(stub).sort()).toEqual(["approvals", "has", "post", "update"]);
    for (const method of ["saveSettings", "settingOverrides", "propose", "decide", "finish", "closeDeclined", "writePlan", "settingsHash", "approvalJson", "logRequest", "saveSnapshot", "cleanupSites", "resetAgent"]) {
      expect(stub[method], method).toBeUndefined();
    }
    // What tools do call still works, and reaches the real object.
    expect(await (stub.has as (id: string) => Promise<boolean>)("no-such-card")).toBe(false);
    expect(JSON.parse(await (stub.approvals as (status: string) => Promise<string>)("pending"))).toHaveProperty("approvals");
    // The desk's `owns` context gets the same narrowed Dashboard.
    const owns = ownsContext(env, CLIENTS.find(c => c.id === "acme")!, AGENTS.helper, {}, () => { throw new Error("none"); });
    expect(Object.keys(dashboardOf(owns.bindings)).sort()).toEqual(["approvals", "has", "post", "update"]);
  });
});

describe("desk functions with a fake env", () => {
  const deskEnv = (secrets: Record<string, string> = {}): DeskEnv => ({ IMAGES: env.IMAGES, DASHBOARD: env.DASHBOARD, ...secrets });
  const acme: ClientConfig = {
    ...CLIENTS.find(c => c.id === "acme")!, id: "acme", agents: ["third", "second"], agentSettings: { third: { cmsHost: "blog.acme.test" } },
    connections: [
      { id: "cms", agents: ["third"], access: "read", hosts: ["{cmsHost}"], auth: { type: "bearer", secret: "ACME_CMS_KEY" }, ids: { site: "ACME_SITE" }, gets: [{ method: "GET", path: "/**" }] },
      { id: "acme_ads", agents: ["second"], access: "read", hosts: ["ads.example.com"], auth: { type: "bearer", secret: "ACME_ADS_KEY" }, gets: [{ method: "GET", path: "/**" }] },
    ],
  };
  const beta: ClientConfig = {
    ...CLIENTS.find(c => c.id === "acme")!, id: "beta", agents: ["second"],
    connections: [{ id: "beta_ads", agents: ["second"], access: "read", hosts: ["ads.example.com"], auth: { type: "bearer", secret: "BETA_ADS_KEY" }, gets: [{ method: "GET", path: "/**" }] }],
  };
  const clients = [acme, beta];
  const secrets = { ACME_CMS_KEY: "acme-cms-secret-1", ACME_SITE: "site-7", ACME_ADS_KEY: "acme-ads-secret-2", BETA_ADS_KEY: "beta-ads-secret-3" };
  const req = (extra: Partial<DeskRequest>): DeskRequest => ({ clientId: "acme", agentId: "second", toolName: "fake_probe", actionId: "a", connection: "acme_ads", url: "https://ads.example.com/x", method: "GET", headers: {}, ...extra });
  let sentUrls: string[] = [];
  const fakeFetch = (redirects: Record<string, string> = {}) => {
    sentUrls = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      sentUrls.push(String(input));
      const target = redirects[String(input)];
      return target ? new Response(null, { status: 302, headers: { location: target } }) : new Response("key acme-cms-secret-1 ok", { headers: { "content-type": "text/plain" } });
    });
  };
  const original = AGENTS.third.owns;
  afterEach(() => { vi.restoreAllMocks(); AGENTS.third.owns = original; });

  it("lists names with set/unset and the identifiers that are set, for one agent only", () => {
    expect(presence(deskEnv({ ACME_CMS_KEY: "x" }), "acme", "third", clients)).toEqual({ ACME_CMS_KEY: true, ACME_SITE: false });
    expect(presence(deskEnv(secrets), "acme", "second", clients)).toEqual({ ACME_ADS_KEY: true });
    expect(ids(deskEnv(secrets), "acme", "third", clients)).toEqual({ cms: { site: "site-7" } });
    expect(() => presence(deskEnv(), "acme", "helper", clients)).toThrow(/Unknown agent/);
  });

  it("refuses another client's connection, another agent's connection and an unknown client", async () => {
    fakeFetch();
    expect(await send(deskEnv(secrets), req({ connection: "beta_ads" }), clients)).toMatchObject({ status: "refused", message: expect.stringMatching(/no "beta_ads" connection/) });
    expect(await send(deskEnv(secrets), req({ agentId: "third" }), clients)).toMatchObject({ status: "refused" });
    expect(await send(deskEnv(secrets), req({ clientId: "gamma" }), clients)).toMatchObject({ status: "refused", message: expect.stringMatching(/Unknown client/) });
    expect(await send(deskEnv(secrets), req({ clientId: "beta", agentId: "third" }), clients)).toMatchObject({ status: "refused", message: expect.stringMatching(/Unknown agent/) });
    expect(sentUrls).toEqual([]);
    // Each client's own request carries only its own key.
    vi.restoreAllMocks();
    const keys: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => { keys.push(new Headers(init?.headers).get("authorization")!); return new Response("{}"); });
    await send(deskEnv(secrets), req({}), clients);
    await send(deskEnv(secrets), req({ clientId: "beta", connection: "beta_ads" }), clients);
    expect(keys).toEqual(["Bearer acme-ads-secret-2", "Bearer beta-ads-secret-3"]);
  });

  it("matches a {name} host only when the agent says the client owns it, and checks redirects the same way", async () => {
    // Third's owns gets the desk's own context with the client's effective settings.
    AGENTS.third.owns = async (context, kind, host) => kind === "cmsHost" && host === context.settings.cmsHost;
    fakeFetch({ "https://blog.acme.test/a": "https://elsewhere.test/steal", "https://blog.acme.test/b": "/c" });
    const cms = (url: string) => send(deskEnv(secrets), req({ agentId: "third", connection: "cms", url }), clients);

    const owned = await cms("https://blog.acme.test/posts");
    expect(owned).toMatchObject({ status: "response" });
    // The answer carries no credential value even when the service echoes it.
    expect(owned.status === "response" && await owned.response.text()).toBe("key [REDACTED] ok");
    expect(await cms("https://other.test/posts")).toMatchObject({ status: "refused", message: expect.stringMatching(/other\.test is not a host/) });
    expect(await cms("https://blog.acme.test/a")).toMatchObject({ status: "refused", message: expect.stringMatching(/elsewhere\.test is not a host/) });
    expect(sentUrls).toEqual(["https://blog.acme.test/posts", "https://blog.acme.test/a"]);
    expect(await cms("https://blog.acme.test/b")).toMatchObject({ status: "response" });
    expect(sentUrls.slice(2)).toEqual(["https://blog.acme.test/b", "https://blog.acme.test/c"]);
    // Without an owns check nothing matches.
    AGENTS.third.owns = undefined;
    expect(await cms("https://blog.acme.test/posts")).toMatchObject({ status: "refused" });
    // The desk wrote its own log entries for the client.
    expect((await log("acme")).filter(e => e.tool === "fake_probe").map(e => e.outcome)).toContain("refused");
  });

  it("replaces credential values in response headers too, for binary and text answers alike", async () => {
    const get = async (contentType: string, body: string) => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(body, {
        headers: { "content-type": contentType, "x-echoed-auth": "Bearer acme-ads-secret-2", link: "<https://ads.example.com/next?key=acme-ads-secret-2>; rel=next", "x-plain": "fine" },
      }));
      const reply = await send(deskEnv(secrets), req({}), clients);
      vi.restoreAllMocks();
      if (reply.status !== "response") throw new Error(`expected a response, got ${reply.status}`);
      return reply.response;
    };
    const image = await get("image/png", "png acme-ads-secret-2 bytes");
    expect(image.headers.get("x-echoed-auth")).toBe("Bearer [REDACTED]");
    expect(image.headers.get("link")).toBe("<https://ads.example.com/next?key=[REDACTED]>; rel=next");
    expect(image.headers.get("x-plain")).toBe("fine");
    // A binary body is passed through untouched; only text answers have their body rewritten.
    expect(new TextDecoder().decode(await image.arrayBuffer())).toBe("png acme-ads-secret-2 bytes");
    const text = await get("text/plain", "key acme-ads-secret-2 ok");
    expect(text.headers.get("x-echoed-auth")).toBe("Bearer [REDACTED]");
    expect(await text.text()).toBe("key [REDACTED] ok");
    expect(JSON.stringify([...text.headers])).not.toContain("acme-ads-secret-2");
  });
});
