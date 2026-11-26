import type { JobProgress } from "./contracts";
import type { Store } from "./store";

// Background jobs: one per conversation, saved in the conversation's own storage (meta keys `job` and `jobQueue`),
// so a restart resumes from the last saved state. The Conversation object runs them (src/conversation.ts).

/** Per job: active time (segments plus the waits the agent asked for; time spent waiting for a person's approval does not count). */
export const JOB_MAX_MS = 30 * 60_000;
/** Messages that may wait behind a running job. */
export const MAX_QUEUED = 10;
/** A running segment re-arms the alarm this far ahead: if the object is evicted mid-segment, the alarm resumes it. */
export const SEGMENT_WATCHDOG_MS = 6 * 60_000;
export const CHECK_BACK_MIN_SECONDS = 10;
export const CHECK_BACK_MAX_SECONDS = 300;
/** The voice-only tool that hands a task to a background job. */
export const BACKGROUND_TOOL = "start_in_background";
/** The voice-only tool that records the change to read back to the caller; the tools that change something run only what it recorded. */
export const PROPOSE_TOOL = "propose_change";
/** Thrown by Conversation.turn while a job is active; the routes turn it into a clear answer. */
export const JOB_ACTIVE_MESSAGE = "A background job is running in this conversation. Send messages to /jobs so they queue behind it.";

export type JobStatus = "running" | "waiting" | "needs_approval" | "done" | "failed" | "stopped";
export interface JobInput { id: string; text: string }

/** The saved job. `plan`/`done` are what the agent reported; `input` is what the next segment runs. */
export interface Job {
  id: string;
  status: JobStatus;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  plan: string[];
  done: number;
  /** Set by the agent (update_progress). */
  current?: string;
  /** The label of the tool running now. */
  tool?: string;
  error?: string;
  input: JobInput;
  /** The message that started the job (`input` becomes a check-back note on later segments). */
  task?: string;
  segment: number;
  /** When the next segment is due (waiting), or when the watchdog fires (running). */
  dueAt: number;
  usedMs: number;
  /** The conversation's spend when the job started: the job's own spend is the difference. */
  spendBase: number;
  /** Why the agent asked to check back. */
  reason?: string;
}

/** What the app sees (GET .../job). */
export interface JobView {
  id: string;
  status: JobStatus;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  steps: { label: string; state: "pending" | "active" | "done" | "failed" }[];
  current: string | null;
  queued: number;
  error?: string;
}

export const isActive = (job: Job | undefined): boolean => job !== undefined && (job.status === "running" || job.status === "waiting" || job.status === "needs_approval");

export function loadJob(store: Store): Job | undefined {
  const raw = store.meta("job");
  return raw ? JSON.parse(raw) as Job : undefined;
}

export function saveJob(store: Store, job: Job): void {
  job.updatedAt = Date.now();
  store.setMeta("job", JSON.stringify(job));
}

export function loadQueue(store: Store): JobInput[] {
  const raw = store.meta("jobQueue");
  return raw ? JSON.parse(raw) as JobInput[] : [];
}

export function saveQueue(store: Store, queue: JobInput[]): void {
  store.setMeta("jobQueue", JSON.stringify(queue));
}

/** A job is busy until it ends and every queued message has run. */
export const jobBusy = (store: Store): boolean => isActive(loadJob(store)) || loadQueue(store).length > 0;

export function newJob(input: JobInput, spendBase: number, now = Date.now()): Job {
  return { id: input.id, status: "running", startedAt: now, updatedAt: now, plan: [], done: 0, input, task: input.text, segment: 0, dueAt: now, usedMs: 0, spendBase };
}

/** When the alarm should next run this job's work: its segment or wake-up time, or now when queued messages are waiting. */
export function jobDueAt(store: Store): number | undefined {
  const job = loadJob(store);
  if (job && (job.status === "running" || job.status === "waiting")) return job.dueAt;
  if (!isActive(job) && loadQueue(store).length) return 0;
  return undefined;
}

export function applyProgress(job: Job, progress: JobProgress): void {
  if (progress.steps) job.plan = progress.steps.map(step => step.trim().slice(0, 120)).filter(Boolean).slice(0, 12);
  if (progress.done !== undefined) job.done = Math.min(Math.max(Math.trunc(progress.done), 0), job.plan.length);
  if (progress.current !== undefined) job.current = progress.current.trim().slice(0, 120) || undefined;
  // A step finished and the agent named no new one: the old description no longer applies.
  else if (progress.done !== undefined) job.current = undefined;
}

export function jobView(job: Job, queued: number): JobView {
  const ended = job.status === "failed" || job.status === "stopped";
  return {
    id: job.id, status: job.status, startedAt: job.startedAt, updatedAt: job.updatedAt,
    ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
    steps: job.plan.map((label, i) => ({
      label,
      state: job.status === "done" || i < job.done ? "done" : i > job.done ? "pending" : ended ? "failed" : "active",
    })),
    current: isActive(job) ? job.current ?? job.tool ?? null : null,
    queued,
    ...(job.error ? { error: job.error } : {}),
  };
}

/** `github_push_files` → "Github push files", for tools without a plain-words label. */
export function humanize(name: string): string {
  const words = name.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const checkBackNote = (reason?: string): string =>
  `[Runtime note, not from the user] Time to check back${reason ? `: ${reason}` : ""}. Continue the job from where you left off; if what you are waiting for is not ready, call check_back_in again.`;
