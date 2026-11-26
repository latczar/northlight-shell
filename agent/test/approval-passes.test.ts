import { createExecutionContext, env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { CLIENTS } from "../clients";
import worker from "../src/index";
import { Store } from "../src/store";
import { signUserPass } from "../src/user-auth";
import { allowApprover, APPROVER } from "./access";

const auth = { authorization: "Bearer test-token-acme-0123456789abcdef", "content-type": "application/json" };
const APPROVER_KEY = "test-approver-key-acme-0123456789abcdef";
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
const approverPass = (who = APPROVER) => signUserPass(APPROVER_KEY, "acme", who, inAnHour(), "approve");
const adminPass = (who = "app-admin", key = APPROVER_KEY, purpose = "admin", expires = inAnHour()) => signUserPass(key, "acme", who, expires, purpose);
const dashboard = () => env.DASHBOARD.get(env.DASHBOARD.idFromName("acme"));
beforeEach(async () => { await allowApprover(); });

async function propose(conversationId: string, title: string, requestedBy: string | null = APPROVER) {
  const id = `call-${conversationId}`;
  await dashboard().propose({ id, agent: "helper", conversationId, title, tool: "test_publish", summary: "", previewJson: "{}", requestedBy });
  await runInDurableObject(env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`acme/helper/${conversationId}`)), (_instance, state) => {
    new Store(state.storage).bind("acme", "helper", APPROVER);
  });
  return { id };
}

describe("approval passes", () => {
  it("rejects forged, expired, wrong-purpose and wrong-client admin passes with 401", async () => {
    const { id } = await propose("web-invalid-admin", "Do not decide");
    const before = await dashboard().approvalJson(id);
    for (const pass of [
      await adminPass("app-admin", "x".repeat(40)),
      await adminPass("app-admin", APPROVER_KEY, "admin", Math.floor(Date.now() / 1000) - 1),
      await adminPass("app-admin", APPROVER_KEY, "approve"),
      await adminPass("app-admin", APPROVER_KEY, ""),
      await signUserPass(APPROVER_KEY, "beacon", "app-admin", inAnHour(), "admin"),
      "",
    ]) {
      const response = await SELF.fetch(`https://brain/v1/approvals/${id}`, {
        method: "POST", headers: { ...auth, "x-admin-pass": pass }, body: JSON.stringify({ decision: "approve" }),
      });
      expect(response.status).toBe(401);
    }
    expect(await dashboard().approvalJson(id)).toBe(before);
  });

  it("preserves the static approver rule without access sync, including anonymous and other people's requests", async () => {
    const client = CLIENTS.find(client => client.id === "acme")!;
    const previous = { accessSigningEnv: client.accessSigningEnv, approvers: client.approvers };
    const bindings = { ...env, MEDIA_LIMITER: env.CLIENT_LIMITER, LEADS_LIMITER: env.CLIENT_LIMITER, LEAD_INTAKE_LIMITER: env.CLIENT_LIMITER };
    try {
      client.accessSigningEnv = undefined;
      client.approvers = ["static-approver"];
      for (const [cid, requestedBy] of [["test-static-anonymous", null], ["web-static-someone-else", APPROVER]] as const) {
        const { id } = await propose(cid, "Static", requestedBy);
        const response = await worker.fetch(new Request(`https://brain/v1/approvals/${id}`, {
          method: "POST", headers: { ...auth, "x-approver-pass": await approverPass("static-approver") }, body: JSON.stringify({ decision: "decline" }),
        }), bindings, createExecutionContext());
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ status: "declined", decidedBy: "static-approver", requestedBy });
      }
      const { id } = await propose("web-static-refused", "Not a static approver");
      const response = await worker.fetch(new Request(`https://brain/v1/approvals/${id}`, {
        method: "POST", headers: { ...auth, "x-approver-pass": await approverPass() }, body: JSON.stringify({ decision: "decline" }),
      }), bindings, createExecutionContext());
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "This person may not approve for this agent." });
      expect(JSON.parse((await dashboard().approvalJson(id))!).status).toBe("pending");
    } finally {
      Object.assign(client, previous);
    }
  });
});

describe("alternative approval passes", () => {
  it("accepts either valid authorization when both pass headers are present", async () => {
    for (const useAdmin of [true, false]) {
      const { id } = await propose(`web-either-pass-${useAdmin}`, "Either pass");
      const response = await SELF.fetch(`https://brain/v1/approvals/${id}`, {
        method: "POST", headers: {
          ...auth,
          "x-admin-pass": useAdmin ? await adminPass() : "invalid",
          "x-approver-pass": useAdmin ? "invalid" : await approverPass(),
        }, body: JSON.stringify({ decision: "decline" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "declined", decidedBy: useAdmin ? "app-admin" : APPROVER });
    }
  });
});
