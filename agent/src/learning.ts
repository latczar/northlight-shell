import { DurableObject } from "cloudflare:workers";
import { CLIENTS } from "../clients";
import { may } from "./lesson-access";
import type { Bindings } from "./contracts";

// One lessons store per client (`idFromName(clientId)`), shared by that client's agents. Narrowed
// to what a small team needs: a reviewer proposes, a person on the client's approvers list approves
// or removes, and only active lessons reach the agents. Removing a lesson also blocks the same text from coming back.

export type LessonKind = "fact" | "preference" | "procedure" | "warning";
export type LessonStatus = "proposed" | "active" | "removed";
export const LESSON_KINDS: readonly LessonKind[] = ["fact", "preference", "procedure", "warning"];

export interface Lesson {
  id: string;
  /** null: every agent of this client. */
  agent: string | null;
  kind: LessonKind;
  text: string;
  /** The person's own words the lesson came from. */
  evidence: string;
  conversationId: string;
  status: LessonStatus;
  replaces?: string;
  createdAt: number;
  decidedAt?: number;
  decidedBy?: string;
  source?: { clientId: string; agentId: string; userId: string; conversationId: string; actionId: string };
}

export interface LessonProposal {
  agent: string | null;
  kind: LessonKind;
  text: string;
  evidence: string;
  conversationId: string;
  replaces?: string;
  source?: Lesson["source"];
}

export type ProposeResult = { ok: true; lesson: Lesson } | { ok: false; reason: string };
export type DecideResult = { ok: true; lesson: Lesson } | { ok: false; status: 404 | 409; error: string };

/** Proposed + active lessons per client; more proposals are refused until people decide some. */
const MAX_OPEN = 200;
/** Reviews per client per UTC day. */
export const MAX_REVIEWS_PER_DAY = 40;
/** What an agent is given each run (the default lesson budget). */
export const LESSONS_IN_PROMPT = 6;
export const LESSON_CHARS_IN_PROMPT = 4_000;

interface Row extends Record<string, SqlStorageValue> {
  id: string; agent: string | null; kind: string; text: string; evidence: string; conversation_id: string; status: string;
  replaces: string | null; created_at: number; decided_at: number | null; decided_by: string | null;
  source: string | null;
}

const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

async function hash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalize(text)));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function toLesson(row: Row): Lesson {
  return {
    id: row.id, agent: row.agent, kind: row.kind as LessonKind, text: row.text, evidence: row.evidence,
    conversationId: row.conversation_id, status: row.status as LessonStatus, createdAt: row.created_at,
    ...(row.replaces ? { replaces: row.replaces } : {}),
    ...(row.decided_at !== null ? { decidedAt: row.decided_at } : {}),
    ...(row.decided_by !== null ? { decidedBy: row.decided_by } : {}),
    ...(row.source ? { source: JSON.parse(row.source) as Lesson["source"] } : {}),
  };
}

/**
 * The lessons a run is given, out of the agent's active ones: the most relevant to `query` (shared words), then newest,
 * within the prompt budget. Shown to the model as guidance, never as permissions.
 */
export function pickLessons(active: Lesson[], query: string): Lesson[] {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
  const score = (lesson: Lesson) => words.filter(w => lesson.text.toLowerCase().includes(w)).length;
  const ranked = active.map(lesson => ({ lesson, score: score(lesson) })).sort((a, b) => b.score - a.score || b.lesson.createdAt - a.lesson.createdAt);
  const chosen: Lesson[] = [];
  let chars = 0;
  for (const { lesson } of ranked) {
    if (chosen.length >= LESSONS_IN_PROMPT || chars + lesson.text.length > LESSON_CHARS_IN_PROMPT) break;
    chosen.push(lesson);
    chars += lesson.text.length;
  }
  return chosen;
}

export class Learning extends DurableObject {
  private readonly sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS lessons (id TEXT PRIMARY KEY, agent TEXT, kind TEXT NOT NULL, text TEXT NOT NULL,
      evidence TEXT NOT NULL, conversation_id TEXT NOT NULL, status TEXT NOT NULL, replaces TEXT, created_at INTEGER NOT NULL,
      decided_at INTEGER, decided_by TEXT)`);
    // Every change, so a lesson's history survives later edits and removals.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS lesson_events (lesson_id TEXT NOT NULL, status TEXT NOT NULL, at INTEGER NOT NULL, by TEXT)`);
    this.sql.exec("CREATE TABLE IF NOT EXISTS suppressed (hash TEXT PRIMARY KEY, at INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS reviews (day TEXT PRIMARY KEY, count INTEGER NOT NULL)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS lessons_status ON lessons (status, created_at)");
    if (!this.sql.exec<{ name: string }>("PRAGMA table_info(lessons)").toArray().some(column => column.name === "source")) {
      this.sql.exec("ALTER TABLE lessons ADD COLUMN source TEXT");
    }
  }

  private row(id: string): Row | undefined {
    return this.sql.exec<Row>("SELECT * FROM lessons WHERE id = ?", id).toArray()[0];
  }

  /** The agent a lesson belongs to (null: client-wide), or undefined when there is no such lesson. */
  async agentOf(id: string): Promise<string | null | undefined> {
    return this.row(id)?.agent;
  }

  async get(id: string): Promise<Lesson | undefined> {
    const row = this.row(id);
    return row && toLesson(row);
  }

  /** Chat dedupe returns the persisted state, but never changes an existing lesson's scope or teacher. */
  async proposeChat(id: string, p: LessonProposal): Promise<ProposeResult> {
    const existing = this.row(id);
    if (existing) {
      if (existing.agent !== p.agent || existing.text !== p.text || existing.evidence !== p.evidence ||
          existing.source !== JSON.stringify(p.source)) return { ok: false, reason: "This action already named a different lesson." };
      return { ok: true, lesson: toLesson(existing) };
    }
    const duplicate = this.sql.exec<Row>("SELECT * FROM lessons").toArray().find(row => normalize(row.text) === normalize(p.text));
    if (duplicate) {
      if (duplicate.agent !== p.agent) return { ok: false, reason: "This lesson already exists with a different scope; review it in the Learned tab." };
      return { ok: true, lesson: toLesson(duplicate) };
    }
    const filed = await this.propose(id, p);
    if (filed.ok) return filed;
    // Another conversation may have filed the same words while propose hashed them.
    const prior = this.sql.exec<Row>("SELECT * FROM lessons").toArray().find(row => normalize(row.text) === normalize(p.text));
    return prior && prior.agent === p.agent ? { ok: true, lesson: toLesson(prior) } : filed;
  }

  private event(id: string, status: LessonStatus, at: number, by: string | null): void {
    this.sql.exec("INSERT INTO lesson_events (lesson_id, status, at, by) VALUES (?, ?, ?, ?)", id, status, at, by);
  }

  /** Files a proposal. Idempotent by id; refuses removed (suppressed) text and duplicates of open lessons. */
  async propose(id: string, p: LessonProposal): Promise<ProposeResult> {
    const existing = this.row(id);
    if (existing) return { ok: true, lesson: toLesson(existing) };
    const text = p.text.trim(), evidence = p.evidence.trim();
    if (!LESSON_KINDS.includes(p.kind)) return { ok: false, reason: "Unknown lesson kind." };
    if (text.length < 10 || text.length > 300) return { ok: false, reason: "A lesson is 10 to 300 characters." };
    if (!evidence || evidence.length > 300) return { ok: false, reason: "Evidence must quote the person, up to 300 characters." };
    const key = await hash(text);
    // The hash awaits: recheck the id and dedupe after it, before inserting.
    const resumed = this.row(id);
    if (resumed) return { ok: true, lesson: toLesson(resumed) };
    if (this.sql.exec("SELECT 1 FROM suppressed WHERE hash = ?", key).toArray().length) return { ok: false, reason: "A person removed this lesson before; it cannot be proposed again." };
    const open = this.sql.exec<{ id: string; text: string }>("SELECT id, text FROM lessons WHERE status IN ('proposed', 'active')").toArray();
    if (open.some(o => normalize(o.text) === normalize(text))) return { ok: false, reason: "This lesson already exists." };
    if (open.length >= MAX_OPEN) return { ok: false, reason: "Too many lessons are waiting; a person must decide some first." };
    if (p.replaces && this.row(p.replaces)?.status !== "active") return { ok: false, reason: "replaces must name an active lesson." };
    const now = Date.now();
    this.sql.exec(`INSERT INTO lessons (id, agent, kind, text, evidence, conversation_id, status, replaces, created_at, source)
      VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?)`, id, p.agent, p.kind, text, evidence, p.conversationId, p.replaces ?? null, now, p.source ? JSON.stringify(p.source) : null);
    this.event(id, "proposed", now, null);
    return { ok: true, lesson: toLesson(this.row(id)!) };
  }

  /** Approve: proposed → active (and the lesson it replaces → removed, without blocking its text). Remove: → removed, blocked. */
  async decideChat(id: string, decision: "approve" | "remove", clientId: string, agent: string, by: string): Promise<DecideResult> {
    const client = CLIENTS.find(client => client.id === clientId);
    const row = this.row(id);
    if (!client || !row || row.agent !== null && row.agent !== agent) return { ok: false, status: 404, error: "Lesson not found for this agent." };
    // Finish asynchronous hashing before checking current synced rights, then persist without another await.
    const key = decision === "remove" ? await hash(row.text) : undefined;
    if (!await may(this.env as unknown as Bindings, client, "approve", by, row.agent)) {
      return decision === "approve" ? { ok: true, lesson: toLesson(this.row(id)!) }
        : { ok: false, status: 409, error: "Only a current approver for this lesson may decide it." };
    }
    return this.applyDecision(id, decision, by, key);
  }

  async decide(id: string, decision: "approve" | "remove", by: string): Promise<DecideResult> {
    const row = this.row(id);
    const key = row && decision === "remove" ? await hash(row.text) : undefined;
    return this.applyDecision(id, decision, by, key);
  }

  private applyDecision(id: string, decision: "approve" | "remove", by: string, key?: string): DecideResult {
    const row = this.row(id);
    if (!row) return { ok: false, status: 404, error: "Not found" };
    const now = Date.now();
    if (decision === "approve") {
      if (row.status === "active") return { ok: true, lesson: toLesson(row) };
      if (row.status !== "proposed") return { ok: false, status: 409, error: "This lesson was removed." };
      this.ctx.storage.transactionSync(() => {
        this.sql.exec("UPDATE lessons SET status = 'active', decided_at = ?, decided_by = ? WHERE id = ?", now, by, id);
        this.event(id, "active", now, by);
        if (row.replaces && this.row(row.replaces)?.status === "active") {
          this.sql.exec("UPDATE lessons SET status = 'removed', decided_at = ?, decided_by = ? WHERE id = ?", now, by, row.replaces);
          this.event(row.replaces, "removed", now, by);
        }
      });
    } else {
      if (row.status === "removed") return { ok: true, lesson: toLesson(row) };
      this.ctx.storage.transactionSync(() => {
        this.sql.exec("UPDATE lessons SET status = 'removed', decided_at = ?, decided_by = ? WHERE id = ?", now, by, id);
        this.sql.exec("INSERT OR IGNORE INTO suppressed (hash, at) VALUES (?, ?)", key!, now);
        this.event(id, "removed", now, by);
      });
    }
    return { ok: true, lesson: toLesson(this.row(id)!) };
  }

  /** Proposed (newest first), then active (newest first), for this agent and client-wide. */
  async list(agent: string): Promise<Lesson[]> {
    return this.sql.exec<Row>(`SELECT * FROM lessons WHERE status IN ('proposed', 'active') AND (agent IS NULL OR agent = ?)
      ORDER BY status = 'active', created_at DESC`, agent).toArray().map(toLesson);
  }

  /** Every active lesson for this agent (its own and the client's shared ones), newest first; pickLessons chooses what a run is given. */
  async active(agent: string): Promise<Lesson[]> {
    return this.sql.exec<Row>("SELECT * FROM lessons WHERE status = 'active' AND (agent IS NULL OR agent = ?) ORDER BY created_at DESC",
      agent).toArray().map(toLesson);
  }

  /** Open lessons whose text shares words with `query`, for the reviewer (so it reuses or replaces instead of duplicating). */
  async search(query: string, limit = 10): Promise<Lesson[]> {
    const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, 12);
    return this.sql.exec<Row>("SELECT * FROM lessons WHERE status IN ('proposed', 'active') ORDER BY created_at DESC").toArray().map(toLesson)
      .map(lesson => ({ lesson, score: words.filter(w => lesson.text.toLowerCase().includes(w)).length }))
      .filter(item => !words.length || item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(item => item.lesson);
  }

  /** Counts one review against today's allowance; false when the day's reviews are used up. */
  async admitReview(day: string): Promise<boolean> {
    const count = this.sql.exec<{ count: number }>("SELECT count FROM reviews WHERE day = ?", day).toArray()[0]?.count ?? 0;
    if (count >= MAX_REVIEWS_PER_DAY) return false;
    this.sql.exec("INSERT INTO reviews (day, count) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET count = count + 1", day);
    this.sql.exec("DELETE FROM reviews WHERE day < ?", day);
    return true;
  }
}
