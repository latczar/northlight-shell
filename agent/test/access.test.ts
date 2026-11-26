import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parseApprovers, signAccess } from "../src/access";
import { Store } from "../src/store";
import { signUserPass } from "../src/user-auth";

const ACCESS_KEY = "test-access-key-acme-0123456789abcdef";
const token = { authorization: "Bearer test-token-acme-0123456789abcdef", "content-type": "application/json" };
const now = () => Math.floor(Date.now() / 1000);
const dashboard = () => env.DASHBOARD.get(env.DASHBOARD.idFromName("acme"));

const approverPass = (who: string) => signUserPass("test-approver-key-acme-0123456789abcdef", "acme", who, now() + 3600, "approve");

// Versions only ever go up, like the agents app's sequence; tests share one Dashboard per file.
let version = 1_000;

/** What the agents app does: a signed PUT of the full approver and manager state. */
async function push(approvers: unknown, over: { managers?: unknown; version?: unknown; body?: string; key?: string; timestamp?: number; headers?: Record<string, string> } = {}) {
  const body = over.body ?? JSON.stringify({ version: over.version ?? ++version, approvers, managers: "managers" in over ? over.managers : {} });
  const timestamp = String(over.timestamp ?? now());
  return SELF.fetch("https://brain/v1/access/approvers", {
    method: "PUT", body,
    headers: { ...token, "x-access-timestamp": timestamp, "x-access-signature": await signAccess(over.key ?? ACCESS_KEY, "acme", timestamp, body), ...over.headers },
  });
}

describe("PUT /v1/access/approvers", () => {
  it("stores the full state per agent and replies applied", async () => {
    const response = await push({ helper: ["u-helper"], second: ["u-second", "u-both"] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applied: true });
    expect(await dashboard().mayApprove("u-helper", "helper")).toBe(true);
    expect(await dashboard().mayApprove("u-helper", "second")).toBe(false);
    expect(await dashboard().mayApprove("u-both", "second")).toBe(true);
    expect(await dashboard().mayApprove("u-second", "helper")).toBe(false);

    // The next push is the whole state: an approver left out loses the right, and an omitted agent has none.
    await push({ second: ["u-both"] });
    expect(await dashboard().mayApprove("u-helper", "helper")).toBe(false);
    expect(await dashboard().mayApprove("u-second", "second")).toBe(false);
    expect(await dashboard().mayApprove("u-both", "second")).toBe(true);
  });

  it("refuses a missing token, a bad or missing signature, and a stale or malformed timestamp, storing nothing", async () => {
    await push({ helper: ["u-keep"] });
    const attempt = { helper: ["u-evil"] };
    expect((await push(attempt, { headers: { authorization: "" } })).status).toBe(401);
    expect((await push(attempt, { key: "x".repeat(40) })).status).toBe(401);
    expect((await push(attempt, { headers: { "x-access-signature": "" } })).status).toBe(401);
    expect((await push(attempt, { headers: { "x-access-signature": `v1=${"0".repeat(64)}` } })).status).toBe(401);
    expect((await push(attempt, { timestamp: now() - 301 })).status).toBe(401); // signed correctly, but too old
    expect((await push(attempt, { timestamp: now() + 301 })).status).toBe(401);
    expect((await push(attempt, { headers: { "x-access-timestamp": "soon" } })).status).toBe(401);
    // The signature covers the exact body: a signature for another body does not carry over.
    const signed = JSON.stringify({ version: ++version, approvers: { helper: ["u-keep"] } });
    const timestamp = String(now());
    const forged = await SELF.fetch("https://brain/v1/access/approvers", {
      method: "PUT", body: JSON.stringify({ version: version + 1, approvers: attempt }),
      headers: { ...token, "x-access-timestamp": timestamp, "x-access-signature": await signAccess(ACCESS_KEY, "acme", timestamp, signed) },
    });
    expect(forged.status).toBe(401);
    expect(await dashboard().mayApprove("u-evil", "helper")).toBe(false);
    expect(await dashboard().mayApprove("u-keep", "helper")).toBe(true);
  });

  it("refuses a signature made for another client", async () => {
    const timestamp = String(now());
    const body = JSON.stringify({ version: ++version, approvers: { helper: ["u-other"] } });
    const response = await SELF.fetch("https://brain/v1/access/approvers", {
      method: "PUT", body, headers: { ...token, "x-access-timestamp": timestamp, "x-access-signature": await signAccess(ACCESS_KEY, "someone-else", timestamp, body) },
    });
    expect(response.status).toBe(401);
  });

  it("answers 400 for agents that are not the client's and bodies of the wrong shape, and stores nothing", async () => {
    const before = ++version;
    expect((await push({ zed: ["u1"] }, { version: before })).status).toBe(400);
    expect((await push({}, { version: before, managers: { zed: ["u1"] } })).status).toBe(400);
    expect((await push({}, { body: JSON.stringify({ version: before, approvers: {} }) })).status).toBe(400); // managers is required
    expect((await push({}, { body: "not json" })).status).toBe(400);
    // Nothing above was stored, so the same version still applies.
    expect(await (await push({ helper: ["u-ok"] }, { version: before })).json()).toEqual({ applied: true });
  });

  it("validates both lists strictly (agents of the client, plain user ids, a positive whole version, no extra or missing fields)", () => {
    const agents = ["helper", "second"];
    const ok = { version: 5, approvers: { helper: ["u1"] }, managers: {} };
    expect(parseApprovers(JSON.stringify(ok), agents)).toEqual(ok);
    expect(parseApprovers(JSON.stringify({ ...ok, managers: { second: ["u1", "u1"] } }), agents)).toMatchObject({ managers: { second: ["u1"] } }); // de-duplicated
    const bad = (body: object | string) => typeof parseApprovers(typeof body === "string" ? body : JSON.stringify(body), agents) === "string";
    for (const lists of [{ zed: ["u1"] }, { "helper ": ["u1"] }, { helper: "u1" }, { helper: [1] }, { helper: ["bad id"] }, { helper: Array(201).fill("u") }, [], null, "x"]) {
      expect(bad({ ...ok, approvers: lists })).toBe(true);
      expect(bad({ ...ok, managers: lists })).toBe(true);
    }
    expect(bad({ version: 5, approvers: {} })).toBe(true); // managers required
    expect(bad({ version: 5, managers: {} })).toBe(true); // approvers required
    expect(bad({ ...ok, extra: 1 })).toBe(true);
    for (const version of [undefined, 0, -1, 1.5, "7", null]) expect(bad({ ...ok, version })).toBe(true);
    expect(bad("not json")).toBe(true);
    expect(bad("[]")).toBe(true);
  });

  it("ignores a strictly older version, so a late push never restores an approver or manager a newer one removed", async () => {
    const older = ++version, newer = ++version;
    await push({ helper: ["u-a", "u-b"] }, { version: older, managers: { helper: ["u-a", "u-b"] } });
    expect(await (await push({ helper: ["u-a"] }, { version: newer, managers: { helper: ["u-a"] } })).json()).toEqual({ applied: true });
    // The older state arrives late (a retried or reordered push): refused, and u-b stays removed from both lists.
    const late = await push({ helper: ["u-a", "u-b"] }, { version: older, managers: { helper: ["u-a", "u-b"] } });
    expect(late.status).toBe(200);
    expect(await late.json()).toEqual({ applied: false });
    expect(await dashboard().mayApprove("u-b", "helper")).toBe(false);
    expect(await dashboard().mayManage("u-b", "helper")).toBe(false);
    expect(await dashboard().mayApprove("u-a", "helper")).toBe(true);
    expect(await dashboard().mayManage("u-a", "helper")).toBe(true);
    // The same version again is accepted (idempotent) and changes nothing.
    expect(await (await push({ helper: ["u-a"] }, { version: newer, managers: { helper: ["u-a"] } })).json()).toEqual({ applied: true });
    expect(await dashboard().mayApprove("u-b", "helper")).toBe(false);
    expect(await dashboard().mayManage("u-b", "helper")).toBe(false);
  });

  it("stores managers per agent, apart from approvers, replacing them with each push", async () => {
    await push({ helper: ["u-appr"] }, { managers: { helper: ["u-mgr"], second: ["u-appr"] } });
    expect(await dashboard().mayManage("u-mgr", "helper")).toBe(true);
    expect(await dashboard().mayManage("u-mgr", "second")).toBe(false);
    expect(await dashboard().mayManage("u-appr", "helper")).toBe(false); // an approver is not a manager
    expect(await dashboard().mayApprove("u-mgr", "helper")).toBe(false); // a manager is not an approver
    expect(await dashboard().mayManage("u-appr", "second")).toBe(true);
    await push({}, { managers: { helper: ["u-mgr"] } });
    expect(await dashboard().mayManage("u-appr", "second")).toBe(false);
    expect(await dashboard().mayManage("u-mgr", "helper")).toBe(true);
  });
});

describe("approving needs the approval's agent's list", () => {
  const propose = (id: string, agent: string) =>
    dashboard().propose({ id, agent, conversationId: `web-${id}`, tool: "test_publish", title: "Publish", summary: "A post.", previewJson: "{}", requestedBy: agent === "second" ? "u-second" : "u-helper", source: "app" });
  /** The conversation the proposal came from, so a decision has somewhere to land. */
  const conversation = (id: string, agent: string) => runInDurableObject(env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`acme/${agent}/web-${id}`)),
    (_instance, state) => { new Store(state.storage).bind("acme", agent); });
  const decide = async (id: string, who: string, decision = "decline") => SELF.fetch(`https://brain/v1/approvals/${id}`, {
    method: "POST", headers: { ...token, "x-approver-pass": await approverPass(who) }, body: JSON.stringify({ decision }),
  });
  const status = async (id: string) => (JSON.parse((await dashboard().approvalJson(id))!) as { status: string; decidedBy?: string });

  it("lets Second's approver decide Second's proposal, and refuses Helper's approver and a person on no list", async () => {
    await push({ helper: ["u-helper"], second: ["u-second"] });
    await propose("acc-1", "second");
    await conversation("acc-1", "second");

    expect((await decide("acc-1", "u-helper")).status).toBe(403); // another agent's approver
    expect((await decide("acc-1", "u-nobody")).status).toBe(403); // on no list
    expect(await status("acc-1")).toMatchObject({ status: "pending" });

    const decided = await decide("acc-1", "u-second");
    expect(decided.status).toBe(200);
    expect(await status("acc-1")).toMatchObject({ status: "declined", decidedBy: "u-second" });
  });

  it("refuses everyone while no list is held for the agent, and a decided approval stays with its first decider", async () => {
    await push({ helper: ["u-helper"] });
    await propose("acc-2", "second");
    expect((await decide("acc-2", "u-helper")).status).toBe(403);
    expect((await decide("acc-2", "u-second")).status).toBe(403);
    expect(await status("acc-2")).toMatchObject({ status: "pending" });
    expect((await decide("missing-approval", "u-helper")).status).toBe(404);
  });

  it("revokes at once: an approver removed by a later push can no longer decide", async () => {
    await push({ second: ["u-second"] });
    await propose("acc-3", "second");
    await push({ second: [] });
    expect((await decide("acc-3", "u-second")).status).toBe(403);
    expect(await status("acc-3")).toMatchObject({ status: "pending" });
  });

});
