import type { SetupInput, SetupItem } from "./contracts";

/** A setup item for secrets set on the server: connected when every named env var is set. */
export function secretItem(input: SetupInput, id: string, label: string, names: string[], unlocks: string, optional?: boolean): SetupItem {
  const missing = names.filter(name => !input.has(name));
  return { id, label, kind: "secret", connected: missing.length === 0, missing, unlocks, ...(optional ? { optional } : {}) };
}

/** Ready when every item that is not optional is connected. */
export const isReady = (items: SetupItem[]) => items.every(item => item.connected || item.optional);
