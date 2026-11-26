import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { Store } from "../src/store";
import { loadJob, loadQueue, saveJob } from "../src/jobs";
import { signUserPass } from "../src/user-auth";

const headers = { authorization: "Bearer test-token-kestrel-0123456789abcdef", "content-type": "application/json" };
function freshCall() {
  const callId = "conv_" + crypto.randomUUID();
  return { callId, url: `https://brain/v1/agents/iris/calls/${callId}/services-draft` };
}
const agent = "iris";

async function as(person: string) {
  const pass = await signUserPass("test-signing-key-kestrel-0123456789abcdef", "kestrel", person, Math.floor(Date.now() / 1000) + 120);
  return { ...headers, "x-user-pass": pass };
}

describe("Services drafts from call history", () => {
  beforeAll(async () => {
    await env.DASHBOARD.getByName("kestrel").setApprovers(1, {}, { [agent]: ["manager", "colleague"] });
  });

  it("requires a signed manager and a Services transcript to start a job", async () => {
    const { url } = freshCall();
    expect((await SELF.fetch(url)).status).toBe(401);
    expect((await SELF.fetch(url, { headers: await as("reader") })).status).toBe(403);
    const manager = await as("manager");
    expect(await (await SELF.fetch(url, { headers: manager })).json()).toEqual({ state: "new" });
    for (const remarks of ["", "Homepage only", "Services " + "x".repeat(5000)]) {
      expect((await SELF.fetch(url, { headers: manager, method: "POST", body: JSON.stringify({ remarks }) })).status).toBe(400);
    }
    expect(await (await SELF.fetch(url, { headers: manager })).json()).toEqual({ state: "new" });
  });

  it("resumes one new attempt after a stopped job even when two devices retry", async () => {
    const { callId, url } = freshCall();
    const manager = await as("manager");
    const submit = () => SELF.fetch(url, { headers: manager, method: "POST", body: JSON.stringify({ remarks: "Check Services. Keep the design." }) });
    const stub = env.CONVERSATIONS.getByName("kestrel/iris/call-editorial/manager/" + callId);
    for (const response of await Promise.all([submit(), submit()])) expect(response.status).toBe(202);
    const stoppedAt = await runInDurableObject(stub, async (_instance, state) => {
      const store = new Store(state.storage);
      expect(loadJob(store)?.id).toBe("create");
      expect(loadQueue(store)).toHaveLength(0);
      saveJob(store, { ...loadJob(store)!, status: "stopped" });
      await state.storage.deleteAlarm();
      return loadJob(store)!.updatedAt;
    });
    expect(await (await SELF.fetch(url, { headers: manager })).json()).toEqual({ state: "retry" });
    for (const response of await Promise.all([submit(), submit()])) expect(response.status).toBe(202);
    await runInDurableObject(stub, (_instance, state) => {
      const store = new Store(state.storage);
      expect(loadJob(store)?.id).toBe("retry-" + stoppedAt);
      expect(loadQueue(store)).toHaveLength(0);
      return state.storage.deleteAlarm();
    });
  });

  it("returns the latest revision across repeated requests and isolates two managers", async () => {
    const desk = env.DASHBOARD.getByName("kestrel");
    const { callId, url } = freshCall();
    const base = { agent, tool: "submit_seo_copy", title: "Services title", summary: "Review the wording.", requestedBy: "manager", source: "app" as const };
    await desk.propose({ ...base, id: "original", conversationId: "call-editorial/manager/" + callId, previewJson: JSON.stringify({ sourceCall: callId }) });
    await desk.decide("original", false, "manager", "Start with brakes.");
    await desk.propose({ ...base, id: "revision", conversationId: "editorial-revision/original", previewJson: JSON.stringify({ revisionOf: "original" }) });
    const manager = await as("manager");
    const results = await Promise.all(["GET", "POST", "POST"].map(method => SELF.fetch(url, { method, headers: manager }).then(r => r.json())));
    for (const result of results) expect(result).toMatchObject({
      state: "ready", original: { id: "original", status: "declined", reason: "Start with brakes." }, latest: { id: "revision", status: "pending" },
    });
    expect(await (await SELF.fetch(url, { headers: await as("colleague") })).json()).toEqual({ state: "new" });
  });
});
