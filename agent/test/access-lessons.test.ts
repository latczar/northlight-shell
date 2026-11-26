import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signAccess } from "../src/access";
import type { Lesson } from "../src/learning";
import { signUserPass } from "../src/user-auth";

// Its own file so its requests count against a fresh per-minute client limit.
const ACCESS_KEY = "test-access-key-acme-0123456789abcdef";
const token = { authorization: "Bearer test-token-acme-0123456789abcdef", "content-type": "application/json" };
const now = () => Math.floor(Date.now() / 1000);
const approverPass = (who: string) => signUserPass("test-approver-key-acme-0123456789abcdef", "acme", who, now() + 3600, "approve");
let version = 1_000;

/** What the agents app does: a signed PUT of the full approver state (no managers needed here). */
async function push(approvers: unknown) {
  const body = JSON.stringify({ version: ++version, approvers, managers: {} });
  const timestamp = String(now());
  return SELF.fetch("https://brain/v1/access/approvers", {
    method: "PUT", body, headers: { ...token, "x-access-timestamp": timestamp, "x-access-signature": await signAccess(ACCESS_KEY, "acme", timestamp, body) },
  });
}

describe("deciding a lesson", () => {
  const learning = env.LEARNING.get(env.LEARNING.idFromName("acme"));
  const lesson = (agent: string | null, id: string) => ({ agent, kind: "preference" as const, text: `Lesson text ${id} for ${agent ?? "everyone"}.`, evidence: "say it like this", conversationId: "c1" });
  const decide = async (id: string, who: string) => SELF.fetch(`https://brain/v1/lessons/${id}`, {
    method: "POST", headers: { ...token, "x-approver-pass": await approverPass(who) }, body: JSON.stringify({ decision: "approve" }),
  });
  const stored = async (id: string) => (await learning.list("second")).find((l: Lesson) => l.id === id)?.status;

  it("needs the lesson's agent's list", async () => {
    await push({ helper: ["u-helper"], second: ["u-second"] });
    await learning.propose("acc-l1", lesson("second", "acc-l1"));
    expect((await decide("acc-l1", "u-helper")).status).toBe(403);
    expect(await stored("acc-l1")).toBe("proposed");
    expect((await decide("acc-l1", "u-second")).status).toBe(200);
    expect(await stored("acc-l1")).toBe("active");
  });

  it("lets anyone on any agent's list decide a lesson with no agent, and nobody else", async () => {
    await push({ helper: ["u-helper"] });
    await learning.propose("acc-l2", lesson(null, "acc-l2"));
    expect((await decide("acc-l2", "u-nobody")).status).toBe(403);
    expect(await stored("acc-l2")).toBe("proposed");
    expect((await decide("acc-l2", "u-helper")).status).toBe(200);
    expect(await stored("acc-l2")).toBe("active");
  });

  it("refuses everyone when no agent has a list, and answers 404 for an unknown lesson", async () => {
    await push({});
    await learning.propose("acc-l3", lesson(null, "acc-l3"));
    expect((await decide("acc-l3", "u-helper")).status).toBe(403);
    expect((await decide("nope", "u-helper")).status).toBe(404);
  });
});
