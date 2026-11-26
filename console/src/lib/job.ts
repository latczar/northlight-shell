import type { Job } from "./brain-types";

// An employee works on a chat message as a background job in the agent. These are the browser-side rules for following
// one: when to keep checking and what changed between two looks. No React here, so it is testable.

export const JOB_POLL_MS = 2_500;
/** A tab hidden longer than this stops checking until it is shown again. */
export const HIDDEN_PAUSE_MS = 2 * 60_000;
/** Failed checks in a row before the chat says it is having trouble. */
export const TROUBLE_AFTER_FAILURES = 2;

export const isActive = (job: Job | null | undefined): boolean =>
  job?.status === "running" || job?.status === "waiting" || job?.status === "needs_approval";

/** "45s", "2m 16s", "1h 05m": time since the job started. Never negative (this device's clock may run behind the brain's). */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

export type JobEvent = "approval" | "ended";

/** What changed between two looks at the job. `prev` is undefined on the first look after a page load: nothing is announced then. */
export function transition(prev: Job | undefined, next: Job): JobEvent | null {
  if (!prev) return null;
  const same = prev.id === next.id;
  if (next.status === "needs_approval" && !(same && prev.status === "needs_approval")) return "approval";
  if (!isActive(next) && !(same && !isActive(prev))) return "ended";
  return null;
}

export interface JobWatcher {
  /** Follows a job this tab just started, or checks at once for one already running. */
  start: (from?: Job) => void;
  stop: () => void;
  /** Call when the tab's visibility or focus changes. */
  visibilityChanged: () => void;
}

export interface JobWatch {
  fetchJob: () => Promise<Job | null>;
  /** Pulls in lines saved since the last look. */
  fetchMessages: () => Promise<void>;
  onJob: (job: Job | null) => void;
  /** After the job's messages are fetched: it asked for a decision, or it ended. */
  onEvent: (event: JobEvent, job: Job) => void;
  onTrouble: (trouble: boolean) => void;
  isHidden: () => boolean;
  intervalMs?: number;
  hiddenPauseMs?: number;
}

/**
 * Checks the job and the conversation every `intervalMs` while the job is active or has messages queued behind it, then
 * stops by itself. `start(job)` follows a job this tab just started; `start()` checks at once (page load). After the tab
 * has been hidden for `hiddenPauseMs` checking pauses; `visibilityChanged()` resumes it.
 */
export function watchJob(w: JobWatch): JobWatcher {
  const interval = w.intervalMs ?? JOB_POLL_MS;
  const pauseAfter = w.hiddenPauseMs ?? HIDDEN_PAUSE_MS;
  let run = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let prev: Job | undefined;
  let failures = 0;
  let paused = false;
  let hiddenSince: number | null = null;

  async function tick(mine: number) {
    let again = true;
    try {
      const job = await w.fetchJob();
      if (mine !== run) return;
      await w.fetchMessages();
      if (mine !== run) return;
      if (failures >= TROUBLE_AFTER_FAILURES) w.onTrouble(false);
      failures = 0;
      w.onJob(job);
      const event = job ? transition(prev, job) : null;
      prev = job ?? undefined;
      again = job != null && (isActive(job) || job.queued > 0);
      if (event && job) w.onEvent(event, job);
    } catch {
      // shortcut: a failed check is tried again at the next interval; after two in a row the person is told.
      if (mine !== run) return;
      if (++failures === TROUBLE_AFTER_FAILURES) w.onTrouble(true);
    }
    if (mine !== run) return;
    if (again) schedule(mine);
    else stop();
  }

  function schedule(mine: number) {
    timer = setTimeout(() => {
      if (hiddenSince !== null && Date.now() - hiddenSince > pauseAfter) paused = true;
      else void tick(mine);
    }, interval);
  }

  function stop() {
    run++;
    clearTimeout(timer);
    paused = false;
  }

  return {
    start(from?: Job) {
      stop();
      const mine = run;
      prev = from;
      // a fresh start forgets earlier failures, so a warning they raised must go too
      if (failures >= TROUBLE_AFTER_FAILURES) w.onTrouble(false);
      failures = 0;
      hiddenSince = w.isHidden() ? Date.now() : null;
      if (from) schedule(mine);
      else void tick(mine);
    },
    stop,
    visibilityChanged() {
      if (w.isHidden()) {
        hiddenSince ??= Date.now();
        return;
      }
      hiddenSince = null;
      if (paused) {
        paused = false;
        void tick(run);
      }
    },
  };
}
