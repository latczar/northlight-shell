import { DurableObject } from "cloudflare:workers";

// One memory store per client + person, shared by that client's agents.
// Addressed by `memoryName(clientId, userId)`, so no store holds two clients' or two people's facts.

export interface Fact { id: string; text: string; createdAt: number }

const MAX_FACTS = 500;

export function memoryName(clientId: string, userId: string): string {
  return `${clientId}/user/${userId}`;
}

export class Memory extends DurableObject {
  private readonly sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.sql.exec("CREATE TABLE IF NOT EXISTS facts (id TEXT PRIMARY KEY, text TEXT NOT NULL, created_at INTEGER NOT NULL)");
  }

  /** Idempotent by id: a retried `remember` with the same action id stores the fact once. */
  async add(id: string, text: string): Promise<Fact> {
    const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM facts").one().n;
    const existing = await this.get(id);
    if (existing) return existing;
    if (count >= MAX_FACTS) throw new Error("Memory is full.");
    const now = Date.now();
    this.sql.exec("INSERT INTO facts (id, text, created_at) VALUES (?, ?, ?)", id, text, now);
    return { id, text, createdAt: now };
  }

  async get(id: string): Promise<Fact | undefined> {
    return this.sql.exec<{ id: string; text: string; created_at: number }>("SELECT * FROM facts WHERE id = ?", id).toArray()
      .map(row => ({ id: row.id, text: row.text, createdAt: row.created_at }))[0];
  }

  async recent(limit: number): Promise<Fact[]> {
    return this.sql.exec<{ id: string; text: string; created_at: number }>("SELECT * FROM facts ORDER BY created_at DESC LIMIT ?", limit).toArray()
      .map(row => ({ id: row.id, text: row.text, createdAt: row.created_at }));
  }

  /** Facts containing any of the query's words (3+ letters), most matches first. */
  async search(query: string, limit: number): Promise<Fact[]> {
    const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, 10);
    if (!words.length) return this.recent(limit);
    const facts = await this.recent(MAX_FACTS);
    return facts
      .map(fact => ({ fact, score: words.filter(word => fact.text.toLowerCase().includes(word)).length }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || b.fact.createdAt - a.fact.createdAt)
      .slice(0, limit)
      .map(item => item.fact);
  }

  async remove(id: string): Promise<boolean> {
    return this.sql.exec("DELETE FROM facts WHERE id = ?", id).rowsWritten > 0;
  }
}
