import type { ActionRecord, AdminStuckStep, StuckStep, ToolContext, ToolDefinition } from "./contracts";
import { SLACK_USER } from "./slack";

/** An uncertain action whose tool has a checked retry, for the admin list of steps that need a person's check. */
export async function stuckStep(action: ActionRecord, tool: ToolDefinition | undefined, agent: string, conversationId: string, _context: Pick<ToolContext, "clientId" | "bindings">): Promise<StuckStep | undefined> {
  if (!tool?.checkedRetry || action.status !== "uncertain") return undefined;
  return { actionId: action.id, agent, conversationId, tool: action.tool, label: tool.checkedRetry.label(action.args) ?? tool.label ?? action.tool.replace(/_/g, " "), createdAt: action.createdAt, error: action.error ?? "" };
}


export function requestOrigin(source: AdminStuckStep["source"] = "other", userId?: string): Pick<AdminStuckStep, "requestedBy" | "source"> {
  const requestedBy = userId && userId !== SLACK_USER ? userId : null;
  return { requestedBy, source: requestedBy ? "app" : source };
}

export function legacyRequestOrigin(conversationId: string, userId?: string): Pick<AdminStuckStep, "requestedBy" | "source"> {
  const appVoice = conversationId.startsWith("voice-") && userId !== undefined && userId !== SLACK_USER;
  const source = conversationId.startsWith("web-") || appVoice ? "app" : conversationId.startsWith("phone-") ? "phone" : conversationId.startsWith("slack-") ? "slack" : conversationId.startsWith("job-") ? "scheduled" : "other";
  return { requestedBy: source === "app" && userId !== SLACK_USER ? userId ?? null : null, source };
}

export function adminStuckStep(step: StuckStep, userId?: string, source?: AdminStuckStep["source"]): AdminStuckStep {
  return { ...step, ...(source === undefined ? legacyRequestOrigin(step.conversationId, userId) : requestOrigin(source, userId)) };
}
