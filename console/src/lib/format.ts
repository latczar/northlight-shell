// shortcut: every client is on UK time today (Kestrel Garage, Milbrook); add a zone per client when one is not.
// Servers run in UTC, so the zone is always explicit.
const ZONE = "Europe/London";
const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const time = new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, hour: "2-digit", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, weekday: "short" });
const date = new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, month: "short", day: "numeric" });
const full = new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, dateStyle: "medium", timeStyle: "short" });

/** Whole UK days from `ms` to `now`: 0 today, 1 yesterday. */
function daysAgo(ms: number, now: number): number {
  return Math.round((Date.parse(dayKey.format(now)) - Date.parse(dayKey.format(ms))) / 86_400_000);
}

/** "Just now", "12 min ago", "3 h ago" today; "Yesterday"; "Mon" within a week; else "30 Oct". */
export function formatAgo(ms: number, now = Date.now()): string {
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return "Just now";
  if (daysAgo(ms, now) <= 0) return minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`;
  return formatWhen(ms, now);
}

/** "09:42" today, "Yesterday", "Mon" within a week, else "30 Oct". */
export function formatWhen(ms: number, now = Date.now()): string {
  const days = daysAgo(ms, now);
  if (days <= 0) return time.format(ms);
  if (days === 1) return "Yesterday";
  if (days < 7) return weekday.format(ms);
  return date.format(ms);
}

/** For a title attribute or a detail: "24 Nov 2026, 09:42 (UK time)". */
export const formatFull = (ms: number) => `${full.format(ms)} (UK time)`;
