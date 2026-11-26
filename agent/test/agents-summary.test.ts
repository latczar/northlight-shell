import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const auth = { authorization: "Bearer test-token-acme-0123456789abcdef" };
const DAY = 24 * 60 * 60 * 1000;

describe("GET /v1/agents", () => {
  it("gives each agent its status, items to review and newest card", async () => {
    const stub = env.DASHBOARD.get(env.DASHBOARD.idFromName("acme"));
    await runInDurableObject(stub, async (dashboard, state) => {
      // Helper: two pending approvals. Second: an old card then a fresh one. Third: only a card from 2 days ago.
      await dashboard.propose({ id: "a1", agent: "helper", conversationId: "c1", tool: "t", title: "Buy domain", summary: "", previewJson: "{}" });
      await dashboard.propose({ id: "a2", agent: "helper", conversationId: "c2", tool: "t", title: "Publish", summary: "", previewJson: "{}" });
      await dashboard.propose({ id: "a3", agent: "helper", conversationId: "c3", tool: "t", title: "Done one", summary: "", previewJson: "{}" });
      await dashboard.decide("a3", false, "robin", "no");
      await dashboard.post({ id: "j-old", agent: "second", kind: "report", title: "Old check", summary: "", dataJson: "{}", conversationId: "c" });
      await dashboard.post({ id: "j-new", agent: "second", kind: "status", title: "Morning check", summary: "", dataJson: "{}", conversationId: "c" });
      await dashboard.post({ id: "a-old", agent: "third", kind: "report", title: "Monthly report", summary: "", dataJson: "{}", conversationId: "c" });
      const sql = state.storage.sql;
      sql.exec("UPDATE cards SET updated_at = ? WHERE id = 'j-old'", Date.now() - 1000);
      sql.exec("UPDATE cards SET updated_at = ? WHERE id = 'a-old'", Date.now() - 2 * DAY);
    });

    const response = await SELF.fetch("https://brain/v1/agents", { headers: auth });
    expect(response.status).toBe(200);
    const { agents } = await response.json() as { agents: { id: string; status: string; toReview: number; lastActive: number | null; latest: { title: string } | null }[] };
    const byId = Object.fromEntries(agents.map(a => [a.id, a]));
    expect(byId.helper).toMatchObject({ name: "Helper", role: "Test assistant", status: "needs_approval", toReview: 2 });
    expect(byId.second).toMatchObject({ status: "active", toReview: 0, latest: { title: "Morning check", kind: "status" } });
    expect(byId.third).toMatchObject({ status: "idle", toReview: 0, latest: { title: "Monthly report" } }); // Acme Test Co's own Third, from Acme Test Co's rows only.
    await runInDurableObject(env.DASHBOARD.get(env.DASHBOARD.idFromName("beacon")), async (dashboard, state) => {
      await dashboard.post({ id: "beacon-third-old", agent: "third", kind: "report", title: "Monthly report", summary: "", dataJson: "{}", conversationId: "c" });
      state.storage.sql.exec("UPDATE cards SET updated_at = ? WHERE id = 'beacon-third-old'", Date.now() - 2 * DAY);
    });
    const beacon = await SELF.fetch("https://brain/v1/agents", { headers: { authorization: "Bearer test-token-beacon-0123456789abcdef" } });
    expect(beacon.status).toBe(200);
    const result = await beacon.json() as { agents: { id: string; status: string; toReview: number; lastActive: number | null; latest: { title: string } | null }[] };
    const third = result.agents.find(agent => agent.id === "third")!;
    expect(third).toMatchObject({ status: "idle", toReview: 0, latest: { title: "Monthly report" } });
    expect(third.lastActive).toBeLessThan(Date.now() - DAY);
  });

  it("needs the client token", async () => {
    expect((await SELF.fetch("https://brain/v1/agents")).status).toBe(401);
  });
});
