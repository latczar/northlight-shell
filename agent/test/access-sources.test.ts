import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CLIENTS } from "../clients";
import { signAccess, validateAccess } from "../src/access";
import { Store } from "../src/store";
import { signUserPass } from "../src/user-auth";

const BEACON = CLIENTS.find(c => c.id === "beacon")!;
const headers = { authorization: "Bearer test-token-beacon-0123456789abcdef", "content-type": "application/json" };
const now = () => Math.floor(Date.now() / 1000);
const dashboard = () => env.DASHBOARD.get(env.DASHBOARD.idFromName("beacon"));
const pass = (who: string) => signUserPass("test-approver-key-beacon-0123456789abcdef", "beacon", who, now() + 3600, "approve");
let version = 0;
async function push(approvers: Record<string, string[]>, managers: Record<string, string[]> = {}) {
  const body = JSON.stringify({ version: ++version, approvers, managers });
  const timestamp = String(now());
  return SELF.fetch("https://brain/v1/access/approvers", { method: "PUT", body, headers: {
    ...headers, "x-access-timestamp": timestamp,
    "x-access-signature": await signAccess("test-access-key-beacon-0123456789abcdef", "beacon", timestamp, body),
  } });
}
async function propose(id: string, agent = "helper") {
  await dashboard().propose({ id, agent, conversationId: `web-${id}`, tool: "create_record", title: "Book", summary: "A meeting.", previewJson: "{}", requestedBy: agent === "helper" ? "app-helper" : "app-third", source: "app" });
  await runInDurableObject(env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`beacon/${agent}/web-${id}`)), (_instance, state) => { new Store(state.storage).bind("beacon", agent); });
}
const decide = async (id: string, who: string) => SELF.fetch(`https://brain/v1/approvals/${id}`, {
  method: "POST", headers: { ...headers, "x-approver-pass": await pass(who) }, body: JSON.stringify({ decision: "decline" }),
});
const save = async (who: string) => SELF.fetch("https://brain/v1/agents/third/settings", {
  method: "PUT", headers: { ...headers, "x-approver-pass": await pass(who) }, body: JSON.stringify({ settings: { blogsPerMonth: 3 } }),
});

describe("Beacon app rights are separate from unchanged Slack and voice approvers", () => {
  it("accepts synced access with a legacy list but still rejects an invalid key or empty agent set", () => {
    expect(() => validateAccess(BEACON)).not.toThrow();
    expect(() => validateAccess({ ...BEACON, agents: [] })).toThrow(/no agents/);
    expect(() => validateAccess({ ...BEACON, accessSigningEnv: "not an env name" })).toThrow(/env var/);
  });

  it("fails closed before sync, including for every legacy approver", async () => {
    expect((await push({})).status).toBe(200);
    await propose("access-before-sync");
    for (const who of ["jess", "alex", "robin", "outsider"]) {
      expect((await decide("access-before-sync", who)).status).toBe(403);
      expect((await save(who)).status).toBe(403);
    }
    expect(JSON.parse((await dashboard().approvalJson("access-before-sync"))!).status).toBe("pending");
  });

  it("uses only the proposal agent's synced approvers and only managers for settings, including after revocation", async () => {
    expect((await push({ helper: ["app-helper"], third: ["app-third"] }, { third: ["app-manager"] })).status).toBe(200);
    await propose("access-helper");
    await propose("access-third", "third");
    for (const who of ["jess", "alex", "robin", "app-third", "app-manager"]) expect((await decide("access-helper", who)).status).toBe(403);
    expect((await decide("access-helper", "app-helper")).status).toBe(200);
    expect((await decide("access-third", "app-helper")).status).toBe(403);
    expect((await decide("access-third", "app-third")).status).toBe(200);
    expect((await save("app-third")).status).toBe(403);
    expect((await save("app-manager")).status).toBe(200);
    expect((await push({})).status).toBe(200);
    await propose("access-revoked");
    expect((await decide("access-revoked", "app-helper")).status).toBe(403);
    expect((await save("app-manager")).status).toBe(403);
  });

  it("accepts a Beacon user pass, isolates their history, and refuses a ACME pass", async () => {
    const cid = "beacon-app-user";
    await runInDurableObject(env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`beacon/helper/${cid}`)), instance => {
      instance.model = { async turn(request) {
        request.onText?.("Your calendar is ready to check.");
        return { content: "Your calendar is ready to check.", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      } };
    });
    const userPass = await signUserPass("test-signing-key-beacon-0123456789abcdef", "beacon", "app-user", now() + 3600);
    const url = `https://brain/v1/agents/helper/conversations/${cid}/messages`;
    const response = await SELF.fetch(url, { method: "POST", headers, body: JSON.stringify({ id: "m1", text: "Check my calendar", userAuth: userPass }) });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Your calendar is ready to check.");
    const history = await SELF.fetch(url, { headers: { ...headers, "x-user-pass": userPass } });
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({ messages: [{ role: "user", text: "Check my calendar" }, { role: "assistant", text: "Your calendar is ready to check." }] });
    const other = await signUserPass("test-signing-key-beacon-0123456789abcdef", "beacon", "other-user", now() + 3600);
    expect((await SELF.fetch(url, { headers: { ...headers, "x-user-pass": other } })).status).toBe(404);
    const acme = await signUserPass("test-signing-key-acme-0123456789abcdef", "acme", "app-user", now() + 3600);
    expect((await SELF.fetch(url, { method: "POST", headers, body: JSON.stringify({ text: "Hello", userAuth: acme }) })).status).toBe(401);
  });
});
