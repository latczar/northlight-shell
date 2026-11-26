// Shapes the agent returns (agent/docs/reference.md). Shared by server code and client components.

export type AgentStatus = "needs_approval" | "active" | "idle";

export interface AgentSummary {
  id: string;
  name: string;
  role: string;
  status: AgentStatus;
  toReview: number;
  /** Milliseconds since epoch. */
  lastActive: number | null;
  latest: { title: string; kind: string; at: number } | null;
}

export type CardKind = "report" | "status" | "needs_approval" | "alert";

export interface Card {
  id: string;
  agent: string;
  kind: CardKind;
  title: string;
  summary: string;
  data: Record<string, unknown>;
  conversationId: string;
  /** Present on request cards (`approval-<id>`), also after a decision. A missing requester is admin-only. */
  requestedBy?: string | null;
  source?: Approval["source"];
  createdAt: number;
  updatedAt: number;
}

export type ApprovalStatus = "pending" | "approved" | "declined" | "done" | "failed" | "uncertain";

export interface Approval {
  id: string;
  agent: string;
  conversationId: string;
  requestedBy: string | null;
  source: "app" | "phone" | "slack" | "scheduled" | "other";
  tool: string;
  title: string;
  summary: string;
  preview: Record<string, unknown>;
  status: ApprovalStatus;
  decidedBy?: string;
  reason?: string;
  createdAt: number;
  decidedAt?: number;
}

export type LessonKind = "fact" | "preference" | "procedure" | "warning";

/** GET /v1/agents/:agent/lessons. Removed lessons are never listed. */
export interface Lesson {
  id: string;
  /** null = applies to every employee of this client. */
  agent: string | null;
  kind: LessonKind;
  text: string;
  /** The person's own words the lesson came from. */
  evidence: string;
  conversationId: string;
  status: "proposed" | "active" | "removed";
  /** An active lesson this one replaces on approval. */
  replaces?: string;
  createdAt: number;
  decidedAt?: number;
  decidedBy?: string;
}

/** The employee's background job for one conversation (GET …/job, and the `job` in POST …/jobs). Times are epoch ms. */
export type JobStatus = "running" | "waiting" | "needs_approval" | "done" | "failed" | "stopped";

export interface JobStep {
  label: string;
  state: "pending" | "active" | "done" | "failed";
}

export interface Job {
  id: string;
  status: JobStatus;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  steps: JobStep[];
  /** What the employee says it is doing now, or the running step's plain-words label. */
  current: string | null;
  /** Messages waiting behind this job. */
  queued: number;
  error?: string;
}

/** GET /v1/agents/:agent/setup. `secret` items are connected by Northlight on the server; `setting` items are configuration. */
export interface SetupItem {
  id: string;
  label: string;
  kind: "secret" | "setting";
  connected: boolean;
  /** Variable NAMES (secret) or setting keys (setting), never values. */
  missing: string[];
  unlocks: string;
  /** An optional item does not block `ready`. */
  optional?: boolean;
}

export interface AgentSetup {
  agent: string;
  ready: boolean;
  items: SetupItem[];
}

/** GET /v1/agents/:agent/data: the latest successful result of each tool that keeps one, by kind. */
export interface AgentData {
  agent: string;
  snapshots: Record<string, { at: number; data: unknown }>;
}

/** One saved chat line (GET …/messages). `seq` pages older lines via `before`. */
export interface ChatLine {
  seq: number;
  role: "user" | "assistant";
  text: string;
}
