import { DurableObject } from "cloudflare:workers";
import { reviewedText } from "../agents/iris/page-text";
import { CLIENTS } from "../clients";
import type { AdminStuckStep, ApprovalChoice, JsonObject } from "./contracts";
import { legacyRequestOrigin, requestOrigin } from "./stuck";

// One dashboard per client. Agents write cards; the client's staff read them.

/** "alert" cards come from the runtime (failed jobs, limits hit), never from agents. */
export type CardKind = "report" | "status" | "needs_approval" | "alert";

export interface Card {
  id: string;
  agent: string;
  kind: CardKind;
  title: string;
  summary: string;
  /** Raw results of the tool calls the card cites, copied by the runtime, never written by the model. */
  data: JsonObject;
  conversationId: string;
  createdAt: number;
  updatedAt: number;
  requestedBy?: string | null;
  source?: AdminStuckStep["source"];
}

interface CardRow extends Record<string, SqlStorageValue> {
  id: string; agent: string; kind: string; title: string; summary: string; data: string;
  conversation_id: string; created_at: number; updated_at: number;
}

const MAX_CARDS = 2_000;
const MAX_LOG = 5_000;

function toCard(row: CardRow, approval?: ApprovalRow): Card {
  return {
    id: row.id, agent: row.agent, kind: row.kind as CardKind, title: row.title, summary: row.summary,
    data: JSON.parse(row.data) as JsonObject, conversationId: row.conversation_id,
    createdAt: row.created_at, updatedAt: row.updated_at,
    ...(approval ? { requestedBy: approval.source === null ? null : approval.requested_by, source: approval.source ?? legacyRequestOrigin(approval.conversation_id).source } : {}),
  };
}

interface ApprovalRow extends Record<string, SqlStorageValue> {
  id: string; agent: string; conversation_id: string; tool: string; title: string; summary: string; preview: string;
  status: string; decided_by: string | null; reason: string | null; result: string | null; created_at: number; decided_at: number | null; settings_hash: string | null;
  requested_by: string | null; source: Approval["source"] | null;
  choices: string | null; default_choice: string | null; choice: string | null; choice_plans: string | null;
}

export interface Approval {
  id: string; agent: string; conversationId: string; tool: string; title: string; summary: string; preview: JsonObject;
  status: "pending" | "approved" | "declined" | "done" | "failed" | "uncertain";
  decidedBy?: string; reason?: string; result?: JsonObject; createdAt: number; decidedAt?: number;
  requestedBy: string | null; source: AdminStuckStep["source"];
  choices?: ApprovalChoice[]; defaultChoice?: string; choice?: string;
}

function toApproval(row: ApprovalRow): Approval {
  const preview = JSON.parse(row.preview) as JsonObject;
  if (row.agent === "iris" && row.tool === "submit_seo_copy" && typeof preview?.current === "string") {
    preview.current = reviewedText(preview.current, String(preview.field), preview.pageTextFormat);
    preview.pageTextFormat = "plain";
  }
  return {
    id: row.id, agent: row.agent, conversationId: row.conversation_id, tool: row.tool, title: row.title, summary: row.summary,
    requestedBy: row.source === null ? null : row.requested_by, source: row.source ?? legacyRequestOrigin(row.conversation_id).source,
    preview, status: row.status as Approval["status"],
    decidedBy: row.decided_by ?? undefined, reason: row.reason ?? undefined,
    result: row.result ? JSON.parse(row.result) as JsonObject : undefined, createdAt: row.created_at, decidedAt: row.decided_at ?? undefined,
    ...(row.choices ? { choices: JSON.parse(row.choices), defaultChoice: row.default_choice ?? undefined, choice: row.choice ?? undefined } : {}),
  };
}

export interface StuckReconcilePage {
  agent: string;
  ids: string[];
  cursor: string;
  finished: boolean;
}

export class Dashboard extends DurableObject<Cloudflare.Env> {
  private readonly sql = this.ctx.storage.sql;
  private readonly resolvingOrigins = new Map<string, Promise<Pick<AdminStuckStep, "requestedBy" | "source"> | undefined>>();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY, agent TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
      data TEXT NOT NULL, conversation_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY, agent TEXT NOT NULL, conversation_id TEXT NOT NULL, tool TEXT NOT NULL,
      title TEXT NOT NULL, summary TEXT NOT NULL, preview TEXT NOT NULL, status TEXT NOT NULL,
      decided_by TEXT, reason TEXT, result TEXT, created_at INTEGER NOT NULL, decided_at INTEGER)`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS cards_agent_updated ON cards (agent, updated_at)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS cards_conversation ON cards (conversation_id)");
    // The card list (newest first) and the bounded-store clean-up sort every card without these.
    this.sql.exec("CREATE INDEX IF NOT EXISTS cards_updated ON cards (updated_at)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS cards_created ON cards (created_at)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS approvals_conversation_tool ON approvals (conversation_id, agent, tool, created_at)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS approvals_status_created ON approvals (status, created_at)");
    // Added after the table first shipped: the fingerprint of the agent's settings when the proposal was filed.
    if (!this.sql.exec<{ name: string }>("PRAGMA table_info(approvals)").toArray().some(column => column.name === "settings_hash")) {
      this.sql.exec("ALTER TABLE approvals ADD COLUMN settings_hash TEXT");
    }
    // The fingerprints of the writes a proposal will make (front desk): only these run after approval.
    if (!this.sql.exec<{ name: string }>("PRAGMA table_info(approvals)").toArray().some(column => column.name === "write_plan")) {
      this.sql.exec("ALTER TABLE approvals ADD COLUMN write_plan TEXT");
    }
    const approvalColumns = this.sql.exec<{ name: string }>("PRAGMA table_info(approvals)").toArray();
    if (!approvalColumns.some(column => column.name === "requested_by")) this.sql.exec("ALTER TABLE approvals ADD COLUMN requested_by TEXT");
    if (!approvalColumns.some(column => column.name === "source")) this.sql.exec("ALTER TABLE approvals ADD COLUMN source TEXT");
    for (const column of ["choices", "default_choice", "choice", "choice_plans"]) {
      if (!approvalColumns.some(existing => existing.name === column)) this.sql.exec(`ALTER TABLE approvals ADD COLUMN ${column} TEXT`);
    }
    this.sql.exec("CREATE TABLE IF NOT EXISTS snapshots (agent TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (agent, kind))");
    this.sql.exec("CREATE TABLE IF NOT EXISTS settings (agent TEXT PRIMARY KEY, json TEXT NOT NULL)");
    // Approved fingerprints the desk has sent, per action: each listing in the write plan goes out once.
    this.sql.exec("CREATE TABLE IF NOT EXISTS consumed_writes (action_id TEXT NOT NULL, fingerprint TEXT NOT NULL, used INTEGER NOT NULL, PRIMARY KEY (action_id, fingerprint))");
    // Every request the front desk sent or refused for this client: who, which connection, where. Never a credential.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS connection_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
      agent TEXT NOT NULL, tool TEXT NOT NULL, action_id TEXT NOT NULL, connection TEXT NOT NULL, method TEXT NOT NULL,
      host TEXT NOT NULL, path TEXT NOT NULL, outcome TEXT NOT NULL, status INTEGER, reason TEXT)`);
    // Every conversation of each agent, so a staff reset can find the Conversation objects (their names are not listable).
    this.sql.exec("CREATE TABLE IF NOT EXISTS conversations (agent TEXT NOT NULL, conversation_id TEXT NOT NULL, PRIMARY KEY (agent, conversation_id))");
    const conversationColumns = this.sql.exec<{ name: string }>("PRAGMA table_info(conversations)").toArray();
    if (!conversationColumns.some(column => column.name === "call_user")) this.sql.exec("ALTER TABLE conversations ADD COLUMN call_user TEXT");
    if (!conversationColumns.some(column => column.name === "call_started_at")) this.sql.exec("ALTER TABLE conversations ADD COLUMN call_started_at INTEGER");
    this.sql.exec("CREATE INDEX IF NOT EXISTS person_calls ON conversations (agent, call_user, call_started_at DESC)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS stuck_steps (
      agent TEXT NOT NULL, conversation_id TEXT NOT NULL, action_id TEXT NOT NULL,
      created_at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (agent, conversation_id, action_id))`);
    const stuckColumns = this.sql.exec<{ name: string }>("PRAGMA table_info(stuck_steps)").toArray();
    if (!stuckColumns.some(column => column.name === "last_check")) this.sql.exec("ALTER TABLE stuck_steps ADD COLUMN last_check INTEGER NOT NULL DEFAULT 0");
    if (!stuckColumns.some(column => column.name === "written_at")) this.sql.exec("ALTER TABLE stuck_steps ADD COLUMN written_at INTEGER NOT NULL DEFAULT 0");
    this.sql.exec("CREATE TABLE IF NOT EXISTS stuck_reconcile (id INTEGER PRIMARY KEY CHECK (id = 1), started_at INTEGER NOT NULL)");
    const reconcileColumns = this.sql.exec<{ name: string }>("PRAGMA table_info(stuck_reconcile)").toArray();
    if (!reconcileColumns.some(column => column.name === "claim")) this.sql.exec("ALTER TABLE stuck_reconcile ADD COLUMN claim TEXT");
    if (!reconcileColumns.some(column => column.name === "claimed_at")) this.sql.exec("ALTER TABLE stuck_reconcile ADD COLUMN claimed_at INTEGER");
    if (!reconcileColumns.some(column => column.name === "complete")) this.sql.exec("ALTER TABLE stuck_reconcile ADD COLUMN complete INTEGER NOT NULL DEFAULT 0");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS stuck_reconcile_agents (
      agent TEXT PRIMARY KEY, cursor TEXT NOT NULL, finished INTEGER NOT NULL, failed INTEGER NOT NULL)`);
    // Who may decide proposals (approvers) and change settings (managers), per agent: pushed by the agents app
    // (PUT /v1/access/approvers), the full state each time. Neither right implies the other.
    this.sql.exec("CREATE TABLE IF NOT EXISTS approvers (agent TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (agent, user_id))");
    this.sql.exec("CREATE TABLE IF NOT EXISTS managers (agent TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (agent, user_id))");
    this.sql.exec("CREATE TABLE IF NOT EXISTS approvers_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)");
  }

  private upsertStuck(step: AdminStuckStep): void {
    this.sql.exec(`INSERT INTO stuck_steps (agent, conversation_id, action_id, created_at, data, written_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent, conversation_id, action_id) DO UPDATE SET data = excluded.data, written_at = excluded.written_at`,
      step.agent, step.conversationId, step.actionId, step.createdAt, JSON.stringify(step), Date.now());
  }

  async putStuck(step: AdminStuckStep): Promise<void> {
    this.upsertStuck(step);
  }

  async replaceStuck(agent: string, conversationId: string, steps: AdminStuckStep[]): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM stuck_steps WHERE agent = ? AND conversation_id = ?
        AND action_id NOT IN (SELECT value FROM json_each(?))`, agent, conversationId, JSON.stringify(steps.map(step => step.actionId)));
      for (const step of steps) this.upsertStuck(step);
    });
  }

  /** One claimed page per unfinished agent; a lost request can reclaim its unchanged cursors after ten minutes. */
  async beginStuckReconcile(agents: string[]): Promise<{ id: string; pages: StuckReconcilePage[] } | undefined> {
    const now = Date.now();
    const last = this.sql.exec<{ started_at: number; claim: string | null; claimed_at: number | null; complete: number }>("SELECT started_at, claim, claimed_at, complete FROM stuck_reconcile WHERE id = 1").toArray()[0];
    if (last?.claim && now - (last.claimed_at ?? 0) < 10 * 60_000) return undefined;
    const states = agents.map(agent => this.sql.exec<{ cursor: string; finished: number }>("SELECT cursor, finished FROM stuck_reconcile_agents WHERE agent = ?", agent).toArray()[0]);
    const unfinished = states.some(state => !state?.finished);
    if (!unfinished && last && now - last.started_at < 10 * 60_000) return undefined;
    const id = crypto.randomUUID();
    const pages: StuckReconcilePage[] = [];
    this.ctx.storage.transactionSync(() => {
      for (const [index, agent] of agents.entries()) {
        const state = states[index];
        if (unfinished && state?.finished) continue;
        if (!unfinished || !state) this.sql.exec("INSERT OR REPLACE INTO stuck_reconcile_agents (agent, cursor, finished, failed) VALUES (?, '', 0, 0)", agent);
        const cursor = unfinished ? state?.cursor ?? "" : "";
        const ids = this.sql.exec<{ conversation_id: string }>(
          "SELECT conversation_id FROM conversations WHERE agent = ? AND conversation_id > ? ORDER BY conversation_id LIMIT 201", agent, cursor)
          .toArray().map(row => row.conversation_id);
        const finished = ids.length <= 200;
        if (!finished) ids.pop();
        pages.push({ agent, ids, cursor: finished ? "" : ids[ids.length - 1], finished });
      }
      this.sql.exec("INSERT OR REPLACE INTO stuck_reconcile (id, started_at, claim, claimed_at, complete) VALUES (1, ?, ?, ?, ?)", last?.started_at ?? 0, id, now, last?.complete ?? 0);
    });
    return { id, pages };
  }

  async finishStuckReconcile(id: string, agents: string[], pages: (StuckReconcilePage & { failed: boolean })[]): Promise<void> {
    if (this.sql.exec<{ claim: string | null }>("SELECT claim FROM stuck_reconcile WHERE id = 1").toArray()[0]?.claim !== id) return;
    this.ctx.storage.transactionSync(() => {
      for (const page of pages) {
        this.sql.exec("UPDATE stuck_reconcile_agents SET cursor = ?, finished = ?, failed = MAX(failed, ?) WHERE agent = ?",
          page.cursor, Number(page.finished), Number(page.failed), page.agent);
      }
      const finished = agents.every(agent => this.sql.exec<{ finished: number }>("SELECT finished FROM stuck_reconcile_agents WHERE agent = ?", agent).toArray()[0]?.finished === 1);
      if (finished) {
        const complete = agents.every(agent => this.sql.exec<{ failed: number }>("SELECT failed FROM stuck_reconcile_agents WHERE agent = ?", agent).one().failed === 0);
        this.sql.exec("UPDATE stuck_reconcile SET started_at = ?, complete = ? WHERE id = 1", Date.now(), Number(complete));
      }
      this.sql.exec("UPDATE stuck_reconcile SET claim = NULL, claimed_at = NULL WHERE id = 1");
    });
  }


  async removeStuck(agent: string, conversationId: string, actionId: string): Promise<void> {
    this.sql.exec("DELETE FROM stuck_steps WHERE agent = ? AND conversation_id = ? AND action_id = ?", agent, conversationId, actionId);
  }

  async stuck(): Promise<{ steps: AdminStuckStep[]; complete: boolean }> {
    const steps = this.sql.exec<{ data: string }>("SELECT data FROM stuck_steps ORDER BY created_at DESC, agent, conversation_id, action_id")
      .toArray().map(row => JSON.parse(row.data) as AdminStuckStep);
    const complete = this.sql.exec<{ complete: number }>("SELECT complete FROM stuck_reconcile WHERE id = 1").toArray()[0]?.complete === 1;
    return { steps, complete };
  }

  // ---- Approvers and managers per agent.

  /** Replaces every agent's lists when `version` is not older than the stored one; false (nothing stored) when it is. */
  async setApprovers(version: number, approvers: Record<string, string[]>, managers: Record<string, string[]>): Promise<boolean> {
    const held = this.sql.exec<{ version: number }>("SELECT version FROM approvers_version").toArray()[0]?.version ?? 0;
    if (version < held) return false;
    this.ctx.storage.transactionSync(() => {
      for (const [table, lists] of [["approvers", approvers], ["managers", managers]] as const) {
        this.sql.exec(`DELETE FROM ${table}`);
        for (const [agent, users] of Object.entries(lists)) {
          for (const user of users) this.sql.exec(`INSERT OR IGNORE INTO ${table} (agent, user_id) VALUES (?, ?)`, agent, user);
        }
      }
      this.sql.exec("INSERT OR REPLACE INTO approvers_version (id, version) VALUES (1, ?)", version);
    });
    return true;
  }

  /** Whether the person is on the agent's approver list; with no agent (a client-wide lesson), on any agent's list. */
  async mayApprove(userId: string, agent: string | null): Promise<boolean> {
    return this.sql.exec("SELECT 1 FROM approvers WHERE user_id = ? AND (? IS NULL OR agent = ?)", userId, agent, agent).toArray().length > 0;
  }

  /** Whether the person is on the agent's manager list (settings). Being an approver does not count. */
  async mayManage(userId: string, agent: string): Promise<boolean> {
    return this.sql.exec("SELECT 1 FROM managers WHERE user_id = ? AND agent = ?", userId, agent).toArray().length > 0;
  }

  // ---- Staff reset of one agent (POST /v1/agents/:agent/reset). Settings and the connection log are never touched.

  /** Idempotent: notes that this conversation exists. */
  async registerConversation(agent: string, conversationId: string): Promise<void> {
    this.sql.exec("INSERT OR IGNORE INTO conversations (agent, conversation_id) VALUES (?, ?)", agent, conversationId);
  }

  /** Only trusted signed app voice ingress registers a call; ids are not evidence of its person or channel. */
  async registerAppCall(agent: string, conversationId: string, userId: string, startedAt: number): Promise<void> {
    this.sql.exec(`INSERT INTO conversations (agent, conversation_id, call_user, call_started_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(agent, conversation_id) DO UPDATE SET call_user = excluded.call_user, call_started_at = excluded.call_started_at`,
      agent, conversationId, userId, startedAt);
  }

  async recentCallIds(agent: string, userId: string, since: number): Promise<string[]> {
    return this.sql.exec<{ conversation_id: string }>(`SELECT conversation_id FROM conversations
      WHERE agent = ? AND call_user = ? AND call_started_at >= ? ORDER BY call_started_at DESC, conversation_id DESC LIMIT 20`,
      agent, userId, since).toArray().map(row => row.conversation_id);
  }

  /** Up to `limit` registered conversation ids of the agent. */
  async conversationIds(agent: string, limit: number): Promise<string[]> {
    return this.sql.exec<{ conversation_id: string }>("SELECT conversation_id FROM conversations WHERE agent = ? LIMIT ?", agent, limit).toArray().map(r => r.conversation_id);
  }

  /** Drops wiped conversations from the registry; returns how many remain for the agent. */
  async forgetConversations(agent: string, ids: string[]): Promise<number> {
    for (const id of ids) this.sql.exec("DELETE FROM conversations WHERE agent = ? AND conversation_id = ?", agent, id);
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM conversations WHERE agent = ?", agent).one().n;
  }

  /** Deletes the agent's cards, approvals (with the writes they consumed) and snapshots; returns what was removed. */
  async resetAgent(agent: string): Promise<{ cards: number; approvals: number; snapshots: number }> {
    const count = (table: string) => this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE agent = ?`, agent).one().n;
    const removed = { cards: count("cards"), approvals: count("approvals"), snapshots: count("snapshots") };
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM consumed_writes WHERE action_id IN (SELECT id FROM approvals WHERE agent = ?)", agent);
      this.sql.exec("DELETE FROM stuck_steps WHERE agent = ?", agent);
      this.sql.exec("DELETE FROM stuck_reconcile_agents WHERE agent = ?", agent);
      for (const table of ["cards", "approvals", "snapshots"]) this.sql.exec(`DELETE FROM ${table} WHERE agent = ?`, agent);
    });
    return removed;
  }


  // ---- Connection log (front desk).

  async logRequest(entry: { agent: string; tool: string; actionId: string; connection: string; method: string; host: string; path: string; outcome: string; status?: number; reason?: string }): Promise<void> {
    this.sql.exec(`INSERT INTO connection_log (at, agent, tool, action_id, connection, method, host, path, outcome, status, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, Date.now(), entry.agent, entry.tool, entry.actionId, entry.connection, entry.method,
      entry.host, entry.path.slice(0, 300), entry.outcome, entry.status ?? null, entry.reason?.slice(0, 300) ?? null);
    this.sql.exec("DELETE FROM connection_log WHERE seq <= (SELECT MAX(seq) FROM connection_log) - ?", MAX_LOG);
  }

  /** The latest `limit` log entries, newest first, as JSON text. */
  async requestLog(limit: number): Promise<string> {
    const rows = this.sql.exec("SELECT at, agent, tool, action_id, connection, method, host, path, outcome, status, reason FROM connection_log ORDER BY seq DESC LIMIT ?", limit).toArray();
    return JSON.stringify({ entries: rows.map(r => ({ at: r.at, agent: r.agent, tool: r.tool, actionId: r.action_id, connection: r.connection, method: r.method, host: r.host, path: r.path, outcome: r.outcome, ...(r.status !== null ? { status: r.status } : {}), ...(r.reason !== null ? { reason: r.reason } : {}) })) });
  }

  // ---- Snapshots: the latest good result of a tool that opted in, one per (agent, kind). Values cross RPC as JSON text.

  /** The stored value as JSON text, or undefined. */
  async snapshot(agent: string, kind: string): Promise<string | undefined> {
    return this.sql.exec<{ data: string }>("SELECT data FROM snapshots WHERE agent = ? AND kind = ?", agent, kind).toArray()[0]?.data;
  }

  async saveSnapshot(agent: string, kind: string, dataJson: string): Promise<void> {
    this.sql.exec("INSERT OR REPLACE INTO snapshots (agent, kind, data, updated_at) VALUES (?, ?, ?, ?)", agent, kind, dataJson, Date.now());
  }

  /** `{"agent":..., "snapshots": {kind: {at, data}}}` as JSON text. */
  async snapshots(agent: string): Promise<string> {
    const rows = this.sql.exec<{ kind: string; data: string; updated_at: number }>("SELECT kind, data, updated_at FROM snapshots WHERE agent = ?", agent).toArray();
    return JSON.stringify({ agent, snapshots: Object.fromEntries(rows.map(r => [r.kind, { at: r.updated_at, data: JSON.parse(r.data) }])) });
  }

  // ---- Settings staff changed in the app: only the overrides are stored; defaults stay in code.

  /** Stored overrides for an agent as JSON text (`{}` when none). */
  async settingOverrides(agent: string): Promise<string> {
    return this.sql.exec<{ json: string }>("SELECT json FROM settings WHERE agent = ?", agent).toArray()[0]?.json ?? "{}";
  }

  /** Merges `changesJson` into the stored overrides; returns the new overrides as JSON text. */
  async saveSettings(agent: string, changesJson: string): Promise<string> {
    const merged = JSON.stringify({ ...JSON.parse(await this.settingOverrides(agent)), ...JSON.parse(changesJson) });
    this.sql.exec("INSERT OR REPLACE INTO settings (agent, json) VALUES (?, ?)", agent, merged);
    return merged;
  }

  // ---- Approvals: an action a person must approve before it runs. Status: pending → approved | declined;
  // approved → done | failed | uncertain once the action has run. Each has a needs_approval card.

  private async resolveApprovalOrigin(clientId: string, row: ApprovalRow): Promise<void> {
    if (row.source !== null) return;
    let resolving = this.resolvingOrigins.get(row.id);
    if (!resolving) {
      resolving = (async () => {
        try {
          const origin = await this.env.CONVERSATIONS.get(this.env.CONVERSATIONS.idFromName(`${clientId}/${row.agent}/${row.conversation_id}`))
            .approvalOrigin(clientId, row.agent, row.conversation_id);
          this.sql.exec("UPDATE approvals SET requested_by = ?, source = ? WHERE id = ? AND source IS NULL", origin.requestedBy, origin.source, row.id);
          return origin;
        } catch (error) {
          console.error(error instanceof Error ? error.name : "Error");
          return undefined;
        }
      })().finally(() => this.resolvingOrigins.delete(row.id));
      this.resolvingOrigins.set(row.id, resolving);
    }
    const origin = await resolving;
    if (!origin) return;
    row.requested_by = origin.requestedBy;
    row.source = origin.source;
  }

  /** Idempotent by id (the action id). */
  async propose(p: { id: string; agent: string; conversationId: string; tool: string; title: string; summary: string; previewJson: string; clientId?: string; settingsHash?: string; writePlan?: string[]; choices?: ApprovalChoice[]; defaultChoice?: string; choicePlans?: Record<string, { args: JsonObject; writePlan: string[] }>; singleProposal?: boolean; requestedBy?: string | null; source?: Approval["source"] }): Promise<void> {
    if (this.approvalRow(p.id)) return;
    if (p.singleProposal &&
        this.sql.exec("SELECT id FROM approvals WHERE conversation_id = ? AND agent = ? AND tool = ? LIMIT 1", p.conversationId, p.agent, p.tool).toArray().length) {
      throw new Error("This draft already has a revision.");
    }
    const now = Date.now();
    const origin = requestOrigin(p.source, p.requestedBy ?? undefined);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO approvals (id, agent, conversation_id, tool, title, summary, preview, status, created_at, settings_hash, write_plan, requested_by, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)",
        p.id, p.agent, p.conversationId, p.tool, p.title, p.summary, p.previewJson, now, p.settingsHash ?? null, p.writePlan ? JSON.stringify(p.writePlan) : null, origin.requestedBy, origin.source);
      this.sql.exec("UPDATE approvals SET choices = ?, default_choice = ?, choice_plans = ? WHERE id = ?",
        p.choices ? JSON.stringify(p.choices) : null, p.defaultChoice ?? null, p.choicePlans ? JSON.stringify(p.choicePlans) : null, p.id);
      this.sql.exec("INSERT OR IGNORE INTO cards VALUES (?, ?, 'needs_approval', ?, ?, ?, ?, ?, ?)",
        `approval-${p.id}`, p.agent, p.title, p.summary, p.previewJson, p.conversationId, now, now);
    });
  }

  /** The settings fingerprint stored when the proposal was filed; undefined for an older proposal or an unknown id. */
  async settingsHash(id: string): Promise<string | undefined> {
    return this.approvalRow(id)?.settings_hash ?? undefined;
  }

  /** The write fingerprints stored when the proposal was filed (empty for none or an older proposal). */
  async writePlan(id: string): Promise<string[]> {
    const raw = this.sql.exec<{ write_plan: string | null }>("SELECT write_plan FROM approvals WHERE id = ?", id).toArray()[0]?.write_plan;
    return raw ? JSON.parse(raw) as string[] : [];
  }

  /** Only the chosen arguments leave storage; plans and arguments of other choices never reach the executor. */
  async approvedArgs(id: string): Promise<JsonObject | undefined> {
    const row = this.approvalRow(id);
    if (!row?.choice || !row.choice_plans || row.status === "pending" || row.status === "declined") return undefined;
    return (JSON.parse(row.choice_plans) as Record<string, { args: JsonObject }>)[row.choice]?.args;
  }

  /**
   * Uses up one listing of `fingerprint` in the action's stored write plan: true once per listing, false when all are used
   * (or it is not in the plan). Runs in this object, so two concurrent sends cannot both get it. The desk calls it before
   * it sends an approved write.
   */
  async consumeFingerprint(actionId: string, fingerprint: string): Promise<boolean> {
    // No await between the read and the write: nothing else runs in this object in between.
    const raw = this.sql.exec<{ write_plan: string | null }>("SELECT write_plan FROM approvals WHERE id = ?", actionId).toArray()[0]?.write_plan;
    const allowed = (raw ? JSON.parse(raw) as string[] : []).filter(print => print === fingerprint).length;
    const used = this.sql.exec<{ used: number }>("SELECT used FROM consumed_writes WHERE action_id = ? AND fingerprint = ?", actionId, fingerprint).toArray()[0]?.used ?? 0;
    if (used >= allowed) return false;
    this.sql.exec("INSERT INTO consumed_writes (action_id, fingerprint, used) VALUES (?, ?, 1) ON CONFLICT (action_id, fingerprint) DO UPDATE SET used = used + 1", actionId, fingerprint);
    return true;
  }

  /** Gives one use back after the desk refused the request before sending it. */
  async releaseFingerprint(actionId: string, fingerprint: string): Promise<void> {
    this.sql.exec("UPDATE consumed_writes SET used = used - 1 WHERE action_id = ? AND fingerprint = ? AND used > 0", actionId, fingerprint);
  }

  /**
   * Records a decision. Only a pending approval can be decided; returns the approval as JSON text either way,
   * so the caller sees an earlier decision instead of overwriting it.
   */
  async decide(id: string, approve: boolean, decidedBy: string, reason: string, choice?: string): Promise<string | undefined> {
    const row = this.approvalRow(id);
    if (!row) return undefined;
    if (row.status !== "pending") return this.approvalJson(id);
    const plans = row.choice_plans ? JSON.parse(row.choice_plans) as Record<string, { args: JsonObject; writePlan: string[] }> : undefined;
    if (approve && row.choices && (!choice || !plans || !Object.hasOwn(plans, choice))) return JSON.stringify({ error: "Pick one of the options first." });
    this.sql.exec("UPDATE approvals SET status = ?, decided_by = ?, reason = ?, decided_at = ?, choice = ?, write_plan = ? WHERE id = ? AND status = 'pending'",
      approve ? "approved" : "declined", decidedBy, reason, Date.now(), approve && row.choices ? choice! : null,
      approve && row.choices ? JSON.stringify(plans![choice!].writePlan) : this.sql.exec<{ write_plan: string | null }>("SELECT write_plan FROM approvals WHERE id = ?", id).one().write_plan, id);
    return this.approvalJson(id);
  }

  /** After an approved action ran; scoped recovery may also complete a previously uncertain outcome. */
  async finish(id: string, status: "done" | "failed" | "uncertain", resultJson: string, recovered?: { agent: string; conversationId: string; tool: string }): Promise<string | undefined> {
    const row = this.approvalRow(id);
    if (!row) return undefined;
    if (recovered && (status !== "done" || row.agent !== recovered.agent || row.conversation_id !== recovered.conversationId || row.tool !== recovered.tool)) return this.approvalJson(id);
    if (row.status !== "approved" && !(recovered && row.status === "uncertain")) return this.approvalJson(id);
    const label = { done: "Done", failed: "Failed", uncertain: "Not confirmed" }[status];
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE approvals SET status = ?, result = ? WHERE id = ? AND status = ?", status, resultJson, id, row.status);
      this.sql.exec("UPDATE cards SET kind = ?, title = ?, updated_at = ? WHERE id = ?",
        status === "done" ? "status" : "alert", `${label}: ${row.title}`.slice(0, 120), Date.now(), `approval-${id}`);
    });
    return this.approvalJson(id);
  }

  /** Marks a declined approval's card. */
  async closeDeclined(id: string): Promise<void> {
    const row = this.approvalRow(id);
    if (row?.status !== "declined") return;
    this.sql.exec("UPDATE cards SET kind = 'status', title = ?, updated_at = ? WHERE id = ?", `Declined: ${row.title}`.slice(0, 120), Date.now(), `approval-${id}`);
  }

  /** Newest first, as JSON text `{"approvals":[...]}`, optionally only one status. */
  async approvals(status?: string, clientId?: string): Promise<string> {
    const rows = status
      ? this.sql.exec<ApprovalRow>("SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT 200", status).toArray()
      : this.sql.exec<ApprovalRow>("SELECT * FROM approvals ORDER BY created_at DESC LIMIT 200").toArray();
    if (clientId) await Promise.all(rows.map(row => this.resolveApprovalOrigin(clientId, row)));
    return JSON.stringify({ approvals: rows.map(toApproval) });
  }

  async conversationApproval(conversationId: string, agent: string, tool: string): Promise<string | undefined> {
    const row = this.sql.exec<ApprovalRow>("SELECT * FROM approvals WHERE agent = ? AND tool = ? AND conversation_id = ? ORDER BY created_at ASC LIMIT 1", agent, tool, conversationId).toArray()[0];
    return row && JSON.stringify(toApproval(row));
  }

  async approvalJson(id: string, clientId?: string): Promise<string | undefined> {
    const row = this.approvalRow(id);
    if (row && clientId) await this.resolveApprovalOrigin(clientId, row);
    return row && JSON.stringify(toApproval(row));
  }

  private approvalRow(id: string): ApprovalRow | undefined {
    return this.sql.exec<ApprovalRow>("SELECT * FROM approvals WHERE id = ?", id).toArray()[0];
  }

  /**
   * Idempotent by id: posting the same card again keeps the stored one unchanged. Returns the card id.
   * `dataJson` is the card data as JSON text, which crosses Durable Object RPC without type gymnastics.
   */
  async post(card: Omit<Card, "createdAt" | "updatedAt" | "data"> & { dataJson: string; clientId?: string }): Promise<string> {
    if (await this.has(card.id)) return card.id;
    // Oldest cards drop off so the store stays bounded.
    this.sql.exec("DELETE FROM cards WHERE id IN (SELECT id FROM cards ORDER BY created_at DESC LIMIT -1 OFFSET ?)", MAX_CARDS - 1);
    const now = Date.now();
    this.sql.exec("INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      card.id, card.agent, card.kind, card.title, card.summary, card.dataJson, card.conversationId, now, now);
    if (card.kind === "alert") this.notify(card.clientId, `Alert from ${card.agent}: ${card.title}\n${card.summary}`);
    return card.id;
  }

  /** Tells the team's Slack channel; only new alerts and approvals get here, so retries never post twice. Never blocks or fails the caller. */
  private notify(clientId: string | undefined, text: string): void {
    const url = (this.env as unknown as Record<string, unknown>).SLACK_ALERTS_WEBHOOK_URL;
    if (typeof url !== "string" || !url.startsWith("https://hooks.slack.com/")) return;
    const client = CLIENTS.find(c => c.id === clientId)?.name ?? clientId ?? "Unknown client";
    // Slack reads <, > and & as markup, so they are escaped.
    const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    this.ctx.waitUntil(fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: escape(`[${client}] ${text}`).slice(0, 3000) }),
    }).then(r => { if (!r.ok) console.error("slack alert failed", r.status); })
      .catch(error => console.error("slack alert failed", error instanceof Error ? error.name : typeof error)));
  }

  /**
   * Whether this conversation (one scheduled run) delivered a report or status card. Alerts (an output rule held a reply
   * back, a failure) and approval cards do not count: they are not the run's report.
   */
  async hasReportFromConversation(conversationId: string): Promise<boolean> {
    return this.sql.exec("SELECT 1 FROM cards WHERE conversation_id = ? AND kind IN ('report', 'status') LIMIT 1", conversationId).toArray().length > 0;
  }

  async has(id: string): Promise<boolean> {
    return this.sql.exec("SELECT 1 FROM cards WHERE id = ?", id).toArray().length > 0;
  }

  /** Only the agent that posted a card may change it. Setting the same values twice is harmless. */
  async update(id: string, agent: string, fields: { title?: string; summary?: string; kind?: CardKind }): Promise<boolean> {
    const card = await this.get(id);
    if (!card || card.agent !== agent) return false;
    const next = { ...card, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)), updatedAt: Date.now() };
    this.sql.exec("UPDATE cards SET title = ?, summary = ?, kind = ?, updated_at = ? WHERE id = ?", next.title, next.summary, next.kind, next.updatedAt, id);
    return true;
  }

  async get(id: string, clientId?: string): Promise<Card | undefined> {
    const row = this.sql.exec<CardRow>("SELECT * FROM cards WHERE id = ?", id).toArray()[0];
    const approval = row?.id.startsWith("approval-") ? this.approvalRow(row.id.slice(9)) : undefined;
    if (approval && clientId) await this.resolveApprovalOrigin(clientId, approval);
    return row && toCard(row, approval);
  }

  /** Newest first, as JSON text `{"cards":[...]}`. */
  async list(limit: number, clientId?: string): Promise<string> {
    const rows = this.sql.exec<CardRow>("SELECT * FROM cards ORDER BY updated_at DESC LIMIT ?", limit).toArray();
    const approvals = rows.map(row => row.id.startsWith("approval-") ? this.approvalRow(row.id.slice(9)) : undefined);
    if (clientId) await Promise.all(approvals.map(row => row && this.resolveApprovalOrigin(clientId, row)));
    return JSON.stringify({ cards: rows.map((row, index) => toCard(row, approvals[index])) });
  }

  /** Per agent: pending approvals and newest card (its time is the agent's last activity). */
  async summary(agents: string[]): Promise<Record<string, { toReview: number; latest: { title: string; kind: CardKind; at: number } | null }>> {
    const pending = new Map(this.sql.exec<{ agent: string; n: number }>(
      "SELECT agent, COUNT(*) AS n FROM approvals WHERE status = 'pending' GROUP BY agent").toArray().map(r => [r.agent, r.n]));
    return Object.fromEntries(agents.map(agent => {
      const row = this.sql.exec<CardRow>("SELECT * FROM cards WHERE agent = ? ORDER BY updated_at DESC LIMIT 1", agent).toArray()[0];
      return [agent, { toReview: pending.get(agent) ?? 0, latest: row ? { title: row.title, kind: row.kind as CardKind, at: row.updated_at } : null }];
    }));
  }
}
