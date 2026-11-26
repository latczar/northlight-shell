import { env } from "cloudflare:test";

// Test helper: what the agents app pushes (PUT /v1/access/approvers), written straight to Acme Test Co's Dashboard.

/** An agents-app user id the tests approve and manage as. */
export const APPROVER = "test-approver-0001";

/** Makes `who` an approver and a manager of `agents` (default: all of Acme Test Co's) and of nothing else. */
export function allowApprover(who = APPROVER, agents = ["helper", "second"]) {
  const lists = Object.fromEntries(agents.map(agent => [agent, [who]]));
  return env.DASHBOARD.get(env.DASHBOARD.idFromName("acme")).setApprovers(Number.MAX_SAFE_INTEGER, lists, lists);
}
