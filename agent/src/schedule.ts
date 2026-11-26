import type { Schedule } from "./contracts";

// Works out when a schedule is due, in the schedule's own time zone, so "07:00 America/Chicago"
// stays 07:00 local through daylight-saving changes (no summer/winter duplicate rows).

export interface Occurrence {
  /** The local calendar date, YYYY-MM-DD; identifies the run. */
  runKey: string;
  /** The instant it is due, epoch ms. */
  at: number;
}

const DAY_MS = 86_400_000;

/** Milliseconds the zone is ahead of UTC at `instant`. */
function offset(timezone: string, instant: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(instant)).map(part => [part.type, part.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * The UTC instant of a local wall-clock time. A time skipped by a spring-forward change resolves
 * to the hour after it.
 */
export function zonedInstant(timezone: string, year: number, month: number, day: number, hour: number, minute: number): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const first = wall - offset(timezone, wall);
  return wall - offset(timezone, first);
}

/** Today's local date in `timezone`, as a UTC-midnight calendar value for day arithmetic. */
function localDay(timezone: string, instant: number): number {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(instant)).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Every occurrence from a week before to 32 days after `now` (so a monthly day is always found), in order. */
function occurrences(schedule: Schedule, now: number): Occurrence[] {
  const [hour, minute] = schedule.time.split(":").map(Number);
  const today = localDay(schedule.timezone, now);
  const found: Occurrence[] = [];
  for (let i = -7; i <= 32; i++) {
    const day = new Date(today + i * DAY_MS);
    if (schedule.monthDays ? !schedule.monthDays.includes(day.getUTCDate()) : !schedule.days?.includes(day.getUTCDay())) continue;
    found.push({
      runKey: day.toISOString().slice(0, 10),
      at: zonedInstant(schedule.timezone, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, minute),
    });
  }
  return found;
}

/** The most recent occurrence at or before `now`. */
export function latestDue(schedule: Schedule, now: number): Occurrence | undefined {
  return occurrences(schedule, now).filter(o => o.at <= now).at(-1);
}

/** The first occurrence after `now`. */
export function nextDue(schedule: Schedule, now: number): Occurrence | undefined {
  return occurrences(schedule, now).find(o => o.at > now);
}

/** Throws on a schedule that could never run correctly. */
export function validateSchedule(schedule: Schedule): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(schedule.id)) throw new Error(`Schedule id "${schedule.id}" must be letters, digits, _ or -.`);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) throw new Error(`Schedule ${schedule.id}: time must be HH:MM.`);
  const { days, monthDays } = schedule;
  if (!days === !monthDays) throw new Error(`Schedule ${schedule.id}: set either days or monthDays.`);
  if (days && (!days.length || days.some(day => !Number.isInteger(day) || day < 0 || day > 6))) throw new Error(`Schedule ${schedule.id}: days must be 0-6.`);
  if (monthDays && (!monthDays.length || monthDays.some(day => !Number.isInteger(day) || day < 1 || day > 28))) throw new Error(`Schedule ${schedule.id}: monthDays must be 1-28.`);
  try { new Intl.DateTimeFormat("en-US", { timeZone: schedule.timezone }); } catch { throw new Error(`Schedule ${schedule.id}: unknown time zone.`); }
  if (!schedule.task.trim()) throw new Error(`Schedule ${schedule.id}: task is empty.`);
}
