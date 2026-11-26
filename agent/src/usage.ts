import { DurableObject } from "cloudflare:workers";

// One spend ledger per client, shared by all its conversations and jobs, for the daily cost cap.
// Same pattern as a conversation's own reservations: reserve the worst case before the model call,
// settle with the real cost after; a call whose outcome is unknown keeps its reservation.

/** UTC calendar day, YYYY-MM-DD. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export class Usage extends DurableObject {
  private readonly sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.sql.exec("CREATE TABLE IF NOT EXISTS spend (id TEXT PRIMARY KEY, day TEXT NOT NULL, amount REAL NOT NULL)");
  }

  /** Reserves `amount` for today unless that would pass `cap`. Returns whether it is reserved; a repeated id is already reserved. */
  async reserve(id: string, day: string, amount: number, cap: number): Promise<boolean> {
    if (this.sql.exec("SELECT 1 FROM spend WHERE id = ?", id).toArray().length) return true;
    // Keep a month of history.
    this.sql.exec("DELETE FROM spend WHERE day < ?", utcDay(Date.parse(`${day}T00:00:00Z`) - 31 * 86_400_000));
    if (this.spentOn(day) + amount > cap) return false;
    this.sql.exec("INSERT OR REPLACE INTO spend VALUES (?, ?, ?)", id, day, amount);
    return true;
  }

  async settle(id: string, amount: number): Promise<void> {
    this.sql.exec("UPDATE spend SET amount = ? WHERE id = ?", amount, id);
  }

  async spent(day: string): Promise<number> {
    return this.spentOn(day);
  }

  private spentOn(day: string): number {
    return this.sql.exec<{ total: number | null }>("SELECT SUM(amount) AS total FROM spend WHERE day = ?", day).one().total ?? 0;
  }
}
