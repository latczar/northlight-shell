import "server-only";

type Caller = { phone: string; since: number | null };

/** Staff identity comes from the verified session. New assignments start at a UTC Unix timestamp. */
export function historyCaller(email: string, client: string, agent: string, userId?: string): Caller | null {
  if (!process.env.IRIS_CALL_HISTORY_KEY || client !== "kestrel" || agent !== "iris") return null;
  const config = process.env.KESTREL_HISTORY_CALLERS;
  if (!config || !userId) return null;
  try {
    const entries: unknown = JSON.parse(config);
    if (!Array.isArray(entries)) return null;
    const ids = new Set<string>();
    const phones = new Set<string>();
    let caller: Caller | null = null;
    for (const entry of entries) {
      if (!entry || typeof entry.userId !== "string" || !entry.userId ||
          typeof entry.phone !== "string" || !/^\+[1-9]\d{7,14}$/.test(entry.phone) ||
          !Number.isSafeInteger(entry.since) || entry.since <= 0 ||
          ids.has(entry.userId) || phones.has(entry.phone)) return null;
      ids.add(entry.userId);
      phones.add(entry.phone);
      if (entry.userId === userId) caller = { phone: entry.phone, since: entry.since };
    }
    return caller;
  } catch {
    return null;
  }
}
