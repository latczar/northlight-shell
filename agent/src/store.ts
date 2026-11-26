import type { ActionRecord, ActionStatus, ChatMessage, JsonObject, ToolResult } from "./contracts";

/** Runtime notes and compaction summaries live in the model's history but were never said by anyone. */
const INTERNAL = /^(\[Runtime note, not from the user\]|Summary of the earlier conversation)/;
/** Lines kept per conversation; the oldest drop off beyond this. */
const MAX_TRANSCRIPT = 5_000;

// One conversation's durable state, in its Durable Object's own SQLite.
// There is no cross-conversation table here.

interface ActionRow extends Record<string, SqlStorageValue> {
  id: string; tool: string; args: string; status: string; result: string | null;
  error: string | null; attempts: number; created_at: number; updated_at: number;
  checked_by: string | null; checked_at: number | null;
  check_outcome: string | null;
}

export class Store {
  private readonly sql: SqlStorage;

  constructor(private readonly storage: DurableObjectStorage) {
    this.sql = storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inputs (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, reply TEXT);
      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY, tool TEXT NOT NULL, args TEXT NOT NULL, status TEXT NOT NULL,
        result TEXT, error TEXT, attempts INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reservations (
        id TEXT PRIMARY KEY, phase TEXT NOT NULL, input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL, cost_usd REAL NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS transcript (seq INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, text TEXT NOT NULL);
    `);
    const columns = this.sql.exec<{ name: string }>("PRAGMA table_info(actions)").toArray();
    if (!columns.some(column => column.name === "checked_by")) this.sql.exec("ALTER TABLE actions ADD COLUMN checked_by TEXT");
    if (!columns.some(column => column.name === "checked_at")) this.sql.exec("ALTER TABLE actions ADD COLUMN checked_at INTEGER");
    if (!columns.some(column => column.name === "check_outcome")) this.sql.exec("ALTER TABLE actions ADD COLUMN check_outcome TEXT");
    // Conversations from before the transcript existed: copy what was said once, from the messages still stored.
    if (this.meta("transcript") === undefined) {
      this.transaction(() => {
        for (const { message } of this.messages()) this.record(message);
        this.setMeta("transcript", "1");
      });
    }
  }

  /** Keeps what the person and the agent said in the transcript, which compaction never touches. */
  private record(message: ChatMessage): void {
    if ((message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string") return;
    const text = message.content.trim();
    if (!text || INTERNAL.test(text)) return;
    this.sql.exec("INSERT INTO transcript (role, text) VALUES (?, ?)", message.role, text);
    this.sql.exec("DELETE FROM transcript WHERE seq <= (SELECT MAX(seq) FROM transcript) - ?", MAX_TRANSCRIPT);
  }

  /** An agent line no turn produced (a follow-up that failed): shown in the chat, never sent to the model. */
  note(text: string): void {
    this.record({ role: "assistant", content: text });
  }

  /** The latest `limit` lines before `before` (all when absent), oldest first; `more` says older lines exist. */
  transcript(limit: number, before?: number): { lines: { seq: number; role: "user" | "assistant"; text: string }[]; more: boolean } {
    const rows = this.sql.exec<{ seq: number; role: "user" | "assistant"; text: string }>(
      "SELECT seq, role, text FROM transcript WHERE seq < ? ORDER BY seq DESC LIMIT ?", before ?? Number.MAX_SAFE_INTEGER, limit + 1).toArray();
    return { lines: rows.slice(0, limit).reverse(), more: rows.length > limit };
  }

  /**
   * The oldest lines after `after`, oldest first, up to `limit` lines and about `maxChars` characters (always at least
   * one line); `more` says later lines remain. Used to review a conversation in order without skipping anything.
   */
  transcriptAfter(after: number, limit: number, maxChars: number): { lines: { seq: number; role: "user" | "assistant"; text: string }[]; more: boolean } {
    const rows = this.sql.exec<{ seq: number; role: "user" | "assistant"; text: string }>(
      "SELECT seq, role, text FROM transcript WHERE seq > ? ORDER BY seq ASC LIMIT ?", after, limit + 1).toArray();
    const lines: typeof rows = [];
    let chars = 0;
    for (const row of rows.slice(0, limit)) {
      if (lines.length && chars + row.text.length > maxChars) break;
      lines.push(row);
      chars += row.text.length;
    }
    return { lines, more: rows.length > lines.length };
  }

  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }

  meta(key: string): string | undefined {
    return this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value;
  }

  setMeta(key: string, value: string): void {
    this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  /**
   * A conversation belongs to exactly one client, agent and person (or no person), fixed by its first
   * message, so one person's history and memory can never be reached under another person's id.
   */
  bind(clientId: string, agentId: string, userId?: string): void {
    const owner = `${clientId}/${agentId}`;
    const user = userId ?? "";
    const existing = this.meta("owner");
    if (existing === undefined) {
      this.transaction(() => { this.setMeta("owner", owner); this.setMeta("user", user); });
      return;
    }
    if (existing !== owner) throw new Error("Conversation belongs to another client or agent.");
    if ((this.meta("user") ?? "") !== user) throw new Error("Conversation belongs to another person.");
  }

  messages(): { seq: number; message: ChatMessage }[] {
    return this.sql.exec<{ seq: number; body: string }>("SELECT seq, body FROM messages ORDER BY seq").toArray()
      .map(row => ({ seq: row.seq, message: JSON.parse(row.body) as ChatMessage }));
  }

  append(message: ChatMessage): number {
    const seq = this.sql.exec<{ seq: number }>("INSERT INTO messages (body) VALUES (?) RETURNING seq", JSON.stringify(message)).one().seq;
    this.record(message);
    return seq;
  }

  /**
   * Forgets the latest reply when the caller never heard it (`said` is what was to be spoken): their words then stand
   * unanswered for the next turn. Lookups and their results stay, so nothing is looked up twice.
   */
  forgetReply(said: string): void {
    this.transaction(() => {
      const last = this.sql.exec<{ seq: number; body: string }>("SELECT seq, body FROM messages ORDER BY seq DESC LIMIT 1").toArray()[0];
      if (!last) return;
      const message = JSON.parse(last.body) as ChatMessage;
      if (message.role !== "assistant" || message.tool_calls?.length || typeof message.content !== "string") return;
      const text = message.content.trim();
      if (!text || !said.trim().endsWith(text)) return;
      this.sql.exec("DELETE FROM messages WHERE seq = ?", last.seq);
      this.sql.exec("DELETE FROM transcript WHERE seq = (SELECT MAX(seq) FROM transcript) AND role = 'assistant' AND text = ?", text);
    });
  }

  /** Replaces every message before `keepFromSeq` with one summary message. */
  replacePrefix(keepFromSeq: number, summary: ChatMessage): void {
    this.transaction(() => {
      this.sql.exec("DELETE FROM messages WHERE seq < ?", keepFromSeq);
      this.sql.exec("INSERT INTO messages (seq, body) VALUES (?, ?)", keepFromSeq - 1, JSON.stringify(summary));
    });
  }

  /** `reply` is null while the input's turn has not finished (still running, or interrupted). */
  input(id: string): { seq: number; reply: string | null } | undefined {
    return this.sql.exec<{ seq: number; reply: string | null }>("SELECT seq, reply FROM inputs WHERE id = ?", id).toArray()[0];
  }

  latestInputSeq(): number | undefined {
    return this.sql.exec<{ seq: number }>("SELECT seq FROM inputs ORDER BY seq DESC LIMIT 1").toArray()[0]?.seq;
  }

  addInput(id: string, now: number): void {
    this.sql.exec("INSERT INTO inputs (id, created_at) VALUES (?, ?)", id, now);
  }

  completeInput(id: string, reply: string): void {
    this.sql.exec("UPDATE inputs SET reply = ? WHERE id = ?", reply, id);
  }

  action(id: string): ActionRecord | undefined {
    const row = this.sql.exec<ActionRow>("SELECT * FROM actions WHERE id = ?", id).toArray()[0];
    return row && toAction(row);
  }

  actions(status?: ActionStatus): ActionRecord[] {
    const rows = status
      ? this.sql.exec<ActionRow>("SELECT * FROM actions WHERE status = ? ORDER BY created_at", status).toArray()
      : this.sql.exec<ActionRow>("SELECT * FROM actions ORDER BY created_at").toArray();
    return rows.map(toAction);
  }

  putAction(action: ActionRecord): void {
    this.sql.exec(
      `INSERT INTO actions (id, tool, args, status, result, error, attempts, created_at, updated_at, checked_by, checked_at, check_outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET args = excluded.args, status = excluded.status, result = excluded.result,
         error = excluded.error, attempts = excluded.attempts, updated_at = excluded.updated_at,
         checked_by = excluded.checked_by, checked_at = excluded.checked_at, check_outcome = excluded.check_outcome`,
      action.id, action.tool, JSON.stringify(action.args), action.status,
      action.result ? JSON.stringify(action.result) : null, action.error ?? null,
      action.attempts, action.createdAt, action.updatedAt, action.checkedBy ?? null, action.checkedAt ?? null,
      action.checkOutcome ?? null,
    );
  }

  // Cost reservations:
  // in_flight before the call, settled with real usage, unresolved when the outcome is unknown
  // (a request interrupted mid-flight may still have been billed, so it keeps counting).

  reserve(id: string, inputTokens: number, outputTokens: number, costUsd: number, now: number): void {
    this.sql.exec("INSERT INTO reservations VALUES (?, 'in_flight', ?, ?, ?, ?)", id, inputTokens, outputTokens, costUsd, now);
  }

  settle(id: string, inputTokens: number, outputTokens: number, costUsd: number): void {
    this.sql.exec("UPDATE reservations SET phase = 'settled', input_tokens = ?, output_tokens = ?, cost_usd = ? WHERE id = ?",
      inputTokens, outputTokens, costUsd, id);
  }

  markUnresolved(id: string): void {
    this.sql.exec("UPDATE reservations SET phase = 'unresolved' WHERE id = ? AND phase = 'in_flight'", id);
  }

  /** After a restart nothing is in flight any more; keep those reservations counted. */
  recoverReservations(): void {
    this.sql.exec("UPDATE reservations SET phase = 'unresolved' WHERE phase = 'in_flight'");
  }

  spentUsd(): number {
    return this.sql.exec<{ total: number | null }>("SELECT SUM(cost_usd) AS total FROM reservations").one().total ?? 0;
  }
}

function toAction(row: ActionRow): ActionRecord {
  return {
    id: row.id,
    tool: row.tool,
    args: JSON.parse(row.args) as JsonObject,
    status: row.status as ActionStatus,
    result: row.result ? (JSON.parse(row.result) as ToolResult) : undefined,
    error: row.error ?? undefined,
    ...(row.checked_by !== null ? { checkedBy: row.checked_by, checkedAt: row.checked_at! } : {}),
    ...(row.check_outcome !== null ? { checkOutcome: row.check_outcome as ActionRecord["checkOutcome"] } : {}),
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
