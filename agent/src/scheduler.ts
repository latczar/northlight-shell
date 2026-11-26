import { DurableObject } from "cloudflare:workers";
import { CLIENTS } from "../clients";
import type { ClientConfig, Schedule } from "./contracts";
import type { Env } from "./conversation";
import { latestDue, nextDue, validateSchedule } from "./schedule";

// One scheduler per client. It keeps a single Durable Object alarm set for the next due job;
// nothing wakes up between jobs. Each run is a normal agent turn whose message id is
// "<schedule>@<local date>", so a repeated alarm can never run the same day's job twice.

/** A run is still started if it was missed by up to this long (e.g. the platform was down). */
const CATCH_UP_MS = 12 * 3_600_000;
const RETRY_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;

export function jobText(schedule: Schedule, runKey: string, attempt: number): string {
  const retry = attempt > 1 ? ` This is attempt ${attempt}: the earlier attempt did not post its dashboard card. Finish by posting it now.` : "";
  return `Scheduled job "${schedule.id}" for ${runKey} (${schedule.timezone}). No person is present: do not ask questions; finish the task with your tools.${retry}\n\n${schedule.task}`;
}

export class Scheduler extends DurableObject<Env> {
  private readonly sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS runs (
      schedule_id TEXT NOT NULL, run_key TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY (schedule_id, run_key))`);
  }

  private client(clientId: string): ClientConfig {
    const client = CLIENTS.find(c => c.id === clientId);
    if (!client) throw new Error("Unknown client.");
    for (const schedule of client.schedules ?? []) validateSchedule(schedule);
    return client;
  }

  private run(scheduleId: string, runKey: string): { status: string; attempts: number } | undefined {
    return this.sql.exec<{ status: string; attempts: number }>("SELECT status, attempts FROM runs WHERE schedule_id = ? AND run_key = ?", scheduleId, runKey).toArray()[0];
  }

  /** Sets the alarm for the next job (or an overdue one). Safe to call any time; the hourly cron does. */
  async ensure(clientId: string): Promise<number | null> {
    await this.ctx.storage.put("clientId", clientId);
    const client = this.client(clientId);
    const now = Date.now();
    const times: number[] = [];
    for (const schedule of client.schedules ?? []) {
      const due = latestDue(schedule, now);
      const status = due && this.run(schedule.id, due.runKey)?.status;
      if (due && now - due.at <= CATCH_UP_MS && !["done", "failed", "notify"].includes(String(status))) times.push(now);
      const upcoming = nextDue(schedule, now);
      if (upcoming) times.push(upcoming.at);
    }
    // A failure card that is still owed keeps the alarm coming until it is posted.
    if (this.owed().length) times.push(now);
    const next = times.length ? Math.min(...times) : null;

    const current = await this.ctx.storage.getAlarm();
    if (next === null) { if (current !== null) await this.ctx.storage.deleteAlarm(); }
    else if (current === null || current > next) await this.ctx.storage.setAlarm(next);
    return next;
  }

  /** Runs one job now, outside its timetable (for testing). Uses its own run key so it never replaces a real run. */
  async runNow(clientId: string, scheduleId: string): Promise<boolean> {
    const schedule = this.client(clientId).schedules?.find(s => s.id === scheduleId);
    if (!schedule) throw new Error("Unknown schedule.");
    return this.start(clientId, schedule, `manual-${new Date().toISOString().replace(/[:.]/g, "-")}`, 1);
  }

  async alarm(): Promise<void> {
    await this.runDue(Date.now());
  }

  /**
   * Runs every job due at `now` that has not run yet for its day, and posts any failure card still owed.
   * Public as a test seam for the clock.
   * Run statuses: retry → (done | notify → failed). "notify" is saved before the failure card is posted,
   * so a crash or a failed post leaves the card owed and later alarms post it; posting is idempotent.
   */
  async runDue(now: number): Promise<void> {
    const clientId = await this.ctx.storage.get<string>("clientId");
    if (!clientId) return;
    const schedules = this.client(clientId).schedules ?? [];
    let retry = false;
    for (const owed of this.owed()) {
      const schedule = schedules.find(s => s.id === owed.scheduleId);
      if (schedule) retry ||= !await this.notifyFailure(clientId, schedule, owed.runKey);
    }
    for (const schedule of schedules) {
      const due = latestDue(schedule, now);
      if (!due || now - due.at > CATCH_UP_MS) continue;
      const run = this.run(schedule.id, due.runKey);
      if (run && run.status !== "retry") continue;
      const attempts = (run?.attempts ?? 0) + 1;
      let ok = false;
      try { ok = await this.start(clientId, schedule, due.runKey, attempts); } catch { ok = false; }
      const status = ok ? "done" : attempts >= MAX_ATTEMPTS ? "notify" : "retry";
      this.setRun(schedule.id, due.runKey, status, attempts);
      if (status === "notify") retry ||= !await this.notifyFailure(clientId, schedule, due.runKey);
      retry ||= status === "retry";
    }
    if (retry) await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
    else await this.ensure(clientId);
  }

  private setRun(scheduleId: string, runKey: string, status: string, attempts: number): void {
    this.sql.exec(`INSERT INTO runs VALUES (?, ?, ?, ?, ?) ON CONFLICT(schedule_id, run_key)
      DO UPDATE SET status = excluded.status, attempts = excluded.attempts, updated_at = excluded.updated_at`,
      scheduleId, runKey, status, attempts, Date.now());
  }

  private owed(): { scheduleId: string; runKey: string; attempts: number }[] {
    return this.sql.exec<{ schedule_id: string; run_key: string; attempts: number }>("SELECT schedule_id, run_key, attempts FROM runs WHERE status = 'notify'")
      .toArray().map(row => ({ scheduleId: row.schedule_id, runKey: row.run_key, attempts: row.attempts }));
  }

  /** Posts the failure card; marks the run failed only after the card exists. Returns whether it was posted. */
  private async notifyFailure(clientId: string, schedule: Schedule, runKey: string): Promise<boolean> {
    try {
      await this.reportFailure(clientId, schedule, runKey);
    } catch {
      return false;
    }
    this.setRun(schedule.id, runKey, "failed", MAX_ATTEMPTS);
    return true;
  }

  private conversationId(schedule: Schedule, runKey: string): string {
    return `job-${schedule.id}-${runKey}`;
  }

  private dashboard(clientId: string) {
    return this.env.DASHBOARD.get(this.env.DASHBOARD.idFromName(clientId));
  }

  /**
   * A run succeeds when this run's report (a report or status card) is on the dashboard, however the agent's last reply
   * ended: an empty or stopped reply after the report was posted would otherwise wait 5 minutes for a retry that only finds
   * it. An alert card alone (a reply an output rule held back) is not a report, so that run is retried. Each attempt is a
   * new message (attempt number in its id), so a retry really runs instead of returning the earlier reply; all attempts
   * share one conversation, so one report covers the day.
   */
  private async start(clientId: string, schedule: Schedule, runKey: string, attempt: number): Promise<boolean> {
    const conversationId = this.conversationId(schedule, runKey);
    if (await this.dashboard(clientId).hasReportFromConversation(conversationId)) return true;
    const stub = this.env.CONVERSATIONS.get(this.env.CONVERSATIONS.idFromName(`${clientId}/${schedule.agent}/${conversationId}`));
    const stream = await stub.turn({
      clientId, agentId: schedule.agent, conversationId, source: "scheduled",
      input: { id: `${schedule.id}@${runKey}#${attempt}`, text: jobText(schedule, runKey, attempt) },
      // One trusted request for every attempt of the run, holding the reviewed task alone: a retry is not a person's answer, and the preamble above is not their words.
      request: { id: `${schedule.id}@${runKey}`, text: schedule.task, scheduleId: schedule.id },
    });
    // Wait for the turn to finish before checking.
    await new Response(stream).text();
    return this.dashboard(clientId).hasReportFromConversation(conversationId);
  }

  /** After the last failed attempt, the runtime itself posts a card so a missed report is never silent. */
  private async reportFailure(clientId: string, schedule: Schedule, runKey: string): Promise<void> {
    console.error("scheduled job failed", schedule.id, runKey);
    await this.dashboard(clientId).post({
      id: `${schedule.id}@${runKey}-failed`, agent: schedule.agent, kind: "alert",
      title: `${schedule.id}: did not complete`,
      summary: `The scheduled job for ${runKey} did not finish after ${MAX_ATTEMPTS} attempts. A person should check it.`,
      dataJson: "{}", conversationId: `${this.conversationId(schedule, runKey)}-failure`, clientId,
    });
  }

  /** Recent runs, for staff and tests. */
  async runs(): Promise<{ scheduleId: string; runKey: string; status: string; attempts: number }[]> {
    return this.sql.exec<{ schedule_id: string; run_key: string; status: string; attempts: number }>(
      "SELECT schedule_id, run_key, status, attempts FROM runs ORDER BY updated_at DESC LIMIT 50").toArray()
      .map(row => ({ scheduleId: row.schedule_id, runKey: row.run_key, status: row.status, attempts: row.attempts }));
  }
}
