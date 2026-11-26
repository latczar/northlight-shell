import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ModelAdapter } from "../src/model";
import { Store } from "../src/store";
import { signUserPass } from "../src/user-auth";

const auth = { authorization: "Bearer test-token-acme-0123456789abcdef", "content-type": "application/json" };
const USER_KEY = "test-signing-key-acme-0123456789abcdef";
const DASHBOARD_KEY = "test-dashboard-key-acme-0123456789abcdef";
const APPROVER_KEY = "test-approver-key-acme-0123456789abcdef";
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
const staff = () => signUserPass(DASHBOARD_KEY, "acme", "staff-1", inAnHour(), "dashboard");
const userPass = (who: string) => signUserPass(USER_KEY, "acme", who, inAnHour());

const conversationStub = (agent: string, id: string, client = "acme") => env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`${client}/${agent}/${id}`));
const dashboardStub = () => env.DASHBOARD.get(env.DASHBOARD.idFromName("acme"));

/** One person says something to an agent and gets a fixed reply; the conversation is then registered with the dashboard. */
async function chat(agent: string, id: string, user: string): Promise<void> {
  await runInDurableObject(conversationStub(agent, id), instance => {
    instance.model = { async turn(request) { request.onText?.("Noted."); return { content: "Noted.", toolCalls: [], usage: { inputTokens: 5, outputTokens: 2 } }; } } satisfies ModelAdapter;
  });
  await (await SELF.fetch(`https://brain/v1/agents/${agent}/conversations/${id}/messages`, {
    method: "POST", headers: auth, body: JSON.stringify({ id: "m1", text: `hello ${agent}`, userAuth: await userPass(user) }),
  })).text();
}

const history = async (agent: string, id: string, user: string) =>
  (await (await SELF.fetch(`https://brain/v1/agents/${agent}/conversations/${id}/messages`, { headers: { ...auth, "x-user-pass": await userPass(user) } })).json() as { messages: unknown[] }).messages;

const reset = async (agent: string, pass: string | null, body: unknown = {}, headers = auth) =>
  SELF.fetch(`https://brain/v1/agents/${agent}/reset`, { method: "POST", headers: { ...headers, ...(pass === null ? {} : { "x-dashboard-pass": pass }) }, body: JSON.stringify(body) });

const keys = async (prefix: string) => {
  const found: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await env.IMAGES.list({ prefix, cursor });
    found.push(...listed.objects.map(o => o.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return found;
};

describe("POST /v1/agents/:agent/reset", () => {
  it("erases one agent's history for this client and leaves everything else", async () => {
    // Helper: two registered conversations, one older one the registry never saw, approvals, cards, a snapshot, 1,005 R2 records.
    await chat("helper", "web-r1", "alex");
    await chat("helper", "web-r2", "alex");
    await runInDurableObject(conversationStub("helper", "web-old"), (_instance, state) => {
      const store = new Store(state.storage);
      store.bind("acme", "helper", "alex");
      store.append({ role: "user", content: "an old question" });
    });
    // Third and another client's Helper must survive.
    await chat("second", "web-a1", "alex");
    await runInDurableObject(conversationStub("helper", "web-r1", "other"), (_instance, state) => new Store(state.storage).bind("other", "helper", "alex"));

    await runInDurableObject(dashboardStub(), async (dashboard, state) => {
      for (const agent of ["helper", "second"]) {
        await dashboard.propose({ id: `${agent}-p1`, agent, conversationId: "c", tool: "t", title: "Proposal", summary: "", previewJson: "{}", writePlan: ["fp"] });
        await dashboard.consumeFingerprint(`${agent}-p1`, "fp");
        await dashboard.post({ id: `${agent}-report`, agent, kind: "report", title: "Report", summary: "", dataJson: "{}", conversationId: "c" });
        await dashboard.saveSnapshot(agent, "stats", "{}");
      }
      await dashboard.saveSettings("helper", JSON.stringify({ tone: "plain" }));
      await dashboard.logRequest({ agent: "helper", tool: "t", actionId: "a", connection: "c", method: "GET", host: "h", path: "/", outcome: "sent" });
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM consumed_writes").one().n).toBe(2);
    });

    const puts = (prefix: string, n: number) => Promise.all(Array.from({ length: n }, (_, i) => env.IMAGES.put(`${prefix}${i}.json`, "{}")));
    await puts("helper/acme/projects/", 1005);
    await puts("helper/acme/domains/", 2);
    await puts("helper/other/projects/", 1);
    await puts("helper/acme-two/projects/", 1);
    await puts("second/acme/posts/", 1);

    const response = await reset("helper", await staff(), { conversationIds: ["web-old"] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ agent: "helper", done: true, conversations: 3, cards: 2, approvals: 1, snapshots: 1, records: 1007 });

    // Helper's chat history is gone, Third's is not.
    for (const id of ["web-r1", "web-r2", "web-old"]) expect(await history("helper", id, "alex")).toEqual([]);
    expect(await history("second", "web-a1", "alex")).toHaveLength(2);
    expect(await runInDurableObject(conversationStub("helper", "web-r1", "other"), (_instance, state) => new Store(state.storage).meta("owner"))).toBe("other/helper");

    // Dashboard: Helper's rows are gone, Third's stay; settings and the connection log stay.
    await runInDurableObject(dashboardStub(), async (dashboard, state) => {
      const sql = state.storage.sql;
      const count = (table: string, agent: string) => sql.exec(`SELECT COUNT(*) AS n FROM ${table} WHERE agent = ?`, agent).one().n;
      // Third keeps its report card and its approval card, its proposal and its snapshot.
      for (const [table, third] of [["cards", 2], ["approvals", 1], ["snapshots", 1], ["conversations", 1]] as const) {
        expect(count(table, "helper"), table).toBe(0);
        expect(count(table, "second"), table).toBe(third);
      }
      expect(await dashboard.conversationIds("second", 10)).toEqual(["web-a1"]);
      expect(sql.exec("SELECT action_id FROM consumed_writes").toArray()).toEqual([{ action_id: "second-p1" }]);
      expect(JSON.parse(await dashboard.settingOverrides("helper"))).toEqual({ tone: "plain" });
      expect(count("connection_log", "helper")).toBe(1);
    });

    // R2: only helper/acme/ went.
    expect(await keys("helper/acme/")).toEqual([]);
    expect(await keys("helper/other/")).toHaveLength(1);
    expect(await keys("helper/acme-two/")).toHaveLength(1);
    expect(await keys("second/acme/")).toHaveLength(1);
  }, 60_000);

  it("is refused without a staff dashboard pass, whatever the client token", async () => {
    await chat("helper", "web-guard", "alex");
    expect((await reset("helper", null)).status).toBe(401); // client token only
    expect((await reset("helper", await signUserPass(DASHBOARD_KEY, "acme", "staff-1", inAnHour()))).status).toBe(401); // a memory-style pass
    expect((await reset("helper", await signUserPass(APPROVER_KEY, "acme", "staff-1", inAnHour(), "approve"))).status).toBe(401); // an approver pass
    expect((await reset("helper", await signUserPass(USER_KEY, "acme", "alex", inAnHour(), "dashboard"))).status).toBe(401); // wrong key
    expect((await reset("helper", "nonsense")).status).toBe(401);
    expect((await reset("helper", await staff(), {}, { "content-type": "application/json" } as typeof auth)).status).toBe(401); // pass without the client token
    expect(await history("helper", "web-guard", "alex")).toHaveLength(2);
  });

  it("rejects an unknown agent and a bad conversation list", async () => {
    expect((await reset("iris", await staff())).status).toBe(404);
    expect((await reset("helper", await staff(), { conversationIds: "web-1" })).status).toBe(400);
    expect((await reset("helper", await staff(), { conversationIds: ["has space"] })).status).toBe(400);
  });
});
