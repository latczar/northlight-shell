import type { AgentTemplate, ClientConfig, Limits } from "./contracts";

// Web defaults: long dialogues are fine,
// autonomous work between two user messages stays bounded.
export const DEFAULT_LIMITS: Limits = {
  maxTurnSteps: 24,
  maxTurnActiveMs: 300_000,
  maxCostUsd: 2,
  maxJobCostUsd: 1,
  modelTimeoutMs: 60_000,
};

export function resolveLimits(...overrides: (Partial<Limits> | undefined)[]): Limits {
  return Object.assign({}, DEFAULT_LIMITS, ...overrides.filter(Boolean));
}

/** Per-client agent limits win over shared defaults; explicit turn/job overrides win last. */
export function limitsFor(client: ClientConfig, agent: AgentTemplate, voice = false, overrides?: Partial<Limits>): Limits {
  const limits = resolveLimits(client.limits, agent.limits);
  const { modelTimeoutMs, maxTurnActiveMs } = limits;
  Object.assign(limits, client.agentLimits?.[agent.id]);
  // The agent's longer off-call timings must not make callers wait longer.
  if (voice) {
    limits.modelTimeoutMs = modelTimeoutMs;
    limits.maxTurnActiveMs = maxTurnActiveMs;
  }
  return Object.assign(limits, overrides);
}

/** null explicitly disables a cumulative limit. */
export function remainingLimit(limit: number | null | undefined, used: number): number {
  return limit == null ? Infinity : limit - used;
}
