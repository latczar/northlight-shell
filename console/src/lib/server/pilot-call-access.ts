import "server-only";
import { browserCallsOn } from "./iris-voice";

/** A handset caller (phone set) sees calls from that handset; anyone else sees their own browser calls (userId set). */
type Caller = { phone: string; since: number | null } | { phone: null; userId: string; since: null };

/**
 * Staff identity comes from the verified session. A handset assignment starts at a UTC Unix timestamp. Without one, a
 * person sees their own browser calls when browser calls are switched on.
 */
export function historyCaller(email: string, client: string, agent: string, userId?: string): Caller | null {
  if (!process.env.IRIS_CALL_HISTORY_KEY || client !== "kestrel" || agent !== "iris" || !userId) return null;
  const handset = handsetCaller(userId);
  if (handset !== undefined) return handset;
  return browserCallsOn() ? { phone: null, userId, since: null } : null;
}

/** The person's handset, null when the assignments are broken (nobody sees phone calls), undefined when they have none. */
function handsetCaller(userId: string): { phone: string; since: number } | null | undefined {
  const config = process.env.KESTREL_HISTORY_CALLERS;
  if (!config) return undefined;
  try {
    const entries: unknown = JSON.parse(config);
    if (!Array.isArray(entries)) return null;
    const ids = new Set<string>();
    const phones = new Set<string>();
    let caller: { phone: string; since: number } | undefined;
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
