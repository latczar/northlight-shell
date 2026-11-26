import type { Env } from "./conversation";
import type { DecisionReply } from "./approvals";
import type { Approval, Dashboard } from "./dashboard";
import type { Leads } from "./leads";
import type { Learning } from "./learning";
import type { Memory } from "./memory";
import type { OutputRule } from "./rules";
import type { Usage as UsageLedger } from "./usage";
import type { LessonTeaching } from "./lesson-access";

// Shared shapes: one conversation per Durable Object and native (multi-call) tool use.

export type JsonObject = Record<string, unknown>;

export interface Limits {
  /** Model calls allowed between two user messages. */
  maxTurnSteps: number;
  /** Wall time allowed between two user messages, including tools. */
  maxTurnActiveMs: number;
  /** Cumulative estimated model spend for the whole conversation; null disables it. */
  maxCostUsd: number | null;
  /** Most one background job may spend, on top of the client's daily cap. */
  maxJobCostUsd: number;
  modelTimeoutMs: number;
}

export interface ModelConfig {
  /** Provider API root; the adapter appends /chat/completions, /responses or /messages. */
  baseURL: string;
  /** Explicit native protocol. Absent: Chat Completions; "claude": Messages; "responses": OpenAI Responses. */
  api?: "claude" | "responses";
  model: string;
  /** Env var holding the API key. */
  secretEnv: string;
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  /** Prices of prompt-cache reads and writes, where the provider bills them apart. Absent: the input price. */
  cacheReadCostPerMillion?: number;
  cacheWriteCostPerMillion?: number;
  maxOutputTokens: number;
  /** Chat Completions output-limit field (default `max_tokens`); Responses always uses `max_output_tokens`. */
  maxTokensParam?: string;
  /** Compaction starts at `compactionThreshold` of this window. */
  contextWindowTokens: number;
  compactionThreshold?: number;
  /** Provider request fields, e.g. Responses `reasoning: { effort: "low" }`, Chat `reasoning_effort`, or Claude `output_config`. */
  extraBody?: JsonObject;
  /** Phone calls only: request fields and prices that replace the ones above, e.g. OpenAI's `service_tier: "priority"` (Fast mode: faster first word, twice the price). */
  voice?: { extraBody?: JsonObject; inputCostPerMillion?: number; outputCostPerMillion?: number };
  /** The model reads chat attachments and private tool pictures (src/vision.ts). */
  images?: boolean;
}

export interface AgentTemplate {
  /** Optional agent-specific handling for a reviewer requesting replacement work. */
  reviseApproval?(env: Pick<Env, "DASHBOARD" | "CONVERSATIONS">, client: ClientConfig, parent: Approval): Promise<DecisionReply>;
  id: string;
  name: string;
  role: string;
  prompt: string;
  /** Replacement for the job prompt on a phone call; otherwise the same prompt serves both channels. */
  voicePrompt?: string;
  /** Tool names from the catalog. A tool also needs the client's permission. */
  tools: string[];
  limits?: Partial<Limits>;
  /**
   * Whether this client owns a resource of `kind` named `value` (e.g. a preview branch its agent created). The
   * front desk calls it for `{kind}` placeholders in a connection's `writes` rules; it must only read state.
   */
  owns?(context: ToolContext, kind: string, value: string): Promise<boolean>;
  /**
   * What a phone call should know before the first question (read-only, plain data lines), warmed in the background when the
   * call starts (src/briefing.ts). `snapshot` reads one of this agent's dashboard snapshots. Absent or undefined: no briefing.
   */
  briefing?(input: { client: ClientConfig; context: ToolContext; snapshot(kind: string): Promise<unknown> }): Promise<string | undefined>;
  /** Says how to use this agent's briefing, in place of the standard sentence (written for ads figures and sites). It ends where the data begins. */
  briefingNote?: string;
  /** The briefing is read again for every call, never reused from a call a few minutes ago: what it shows changes between calls (a calendar). */
  briefingEveryCall?: boolean;
}

/** How the front desk adds a connection's credential. Every field names an env var (a Worker secret), never a value. */
export type ConnectionAuth =
  | { type: "bearer"; secret: string }
  | { type: "header"; name: string; secret: string; prefix?: string }
  | { type: "query"; param: string; secret: string }
  | { type: "basic"; user: string; password: string }
  | { type: "google"; clientId: string; clientSecret: string; refreshToken: string };

/**
 * A request pattern. Path segments: literal, `*` (any one), `**` (the rest), or a placeholder `{name}` /
 * `prefix{name}` (e.g. `act_{adAccountId}`), see Connection. Optional `query` (parameter name) and `body` (dotted
 * path into a JSON body, e.g. `project` or `gitSource.repo`) constraints must all hold: each pattern is a literal, a
 * placeholder checked like a path placeholder, or `null`: the field must be absent. A field that is there but is not
 * one string (a number, an object, a repeated query parameter) fails every pattern, `null` included, and a body that
 * is not JSON fails a rule with `body` constraints. A JSON boolean in a body counts as the string "true" or "false".
 */
export interface RequestRule { method: string; path: string; query?: Record<string, string | null>; body?: Record<string, string | null> }

/**
 * One outside service a client's agents may use (clients/<id>/<agent>.json `connections`). Tools never see its
 * credential: they ask the front desk (`context.connection(id)`), which checks the request and sends it.
 */
export interface Connection {
  id: string;
  /** Agents allowed to use it; filled from the file it is declared in. */
  agents: string[];
  /** "read": only `gets` and `reads`. "write": also `writes`, and requests a person approved. */
  access: "read" | "write";
  /** Hosts requests may go to: exact, "*.example.com", or "{kind}" for a host the client owns (AgentTemplate.owns(context, kind, host); e.g. a site from settings). */
  hosts: string[];
  /** Absent: the service needs no key. */
  auth?: ConnectionAuth;
  /** Non-secret identifiers kept as env vars (an ads account id): name → env var. Readable by tools. */
  ids?: Record<string, string>;
  /** Optional ids: a missing one is not "not connected". */
  optionalIds?: string[];
  /** Headers the desk adds; `{id}` is replaced by that identifier (an absent optional id drops the header). */
  headers?: Record<string, string>;
  /**
   * GET/HEAD paths this connection may read. Required on a keyed connection (no rule: no GET is sent), so a shared
   * agency credential cannot read another client's account; a keyless connection may GET anything on its hosts.
   */
  gets?: RequestRule[];
  /** Requests that are not GET/HEAD but only read (a search POST). */
  reads?: RequestRule[];
  /**
   * Characters the values of a query parameter may not contain, by parameter name (e.g. `{ "fields": "{}()" }` on Meta,
   * whose `fields=a{b}` and `a.fields(b)` expand into other objects past the path the rules checked). Absent: no check.
   */
  forbidQueryChars?: Record<string, string>;
  /**
   * Writes allowed without a person's approval. A `{name}` segment must equal the identifier `name`, or be a
   * resource of kind `name` the client owns (AgentTemplate.owns).
   */
  writes?: RequestRule[];
  /**
   * Name of a check in src/policies.ts on the body of every request to the one path it covers, approved or not: a
   * request to that path that breaks it is refused, and so is any other request that is not a read. Absent: none.
   */
  bodyPolicy?: string;
}

/** A write an approval tool will make, computed when it is proposed; only these run after approval. */
export interface PlannedRequest { connection: string; method: string; url: string; body?: string | Uint8Array }

/** What the front desk gives a tool for one connection. */
export interface ConnectionHandle {
  /** Env vars or ids not configured yet (names only); empty when connected. */
  missing: string[];
  /** A non-secret identifier; throws SafeConfigurationError when it is not set. */
  id(name: string): string;
  /** An identifier, or undefined when it is not set. */
  optionalId(name: string): string | undefined;
  /** Sends the request after the desk's checks, adding the credential. Refused requests throw ToolError (definite). */
  fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; redirect?: "follow" | "manual" | "error" }): Promise<Response>;
}

export interface ClientConfig {
  id: string;
  name: string;
  /** Env var holding this client's API token. */
  tokenEnv: string;
  /** Env var holding the key this client's server uses to sign user passes. Without it, memory is off. */
  userSigningEnv?: string;
  agents: string[];
  permissions: string[];
  model: ModelConfig;
  /** Non-voice model overrides (clients/<id>/<agent>.json `model`); calls use `model`. Read through modelFor (src/model.ts). */
  agentModels?: Record<string, ModelConfig>;
  /**
   * Models a test call may be tied to by name when it starts (POST /v1/voice/phone-start `test_model`, src/phone.ts), so
   * models can be compared on real calls without changing `model`. Each is a whole call model: none inherits `model.voice`.
   */
  callTestModels?: Record<string, ModelConfig>;
  limits?: Partial<Limits>;
  /** Per-client agent limits; calls retain client/template timing limits. Read through limitsFor (src/limits.ts). */
  agentLimits?: Record<string, Partial<Limits>>;
  /** Jobs that start an agent on a timetable, in the client's own time zone. */
  schedules?: Schedule[];
  /** Env var holding the key that signs staff passes for the client dashboard page. */
  dashboardSigningEnv?: string;
  /** Most this client may spend on models per UTC day, across all conversations and jobs. Default 5. */
  dailyCostCapUsd?: number;
  /** Things no agent of this client may say; checked sentence by sentence before delivery. */
  outputRules?: OutputRule[];
  /** Per-agent settings for this client (clients/<id>/<agent>.json `settings`). */
  agentSettings?: Record<string, JsonObject>;
  /** Env var holding the key that signs approver passes (purpose "approve"). Without it, nothing can be approved. */
  approverSigningEnv?: string;
  /** Env var holding the key that signs per-agent app approver and manager lists pushed by the agents app. */
  accessSigningEnv?: string;
  /**
   * Legacy Slack and voice approver ids. Without accessSigningEnv, also the app's approve/manage list.
   * With accessSigningEnv, app rights come only from synced per-agent lists; these ids grant no app rights.
   */
  approvers?: string[];
  /** Outside services this client's agents may use (merged from clients/<id>/<agent>.json `connections`). */
  connections?: Connection[];
  /** The client's Slack workspace, for an agent people talk to in Slack (src/slack.ts). Absent: no Slack routes. */
  slack?: SlackConfig;
  /** Phone calls only from approved numbers (src/phone.ts). Absent: every caller is accepted, anonymous. */
  phone?: PhoneConfig;
}

/** Approved callers: a brain secret holding a JSON object of phone numbers (digits, leading +) to the caller's first name. */
export interface PhoneConfig {
  callersEnv: string;
  /** The one agent whose phone line may take an approver's spoken yes, with the client's Slack people as the named callers. Unset: no spoken approvals. */
  spokenApprovalAgent?: string;
}

/**
 * Slack: messages arrive signed with the app's signing secret; the agent acts only for `people`, matched by the email of
 * their Slack account in this workspace. A person's `id` is also their approver id (ClientConfig.approvers).
 */
export interface SlackConfig {
  /** Env var holding the Slack app's signing secret (a brain secret: it only checks requests). */
  signingSecretEnv: string;
  /** The agent that answers in Slack. */
  agent: string;
  people: { id: string; name: string; email: string }[];
  /** The channel for posts that belong to no thread: approval cards from phone calls. */
  channel?: string;
}

export interface Schedule {
  /** Stable id; part of every run's id, so changing it starts a new history. */
  id: string;
  agent: string;
  /** Days of the week it runs, 0 = Sunday ... 6 = Saturday. Use either this or `monthDays`. */
  days?: number[];
  /** Days of the month it runs, 1-28 (so every month has them). Use either this or `days`. */
  monthDays?: number[];
  /** Local time, "HH:MM" (24-hour). */
  time: string;
  /** IANA time zone, e.g. America/Chicago. */
  timezone: string;
  /** What the agent should do; sent as the job's message. */
  task: string;
}

export interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string } }

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
/** A saved message, or a request-only user message with chat attachments or private tool pictures. History only saves ChatMessage. */
export type ModelMessage = ChatMessage | { role: "user"; content: ContentPart[] };

export interface ModelTool { name: string; description: string; parameters: JsonObject }

export interface Usage {
  /** Every input token of the request, cached or not. */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens the provider served from its prompt cache, when it reports them. */
  cachedTokens?: number;
  /** Input tokens the provider wrote to its prompt cache, when it bills them apart. */
  cacheWriteTokens?: number;
}

export interface ToolPicture { key: string; label: string; source?: "media" }
export interface ToolResult { data: JsonObject; pictures?: ToolPicture[] }

export type Reconciliation =
  | { status: "succeeded"; result: ToolResult }
  | { status: "absent" }
  | { status: "unknown"; reason: string };

/** Platform resources of the brain itself. */
export interface Bindings {
  IMAGES: R2Bucket;
  /** The client media library (bucket `northlight-media`). */
  MEDIA: R2Bucket;
  MEMORY: DurableObjectNamespace<Memory>;
  DASHBOARD: DurableObjectNamespace<Dashboard>;
  USAGE: DurableObjectNamespace<UsageLedger>;
  LEARNING: DurableObjectNamespace<Learning>;
  /** One lead store per client (src/leads.ts). */
  LEADS: DurableObjectNamespace<Leads>;
}

/** The Dashboard methods tools call: cards and reading approvals. Never settings, decisions or write plans. */
export type ToolDashboard = Pick<Dashboard, "post" | "has" | "update" | "approvals">;

/** What tools may do with the media library: list and head, never write or delete. */
export type ToolMedia = Pick<R2Bucket, "list" | "head">;

/** What tools may do with the lead store: ask for the intake address and key of a site they are creating. Never read a lead. */
export type ToolLeads = Pick<Leads, "intakeFor" | "intakeEnabled">;

/**
 * Platform resources tools may use: Dashboard, media and leads are narrowed; lesson writes use the runtime-bound
 * ToolContext.lessons capability rather than an unrestricted Learning namespace.
 */
export interface ToolBindings extends Omit<Bindings, "DASHBOARD" | "MEDIA" | "LEADS" | "LEARNING"> {
  DASHBOARD: { idFromName(name: string): DurableObjectId; get(id: DurableObjectId): ToolDashboard };
  MEDIA: ToolMedia;
  LEADS?: { idFromName(name: string): DurableObjectId; get(id: DurableObjectId): ToolLeads };
}

export interface ToolContext {
  /** Immutable inputs captured by this action's proposal, available for planning, execution and recovery. */
  readonly proposalInputs?: JsonObject;
  /** Checks only the signed person and agent for this turn. */
  mayManageAgent?(): Promise<boolean>;
  /** Runtime-bound lesson operations, only for an original signed-in app message. */
  lessons?: LessonTeaching;
  clientId: string;
  agentId: string;
  conversationId: string;
  /** The person this conversation is with, as identified by the client's own server. */
  userId?: string;
  actionId: string;
  /**
   * The trusted request this action belongs to, frozen on the action: the person's own words (without the header a route
   * writes around them) or a schedule's reviewed task, and when it was first received. `queued`: it arrived while a job
   * was still busy in the conversation, so it answers nothing that job asked later. Never unconfirmed model task text.
   */
  request?: { id: string; text: string; at?: number; queued?: boolean; scheduleId?: string; allowedTools?: string[]; singleProposal?: boolean; servicesCallId?: string; editorialRevision?: { id: string; url: string; field: string; proposed: string; feedback: string } };
  /** Runtime-only restriction for a spoken approval: tools must recheck that the effect still reaches nobody else before sending it. Never grants desk permission. */
  spokenApproval?: boolean;
  signal: AbortSignal;
  bindings: ToolBindings;
  /** Whether the desk has an env var of this agent's connections set (setup lists); never its value. Other names read as not set. */
  hasSecret(name: string): boolean;
  /** The front desk for one of this client's connections this agent may use; throws ToolError when it may not. */
  connection(id: string): ConnectionHandle;
  /** The result of an earlier successful action in this same conversation, if any. */
  actionResult(actionId: string): ToolResult | undefined;
  /** The message of the output rule `text` breaks, if any. */
  brokenRule(text: string): string | undefined;
  /** This client's settings for this agent, e.g. the website its page tools read. */
  settings: JsonObject;
  /**
   * Reserves `usd` of paid third-party spend (e.g. an image) against the client's daily cap, keyed by
   * this action. Returns false when the cap would be passed; the caller must then not spend.
   */
  reserveSpend(usd: number): Promise<boolean>;
  /** Set only inside a background job: lets update_progress and check_back_in reach the job. */
  job?: JobHooks;
  /** Set only on a voice turn: starts (or queues) a background job in this conversation with `task`, once the voice reply has returned. Throws a ToolError when no more can wait. */
  startInBackground?(task: string): void;
  /** Set only on a voice turn: records the change to read back to the caller (a task and, for a tool that needs approval, its tool and exact args) and returns the sentence to say. Throws a ToolError for a tool that cannot be proposed. */
  proposeChange?(change: { task: string; tool?: string; args?: JsonObject }): string;
}

/** What a job's own tools may do to the job. */
export interface JobHooks {
  update(progress: JobProgress): void;
  /** Ends this segment; the job waits `seconds` and then resumes with a runtime note. */
  checkBack(seconds: number, reason: string): void;
}

/** Plain-words progress the agent reports: the step list, how many are done, what it is doing now. */
export interface JobProgress { steps?: string[]; done?: number; current?: string }

export interface ToolDefinition {
  name: string;
  /** Plain-words description of what the tool does while it runs, shown as the job's current step ("Building a preview on Vercel"). Defaults to the humanized name. */
  label?: string;
  description: string;
  parameters: JsonObject;
  /** Client permission required to use this tool. */
  permission: string;
  /** Extra permissions for one bundled action spanning several services. */
  additionalPermissions?: string[];
  effect: "read" | "write";
  /** Explicit opt-in: safe to run alongside other calls from the same model turn. */
  parallelSafe: boolean;
  timeoutMs: number;
  /** Only offered when the conversation has a known person (memory tools). */
  needsUser?: boolean;
  /** Only offered on voice turns (the ElevenLabs endpoint). */
  voiceOnly?: boolean;
  /** Never offered on voice turns (job-only tools such as update_progress). */
  notOnCalls?: boolean;
  execute(context: ToolContext, args: JsonObject): Promise<ToolResult>;
  /** Ask the outside system whether an interrupted write happened. */
  reconcile?(context: ToolContext, args: JsonObject): Promise<Reconciliation>;
  /** Only when a delayed original and a repeat cannot create a second effect. */
  repeatSafe?: boolean;
  /** Late-result auditing requires proof tied to this action, not just the current provider state. */
  reconcileActionProof?: boolean;
  /** Opt-in: next-message recovery also reconciles recorded uncertain writes; absent effects never permit retry. */
  recoverUncertain?: boolean;
  /** Opt-in: a person can confirm no effect occurred before this write may be tried again. */
  checkedRetry?: {
    label(args: JsonObject): string;
    clear(context: ToolContext, args: JsonObject): Promise<void>;
  };
  /**
   * Opt-in, needs `reconcile`: after a successful write, ask the outside system again whether it
   * really happened. "absent" marks the action uncertain, so nobody is told it worked and it is not repeated.
   */
  verifyAfterWrite?: boolean;
  /**
   * Set on write tools a person must approve first (publish a blog, buy a domain). The call then becomes a
   * proposal with this title/summary/preview; execute() runs only after approval, once.
   */
  approval?(context: ToolContext, args: JsonObject): Proposal | Promise<Proposal>;
  /** Optional gate for tools whose new, free work can run without a card. Existing approvals still require a decision. */
  approvalWhen?(args: JsonObject): boolean;
  /**
   * For approval tools that write outside: the exact requests execute() will send, computed when proposing (reads
   * through the desk allowed). After approval the desk sends only these, each once; anything else is refused.
   */
  writePlan?(context: ToolContext, args: JsonObject): Promise<PlannedRequest[]>;
  /**
   * Approval tools only. On a call from one of the client's approved callers who is also an approver, the caller's yes to the
   * read-back approves this change at once, with no card, when this resolves true (it may read through the desk). Only for a
   * change that stays inside the client's own account and reaches nobody else. Absent, false or failing: a person presses
   * Approve, as everywhere else.
   */
  spokenYes?(context: ToolContext, args: JsonObject): Promise<boolean>;
  /**
   * Opt-in: after this tool succeeds (and only then: not while it waits for approval, not when the result says
   * `connected: false`), the runtime saves what the dashboard shows for it. See Snapshot.
   */
  snapshots?: Snapshot[];
}

export interface Proposal {
  /** Action-local inputs that pin the external state used to assemble the approved writes. */
  inputs?: JsonObject;
  title: string;
  summary: string;
  /** What the approver needs to see: the blog text, the domain and its price, the email. */
  preview?: JsonObject;
  /** Trusted arguments captured while proposing, such as the exact preview commit. */
  args?: JsonObject;
  choices?: (ApprovalChoice & { args: JsonObject })[];
  defaultChoice?: string;
}

export interface ApprovalChoice { id: string; label: string; detail?: string; note?: string }

/** What a tool's last good result leaves on the dashboard, stored per client and agent under `kind`. */
export interface Snapshot {
  kind: string;
  /** The stored value for the new result; by default the result data itself. Returning undefined saves nothing. */
  merge?(previous: unknown, data: JsonObject, args: JsonObject): unknown;
}

/** A setting the client's staff may change in the app. Validated by `type` on every save. */
export interface EditableSetting {
  key: string;
  label: string;
  type: "url" | "text" | "number" | "list" | "choice";
  /** For `choice`. */
  choices?: string[];
  /** For `number`: whole numbers within these bounds. */
  min?: number;
  max?: number;
  help: string;
}

/** One thing an agent needs before it is fully useful: a secret the operator sets on the server, or a setting staff edit. */
export interface SetupItem {
  id: string;
  label: string;
  kind: "secret" | "setting";
  connected: boolean;
  /** Env var names (secret) or setting keys (setting) still missing; never values. */
  missing: string[];
  unlocks: string;
  /** The agent works without it; it does not hold back `ready`. */
  optional?: boolean;
}

/** What an agent folder's setup() sees: the client, its effective settings and which env vars are set (names only). */
export interface SetupInput {
  connections?: Connection[];
  clientId: string;
  settings: JsonObject;
  has(envName: string): boolean;
}

export type ActionStatus = "intent" | "awaiting_approval" | "running" | "succeeded" | "failed" | "uncertain";

export interface ActionRecord {
  id: string;
  tool: string;
  args: JsonObject;
  status: ActionStatus;
  result?: ToolResult;
  error?: string;
  checkedBy?: string;
  checkedAt?: number;
  checkOutcome?: "went_through" | "did_not";
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

export interface StuckStep {
  actionId: string;
  agent: string;
  conversationId: string;
  tool: string;
  /** Saved tool target, not inferred from the person's or model's words. */
  project?: string;
  label: string;
  createdAt: number;
  error: string;
  state?: "running" | "needs_answer";
  repeatSafe?: boolean;
}

export interface AdminStuckStep extends StuckStep {
  requestedBy: string | null;
  source: "app" | "phone" | "slack" | "scheduled" | "other";
}

export type TurnEvent =
  | { type: "text"; delta: string; /** Spoken filler (acknowledgement, progress line): never kept for a caller who did not hear it. */ transient?: true }
  /** Voice turns: the words this reply has said so far were a line before a lookup, not the answer. */
  | { type: "lead" }
  | { type: "tool"; name: string; status: "started" | "succeeded" | "failed" | "uncertain" | "awaiting_approval" }
  | { type: "done"; status: TurnStatus; text: string; /** Voice turns: where the wait went (names and times only), for the timing script. */ timing?: JsonObject }
  | { type: "error"; message: string };

export type TurnStatus = "replied" | "stopped" | "duplicate" | "waiting";
