import { brainBindings, toolBindings } from "./bindings";
import type { AgentTemplate, ClientConfig, ToolContext } from "./contracts";
import type { Env } from "./conversation";
import { deskClientContext, loadDeskState } from "./desk-client";
import { agentSettings } from "./settings";
import { BRIEFING_FRESH_MS } from "./voice";

// The call briefing: when a phone call starts, the data its first questions will ask for is read once, in the background, and
// stored on the call's conversation (src/conversation.ts setBriefing) so the voice prompt can answer from it without tools.
// What goes in it is each agent's own `briefing` (read-only, through the same desk rules as its tools; no model call).

const TIMEOUT_MS = 25_000;
/** The latest briefing per client and agent, so many calls in a few minutes read the accounts once. Test seam: tests clear it. shortcut: per isolate, lost on restart; a Dashboard row if calls get frequent. */
export const recentBriefings = new Map<string, { at: number; text: string }>();

/** Reads the agent's briefing (or reuses one under 15 minutes old, unless the agent wants it read for every call) and stores it on the call's conversation. Never throws into phone-start: the caller logs. */
export async function warmBriefing(env: Env, client: ClientConfig, agent: AgentTemplate, conversationId: string): Promise<void> {
  if (!agent.briefing) return;
  const key = `${client.id}/${agent.id}`;
  let hit = agent.briefingEveryCall ? undefined : recentBriefings.get(key);
  if (!hit || Date.now() - hit.at >= BRIEFING_FRESH_MS) {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const actionId = `briefing-${conversationId}`.slice(0, 200);
    const dashboard = env.DASHBOARD.get(env.DASHBOARD.idFromName(client.id));
    const context: ToolContext = {
      clientId: client.id, agentId: agent.id, conversationId, actionId, signal, bindings: toolBindings(brainBindings(env)),
      actionResult: () => undefined, brokenRule: () => undefined, settings: await agentSettings(env, client, agent.id),
      // A briefing never spends: anything that wants to pay is refused.
      reserveSpend: async () => false,
      ...deskClientContext({ desk: env.DESK, state: await loadDeskState(env.DESK, client.id, agent.id), client, agentId: agent.id, toolName: "call_briefing", actionId, signal }),
    };
    const text = await agent.briefing({
      client, context,
      snapshot: async kind => { const raw = await dashboard.snapshot(agent.id, kind); return raw === undefined ? undefined : JSON.parse(raw); },
    });
    if (!text) return;
    hit = { at: Date.now(), text };
    if (!agent.briefingEveryCall) recentBriefings.set(key, hit);
  }
  await env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`${client.id}/${agent.id}/${conversationId}`)).setBriefing(client.id, agent.id, hit.text);
}
