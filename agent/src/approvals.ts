import type { ClientConfig } from "./contracts";
import type { Env } from "./conversation";
import type { Approval } from "./dashboard";
import { type Decision, STALE_SETTINGS } from "./loop";

/** The outcome of a decision: an HTTP status and the approval record as JSON (absent: not found). */
export interface DecisionReply { status: number; body?: string }

/** Runs a decided action in its conversation, with Conversation.decide's arguments. */
export type RunDecision = (clientId: string, agentId: string, conversationId: string, actionId: string, approve: boolean, reason: string, proposedSettingsHash?: string, approvedPlan?: string[]) => Promise<Decision>;

/**
 * Records a person's approve/decline once and, for an approval, runs the action in its conversation. Shared by the approvals
 * route (approver pass) and Slack's Approve buttons (src/slack.ts, run from the Conversation's own alarm, which passes its
 * `decide` as `run`); the caller has already checked who `decidedBy` is. Repeating a decision returns the stored outcome and
 * never runs the action twice; the opposite decision is refused with 409.
 */
export async function decideApproval(env: Env, client: ClientConfig, id: string, approve: boolean, decidedBy: string, reason: string, run?: RunDecision, choice?: string): Promise<DecisionReply> {
  const dashboard = env.DASHBOARD.get(env.DASHBOARD.idFromName(client.id));
  const recorded = await dashboard.decide(id, approve, decidedBy, reason, choice);
  if (!recorded) return { status: 404 };
  const parsed = JSON.parse(recorded);
  if (parsed.error) return { status: 400, body: recorded };
  const record = parsed as Approval;
  if ((record.status === "declined") === approve) return { status: 409, body: recorded };
  if (approve && record.choices && record.choice !== choice) return { status: 409, body: JSON.stringify({ ...record, error: `Already approved with ${record.choice}.` }) };
  if (record.status !== "approved" && record.status !== "declined") return { status: 200, body: recorded };

  // Approved but not yet finished (also after a crash between the two steps): run it now.
  const decide: RunDecision = run ?? ((...args) => env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`${client.id}/${record.agent}/${record.conversationId}`)).decide(...args));
  const decision = await decide(client.id, record.agent, record.conversationId, id, approve, reason, await dashboard.settingsHash(id), await dashboard.writePlan(id));
  if (!approve) {
    await dashboard.closeDeclined(id);
    return { status: 200, body: recorded };
  }
  const status = decision.status === "done" || decision.status === "failed" || decision.status === "stale" ? decision.status : "uncertain";
  const finished = await dashboard.finish(id, status === "stale" ? "failed" : status, decision.content);
  // Approved on a preview built from other settings: nothing ran, and the approver is told why.
  if (status === "stale" && finished) return { status: 409, body: JSON.stringify({ ...JSON.parse(finished), error: STALE_SETTINGS }) };
  return { status: finished ? 200 : 404, body: finished };
}
