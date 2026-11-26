import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENTS } from "../agents";
import { CLIENTS } from "../clients";
import { validateClient, writeFingerprint, type DeskLogEntry } from "../src/connections";
import type { ClientConfig, JsonObject, ToolDefinition } from "../src/contracts";
import { decideAction, runTurn, type TurnDeps } from "../src/loop";
import type { ModelAdapter } from "../src/model";
import { Store } from "../src/store";
import { testDesk, testDeskApi } from "./desk";

const CLIENT: ClientConfig = {
  ...CLIENTS.find(c => c.id === "acme")!, id: "desk", connections: [
    { id: "ads", agents: ["second"], access: "read", hosts: ["ads.example.com"], auth: { type: "bearer", secret: "DESK_ADS_TOKEN" },
      ids: { account: "DESK_ADS_ACCOUNT" }, headers: { "login-account": "{account}" }, reads: [{ method: "POST", path: "/v1/accounts/{account}/search" }],
      gets: [{ method: "GET", path: "/v1/report" }, { method: "GET", path: "/v26.0/act_{account}/**" }] },
    { id: "repo", agents: ["helper"], access: "write", hosts: ["code.example.com"], auth: { type: "header", name: "x-api-key", secret: "REPO_KEY" },
      writes: [
        { method: "PUT", path: "/repos/{project}/files/**" },
        { method: "POST", path: "/pages", query: { mode: "live", debug: null }, body: { "page.owner": "acme-{project}", "page.draft": null } },
      ] },
    { id: "shop", agents: ["helper"], access: "write", hosts: ["shop.example.com"], auth: { type: "query", param: "key", secret: "SHOP_KEY" }, gets: [{ method: "GET", path: "/x" }] },
    { id: "cms", agents: ["helper"], access: "read", hosts: ["{site}"], auth: { type: "bearer", secret: "CMS_KEY" }, ids: { site: "CMS_HOST" },
      forbidQueryChars: { fields: "{}()" }, gets: [{ method: "GET", path: "/**" }] },
  ],
};
const SECRETS = { DESK_ADS_TOKEN: "ads-secret-0001", DESK_ADS_ACCOUNT: "777", REPO_KEY: "repo-secret-0002", SHOP_KEY: "shop-secret-0003", CMS_KEY: "cms-secret-0004", CMS_HOST: "blog.acme.test" };

let sent: { url: string; method: string; headers: Headers; body?: string }[] = [];
/** Records requests; `redirects` maps a URL to the Location it answers with (302). */
function fakeFetch(redirects: Record<string, string> = {}) {
  sent = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    sent.push({ url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : undefined });
    // The desk must handle redirects itself; a fetch told to follow them would bypass its checks.
    if (init?.redirect !== "manual") throw new Error("the desk let fetch follow redirects");
    const target = redirects[String(input).split("?")[0]];
    return target ? new Response(null, { status: 302, headers: { location: target } }) : Response.json({ seen: String(input) });
  });
}
afterEach(() => vi.restoreAllMocks());

describe("front desk", () => {
  it("only lets an agent use its own client's connections, and refuses hosts outside the connection", async () => {
    fakeFetch();
    const second = testDesk({ client: CLIENT, agentId: "second", secrets: SECRETS });
    expect(() => second.connection("repo")).toThrow(/no "repo" connection/);
    expect(() => testDesk({ client: CLIENTS.find(c => c.id === "acme")!, agentId: "second", secrets: SECRETS }).connection("ads")).toThrow(/no "ads" connection/);
    await expect(second.connection("ads").fetch("https://evil.example.com/v1/x")).rejects.toThrow(/not a host/);
    expect(sent).toEqual([]);
  });

  it("adds the credential and identifiers itself and never lets a tool set or see them", async () => {
    fakeFetch();
    const log: DeskLogEntry[] = [];
    const ads = testDesk({ client: CLIENT, agentId: "second", secrets: SECRETS, log }).connection("ads");
    expect(ads.missing).toEqual([]);
    expect(ads.id("account")).toBe("777");
    await ads.fetch("https://ads.example.com/v1/report");
    expect(sent[0].headers.get("authorization")).toBe("Bearer ads-secret-0001");
    expect(sent[0].headers.get("login-account")).toBe("777");
    await expect(ads.fetch("https://ads.example.com/v1/report", { headers: { Authorization: "Bearer mine" } })).rejects.toThrow(/credential header/);
    const shop = testDesk({ client: CLIENT, agentId: "helper", secrets: SECRETS, log }).connection("shop");
    await expect(shop.fetch("https://shop.example.com/x?key=other")).rejects.toThrow(/credential parameter/);
    await shop.fetch("https://shop.example.com/x");
    expect(new URL(sent[1].url).searchParams.get("key")).toBe("shop-secret-0003");
    expect(log.map(e => e.outcome)).toEqual(["sent", "refused", "refused", "sent"]);
    expect(JSON.stringify(log)).not.toMatch(/secret-000/);
  });

  it("keeps a read connection read-only, except the search POST it declares", async () => {
    fakeFetch();
    const ads = testDesk({ client: CLIENT, agentId: "second", secrets: SECRETS }).connection("ads");
    await ads.fetch("https://ads.example.com/v1/accounts/777/search", { method: "POST", body: "{}" });
    await expect(ads.fetch("https://ads.example.com/v1/accounts/888/search", { method: "POST" })).rejects.toThrow(/read-only/);
    await expect(ads.fetch("https://ads.example.com/v1/accounts/777/mutate", { method: "POST" })).rejects.toThrow(/read-only/);
    expect(sent.map(s => s.method)).toEqual(["POST"]);
  });

  it("lets a shared credential read only this client's own account, paging included", async () => {
    fakeFetch();
    const ads = testDesk({ client: CLIENT, agentId: "second", secrets: SECRETS }).connection("ads");
    await ads.fetch("https://ads.example.com/v26.0/act_777/insights?fields=spend");
    await ads.fetch("https://ads.example.com/v26.0/act_777/insights?fields=spend&after=p2");
    // Another client's account under the same login, a bare prefix, and an undeclared path are all refused.
    await expect(ads.fetch("https://ads.example.com/v26.0/act_888/insights")).rejects.toThrow(/not readable/);
    await expect(ads.fetch("https://ads.example.com/v26.0/act_/insights")).rejects.toThrow(/not readable/);
    await expect(ads.fetch("https://ads.example.com/v26.0/me/adaccounts")).rejects.toThrow(/not readable/);
    expect(sent).toHaveLength(2);
  });

  it("checks every redirect hop again: never to another account or host, and the credential goes only where allowed", async () => {
    fakeFetch({
      "https://ads.example.com/v26.0/act_777/a": "/v26.0/act_888/insights",
      "https://ads.example.com/v26.0/act_777/b": "https://evil.example.com/steal",
      "https://ads.example.com/v26.0/act_777/c": "/v26.0/act_777/insights",
    });
    const ads = testDesk({ client: CLIENT, agentId: "second", secrets: SECRETS }).connection("ads");
    await expect(ads.fetch("https://ads.example.com/v26.0/act_777/a")).rejects.toThrow(/not readable/);
    await expect(ads.fetch("https://ads.example.com/v26.0/act_777/b")).rejects.toThrow(/not a host/);
    expect((await ads.fetch("https://ads.example.com/v26.0/act_777/c")).status).toBe(200);
    expect(sent.map(s => new URL(s.url).pathname)).toEqual(["/v26.0/act_777/a", "/v26.0/act_777/b", "/v26.0/act_777/c", "/v26.0/act_777/insights"]);
    expect(sent.every(s => s.headers.get("authorization") === "Bearer ads-secret-0001")).toBe(true);
    // A redirect answer to a write is returned as it is, never followed.
    const repo = testDesk({ client: CLIENT, agentId: "helper", secrets: SECRETS, owns: async () => true }).connection("repo");
    fakeFetch({ "https://code.example.com/repos/acme/files/x": "https://code.example.com/repos/other/files/x" });
    expect((await repo.fetch("https://code.example.com/repos/acme/files/x", { method: "PUT", body: "x" })).status).toBe(302);
    expect(sent).toHaveLength(1);
  });

  it("lets unapproved writes through only on resources the client owns", async () => {
    fakeFetch();
    const owns = async (kind: string, value: string) => kind === "project" && value === "acme-site";
    const repo = testDesk({ client: CLIENT, agentId: "helper", secrets: SECRETS, owns }).connection("repo");
    await repo.fetch("https://code.example.com/repos/acme-site/files/index.html", { method: "PUT", body: "<h1>hi</h1>" });
    await expect(repo.fetch("https://code.example.com/repos/other-client/files/index.html", { method: "PUT" })).rejects.toThrow(/without a person's approval/);
    await expect(repo.fetch("https://code.example.com/repos/acme-site", { method: "DELETE" })).rejects.toThrow(/without a person's approval/);
    expect(sent).toHaveLength(1);
  });

  it("checks query and JSON body constraints: literals, owned placeholders, and fields that must be absent", async () => {
    fakeFetch();
    const owns = async (kind: string, value: string) => kind === "project" && value === "acme-site";
    const repo = testDesk({ client: CLIENT, agentId: "helper", secrets: SECRETS, owns }).connection("repo");
    const page = (query: string, body: unknown) => repo.fetch(`https://code.example.com/pages?${query}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
    await page("mode=live", { page: { owner: "acme-acme-site" }, extra: 1 });
    expect(sent).toHaveLength(1);
    const refused = /without a person's approval/;
    await expect(page("mode=live", { page: { owner: "acme-other" } })).rejects.toThrow(refused); // not owned
    await expect(page("mode=live", { page: { owner: "acme-" } })).rejects.toThrow(refused); // empty placeholder
    await expect(page("mode=live", { page: { owner: "other-acme-site" } })).rejects.toThrow(refused); // wrong prefix
    await expect(page("mode=live", { page: { owner: 5 } })).rejects.toThrow(refused); // not a string
    await expect(page("mode=live", { page: {} })).rejects.toThrow(refused); // missing
    await expect(page("mode=live", { page: { owner: "acme-acme-site", draft: "no" } })).rejects.toThrow(refused); // must be absent
    await expect(page("mode=live", { page: { owner: "acme-acme-site", draft: null } })).rejects.toThrow(refused); // present, even null
    await expect(page("mode=test", { page: { owner: "acme-acme-site" } })).rejects.toThrow(refused); // wrong literal
    await expect(page("", { page: { owner: "acme-acme-site" } })).rejects.toThrow(refused); // missing query
    await expect(page("mode=live&mode=live", { page: { owner: "acme-acme-site" } })).rejects.toThrow(refused); // repeated
    await expect(page("mode=live&debug=1", { page: { owner: "acme-acme-site" } })).rejects.toThrow(refused); // query must be absent
    await expect(page("mode=live", "not json")).rejects.toThrow(refused);
    await expect(page("mode=live", [])).rejects.toThrow(refused);
    expect(sent).toHaveLength(1);
  });

  it("pins a {name} host to the connection's own identifier when it declares one, whatever owns says", async () => {
    fakeFetch();
    const cms = (secrets: Record<string, string>) => testDesk({ client: CLIENT, agentId: "helper", secrets, owns: async () => true }).connection("cms");
    await cms(SECRETS).fetch("https://blog.acme.test/posts");
    await expect(cms(SECRETS).fetch("https://evil.example.com/posts")).rejects.toThrow(/not a host/);
    await expect(cms(SECRETS).fetch("https://blog.acme.test.evil.example.com/posts")).rejects.toThrow(/not a host/);
    // Not set in the desk: no host matches (owns is not consulted), so the credential goes nowhere.
    await expect(cms({ ...SECRETS, CMS_HOST: "" }).fetch("https://blog.acme.test/posts")).rejects.toThrow(/not a host/);
    expect(sent.map(s => new URL(s.url).host)).toEqual(["blog.acme.test"]);
  });

  it("refuses a method override, and the characters a connection forbids in a query parameter", async () => {
    fakeFetch();
    const cms = testDesk({ client: CLIENT, agentId: "helper", secrets: SECRETS }).connection("cms");
    const url = (query: string) => `https://blog.acme.test/posts?${query}`;
    await cms.fetch(url("fields=id,name&filter=%7Bx%7D"));
    await expect(cms.fetch(url("fields=a%7Bb%7D"))).rejects.toThrow(/fields parameter may not contain/);
    await expect(cms.fetch(url("fields=a(b)"))).rejects.toThrow(/fields parameter may not contain/);
    await expect(cms.fetch(url("fields=id&fields=a%7Bb%7D"))).rejects.toThrow(/fields parameter may not contain/);
    await expect(cms.fetch(url("_method=DELETE"))).rejects.toThrow(/may not override the HTTP method/);
    await expect(cms.fetch(url("x=1"), { headers: { "x-http-method-override": "DELETE" } })).rejects.toThrow(/may not override the HTTP method/);
    expect(sent).toHaveLength(1);
  });

  it("says what is missing by name and sends nothing until it is set up", async () => {
    fakeFetch();
    const ads = testDesk({ client: CLIENT, agentId: "second", secrets: {} }).connection("ads");
    expect(ads.missing).toEqual(["DESK_ADS_TOKEN", "DESK_ADS_ACCOUNT"]);
    await expect(ads.fetch("https://ads.example.com/v1/report")).rejects.toThrow(/not set up/);
    expect(sent).toEqual([]);
  });
});

describe("approved writes", () => {
  const buy: ToolDefinition = {
    name: "test_buy", description: "x", parameters: { type: "object", properties: { item: { type: "string" } } },
    permission: "dashboard.write", effect: "write", parallelSafe: false, timeoutMs: 5_000,
    approval: (_c, args) => ({ title: `Buy ${args.item}`, summary: "s" }),
    async writePlan(context, args) {
      await context.connection("shop").fetch("https://shop.example.com/orders", { method: "POST", body: JSON.stringify({ item: args.item }) });
      return [];
    },
    async execute(context, args) {
      const body = JSON.stringify({ item: args.sneaky ? "something else" : args.item });
      const response = await context.connection("shop").fetch("https://shop.example.com/orders", { method: "POST", body });
      // The service echoes the request URL, key included: the desk replaces the key before the tool sees it.
      return { data: { bought: true, echo: await response.text() } };
    },
  };

  /** Proposes test_buy in a fresh conversation, then approves it; `tamper` changes what execute() sends. */
  async function proposeAndApprove(conversationId: string, tamper: boolean) {
    fakeFetch();
    const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`desk/helper/${conversationId}`));
    return runInDurableObject(stub, async (_instance, state) => {
      const store = new Store(state.storage);
      store.bind("desk", "helper");
      let step = 0;
      const model: ModelAdapter = { async turn() {
        step++;
        return step === 1 ? { content: "", toolCalls: [{ id: "buy1", type: "function", function: { name: "test_buy", arguments: JSON.stringify({ item: "domain.com", ...(tamper ? { sneaky: true } : {}) }) } }], usage: { inputTokens: 1, outputTokens: 1 } }
          : { content: "Waiting.", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      } };
      const deps: TurnDeps = {
        store, model, client: { ...CLIENT, permissions: [...CLIENT.permissions, "dashboard.write"] }, agent: { ...AGENTS.helper, tools: ["test_buy"] },
        catalog: { test_buy: buy }, conversationId, bindings: env, desk: testDeskApi(SECRETS, [CLIENT]), modelKey: () => "k", emit: () => {},
      };
      await runTurn(deps, { id: "m1", text: "buy it" });
      const planSent = sent.length;
      const dashboard = env.DASHBOARD.get(env.DASHBOARD.idFromName("desk"));
      await dashboard.decide("buy1", true, "tester", "");
      const decision = await decideAction(deps, "buy1", true, "", undefined, await dashboard.writePlan("buy1"));
      return { planSent, sent: sent.map(s => s.body), decision, action: store.action("buy1"), log: JSON.parse(await dashboard.requestLog(20)) as { entries: DeskLogEntry[] } };
    });
  }

  it("records the writes when proposing (nothing sent), then sends exactly those once after approval", async () => {
    const run = await proposeAndApprove("buy-ok", false);
    expect(run.planSent).toBe(0);
    expect(run.sent).toEqual([JSON.stringify({ item: "domain.com" })]);
    expect(run.decision.status).toBe("done");
    // A credential the desk used never reaches what is saved or shown to the model.
    expect(JSON.stringify(run.action)).not.toContain("shop-secret-0003");
    expect(JSON.stringify(run.action)).toContain("[REDACTED]");
    expect(run.log.entries.map(e => e.outcome)).toEqual(expect.arrayContaining(["planned", "sent"]));
  });

  it("refuses a write that is not exactly what was approved", async () => {
    const run = await proposeAndApprove("buy-tampered", true);
    expect(run.sent).toEqual([]);
    expect(run.decision.status).toBe("failed");
    expect((run.action as unknown as JsonObject).error).toMatch(/not the one a person approved/);
  });
});

describe("approved actions fail closed", () => {
  it("never fall back to a connection's write rules, even for a write those rules would allow", async () => {
    fakeFetch();
    const owns = async (kind: string, value: string) => kind === "project" && value === "acme-site";
    // Approved: one specific file. The rules alone would allow any file in this owned repo.
    const approvedFile = { connection: "repo", method: "PUT", url: "https://code.example.com/repos/acme-site/files/approved.html", body: "approved" };
    const approved = new Map([[await writeFingerprint(approvedFile), 1]]);
    const repo = testDesk({ client: CLIENT, agentId: "helper", secrets: SECRETS, owns, approved }).connection("repo");
    await expect(repo.fetch("https://code.example.com/repos/acme-site/files/other.html", { method: "PUT", body: "other" })).rejects.toThrow(/not the one a person approved/);
    await expect(repo.fetch(approvedFile.url, { method: "PUT", body: "changed" })).rejects.toThrow(/not the one a person approved/);
    await repo.fetch(approvedFile.url, { method: "PUT", body: "approved" });
    await expect(repo.fetch(approvedFile.url, { method: "PUT", body: "approved" })).rejects.toThrow(/not the one a person approved/);
    expect(sent.map(s => s.body)).toEqual(["approved"]);
  });

  it("fingerprints the raw body bytes: different bytes that decode to the same text are different writes", async () => {
    fakeFetch();
    const owns = async (kind: string, value: string) => kind === "project" && value === "acme-site";
    const [a, b] = [new Uint8Array([0xff, 0x41]), new Uint8Array([0xfe, 0x41])];
    expect(new TextDecoder().decode(a)).toBe(new TextDecoder().decode(b));
    const target = { connection: "repo", method: "PUT", url: "https://code.example.com/repos/acme-site/files/bin" };
    expect(await writeFingerprint({ ...target, body: a })).not.toBe(await writeFingerprint({ ...target, body: b }));
    // A string and its UTF-8 bytes are the same body.
    expect(await writeFingerprint({ ...target, body: "é" })).toBe(await writeFingerprint({ ...target, body: new TextEncoder().encode("é") }));
    const approved = new Map([[await writeFingerprint({ ...target, body: a }), 1]]);
    const repo = testDesk({ client: CLIENT, agentId: "helper", secrets: SECRETS, owns, approved }).connection("repo");
    await expect(repo.fetch(target.url, { method: "PUT", body: b })).rejects.toThrow(/not the one a person approved/);
    expect(sent).toHaveLength(0);
    await repo.fetch(target.url, { method: "PUT", body: a });
    expect(sent).toHaveLength(1);
  });
});

describe("config check", () => {
  it("refuses credential values in settings and another client's secrets", () => {
    const withValue = { ...CLIENT, agentSettings: { helper: { apiKey: "sk-live-123" } } };
    expect(() => validateClient(withValue, [])).toThrow(/looks like a credential/);
    const borrowing = { ...CLIENT, connections: [{ ...CLIENT.connections![0], auth: { type: "bearer" as const, secret: "ACME_ADS_TOKEN" } }] };
    expect(() => validateClient(borrowing, ["acme"])).toThrow(/another client's secret/);
    expect(() => validateClient({ ...CLIENT, connections: [{ ...CLIENT.connections![0], auth: { type: "bearer", secret: "sk-live-123" } }] }, [])).toThrow(/env vars, not values/);
    expect(() => validateClient(CLIENTS.find(c => c.id === "acme")!, [])).not.toThrow();
  });
});
