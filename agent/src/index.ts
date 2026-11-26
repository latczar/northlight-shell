import { servicesCallDraft } from "../agents/iris/call-draft";
import { buildHomepagePreview } from "../agents/iris/build";
import { deskClientContext } from "./desk-client";
import { AGENTS, EDITABLE, SETUP } from "../agents";
import { CLIENTS } from "../clients";
import { parseApprovers, verifyAccess } from "./access";
import type { ClientConfig, TurnEvent } from "./contracts";
import { Conversation, type Env } from "./conversation";
import { decideApproval } from "./approvals";
import type { Approval } from "./dashboard";
import { JOB_ACTIVE_MESSAGE } from "./jobs";
import { dashboardPage } from "./dashboard-page";
import { agentSettings, InvalidSetting, validateSettings } from "./settings";
import { isReady } from "./setup";
import { leadIntake, LEADS_TOOL, leadsRoute, sharedLeads } from "./lead-routes";
import { MEDIA_TOOL } from "./media";
import { mediaRoute } from "./media-routes";
import { approvedCallers, phoneStart } from "./phone";
import { localTime, SLACK_USER, slackEvents, slackInteractions } from "./slack";
import { verifyUserPass } from "./user-auth";
import { TOOLS } from "../tools";
import { may } from "./lesson-access";

export { Conversation };
export { Dashboard } from "./dashboard";
export { Learning } from "./learning";
export { Memory } from "./memory";
export { Scheduler } from "./scheduler";
export { Leads } from "./leads";
export { Usage } from "./usage";

const MAX_TEXT = 8_000;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Finds the client whose token matches, in constant time. */
async function authenticate(request: Request, env: Env): Promise<ClientConfig | undefined> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return undefined;
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const presented = await digest(token);
  const seen = new Set<string>();
  let match: ClientConfig | undefined;
  for (const client of CLIENTS) {
    const expected = env[client.tokenEnv];
    if (typeof expected !== "string" || expected.length < 24) continue;
    // Two clients sharing a token would make the match ambiguous.
    if (seen.has(expected)) throw new Error("Every client needs a distinct token.");
    seen.add(expected);
    if (crypto.subtle.timingSafeEqual(presented, await digest(expected))) match = client;
  }
  return match;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Parses the NDJSON event stream returned by the Conversation object. `gone` aborting stops reading, which cancels the stream: the turn behind it runs on. */
async function* events(stream: ReadableStream<Uint8Array>, gone?: AbortSignal): AsyncGenerator<TurnEvent> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const hangUp = () => { reader.cancel().catch(() => {}); };
  gone?.addEventListener("abort", hangUp, { once: true });
  let buffer = "";
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      buffer += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line) yield JSON.parse(line) as TurnEvent;
      }
    }
  } finally {
    gone?.removeEventListener("abort", hangUp);
  }
}

/** `produce` gets a signal that aborts when the client hangs up (its request is cancelled, or a write to it fails). */
function sse(produce: (send: (data: string) => void, gone: AbortSignal) => Promise<void>, request?: Request): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const hangUp = new AbortController();
  request?.signal.addEventListener("abort", () => hangUp.abort(), { once: true });
  const send = (data: string) => { writer.write(encoder.encode(`data: ${data}\n\n`)).catch(() => hangUp.abort()); };
  produce(send, hangUp.signal).finally(() => writer.close().catch(() => {}));
  return new Response(readable, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

function conversation(env: Env, client: ClientConfig, agentId: string, conversationId: string) {
  // Ids are namespaced by client and agent, so one client can never address another's conversation.
  return env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`${client.id}/${agentId}/${conversationId}`));
}

/**
 * Resolves the person from a signed user pass (see src/user-auth.ts). No pass → no person (memory off).
 * A pass that is present but invalid is an error, never silently ignored.
 */
async function personFrom(pass: unknown, env: Env, client: ClientConfig): Promise<{ userId?: string } | Response> {
  if (pass === undefined) return {};
  const secret = client.userSigningEnv ? env[client.userSigningEnv] : undefined;
  if (typeof secret !== "string" || secret.length < 32) return json({ error: "User passes are not enabled for this client." }, 401);
  const userId = typeof pass === "string" ? await verifyUserPass(secret, client.id, pass, Math.floor(Date.now() / 1000)) : undefined;
  return userId ? { userId } : json({ error: "Invalid or expired user pass." }, 401);
}

/**
 * GET /v1/agents/:agent/conversations/:conversation/messages?limit=&before= with header `x-user-pass`: what the person and
 * the agent said, oldest first, `{messages, more}`; pass the first message's `seq` as `before` for older lines.
 * The signed pass is required, so one person cannot read another's conversation.
 */
async function history(request: Request, env: Env, client: ClientConfig, agentId: string, conversationId: string): Promise<Response> {
  const person = await personFrom(request.headers.get("x-user-pass") ?? "", env, client);
  if (person instanceof Response) return person;
  const query = new URL(request.url).searchParams;
  const limit = Math.min(Math.max(Number(query.get("limit") ?? 100) || 100, 1), 500);
  const before = query.has("before") ? Number(query.get("before")) : undefined;
  if (before !== undefined && !(Number.isInteger(before) && before > 0)) return json({ error: "before must be a message seq" }, 400);
  try {
    return json(await conversation(env, client, agentId, conversationId).history(client.id, agentId, person.userId!, limit, before));
  } catch {
    return json({ error: "Not found" }, 404);
  }
}

/**
 * Chat endpoint: POST /v1/agents/:agent/conversations/:conversation/messages {id?, text, userAuth?} → SSE of TurnEvents.
 * `userAuth` is a pass signed by the client's own server; it turns on memory for that person.
 */
async function chat(request: Request, env: Env, client: ClientConfig, agentId: string, conversationId: string): Promise<Response> {
  const body = await request.json().catch(() => null) as { id?: unknown; text?: unknown; userAuth?: unknown } | null;
  const person = await personFrom(body?.userAuth, env, client);
  if (person instanceof Response) return person;
  const { userId } = person;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text || text.length > MAX_TEXT) return json({ error: `text is required (max ${MAX_TEXT} characters)` }, 400);
  if (body?.id !== undefined && (typeof body.id !== "string" || !ID.test(body.id))) return json({ error: "id must match [A-Za-z0-9_.:-]{1,128}" }, 400);
  // A client-supplied id makes retries safe; without one every request is a new message.
  const id = typeof body?.id === "string" ? body.id : crypto.randomUUID();
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = await conversation(env, client, agentId, conversationId).turn({ clientId: client.id, agentId, conversationId, userId, source: "app", input: { id, text } });
  } catch (error) {
    // A job owns the conversation while it runs: this route never runs a second loop beside it.
    return json({ error: error instanceof Error && error.message === JOB_ACTIVE_MESSAGE ? JOB_ACTIVE_MESSAGE : "This conversation id is already used for another person." }, 409);
  }
  return sse(async send => {
    for await (const event of events(stream)) send(JSON.stringify(event));
  });
}

/**
 * POST /v1/agents/:agent/conversations/:conversation/jobs {id, text} with header `x-user-pass`: starts a background job for the
 * message and answers 202 {job} at once; the agent works on, saving its replies as chat messages. The same `id` returns the
 * same job and starts nothing. While a job runs, a new message is queued behind it: 202 {job, queued: true} (at most 10 waiting).
 */
async function startJob(request: Request, env: Env, client: ClientConfig, agentId: string, conversationId: string): Promise<Response> {
  const person = await personFrom(request.headers.get("x-user-pass") ?? "", env, client);
  if (person instanceof Response) return person;
  const body = await request.json().catch(() => null) as { id?: unknown; text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text || text.length > MAX_TEXT) return json({ error: `text is required (max ${MAX_TEXT} characters)` }, 400);
  if (typeof body?.id !== "string" || !ID.test(body.id)) return json({ error: "id is required and must match [A-Za-z0-9_.:-]{1,128}" }, 400);
  try {
    return json(await conversation(env, client, agentId, conversationId).startJob({ clientId: client.id, agentId, conversationId, userId: person.userId, source: "app", input: { id: body.id, text } }), 202);
  } catch (error) {
    const full = error instanceof Error && error.message.startsWith("Too many");
    return json({ error: full ? error.message : "This conversation id or message id is already used for another person or message." }, full ? 429 : 409);
  }
}

/** GET /v1/agents/:agent/conversations/:conversation/job with header `x-user-pass`: {job: null | {id, status, startedAt, updatedAt, finishedAt?, steps, current, queued, error?}}. */
async function jobState(request: Request, env: Env, client: ClientConfig, agentId: string, conversationId: string): Promise<Response> {
  const person = await personFrom(request.headers.get("x-user-pass") ?? "", env, client);
  if (person instanceof Response) return person;
  try {
    return new Response(JSON.stringify(await conversation(env, client, agentId, conversationId).jobState(client.id, agentId, person.userId!)), noStore);
  } catch {
    return json({ error: "Not found" }, 404);
  }
}

/** A bounded, person-owned status projection, never conversation history or action arguments. */
async function callStatus(request: Request, env: Env, client: ClientConfig, agentId: string): Promise<Response> {
  const person = await personFrom(request.headers.get("x-user-pass") ?? "", env, client);
  if (person instanceof Response) return person;
  if (!(await env.STATUS_PERSON_LIMITER.limit({ key: `${client.id}/${person.userId!}` })).success
    || !(await env.STATUS_LIMITER.limit({ key: client.id })).success) return json({ error: "Too many requests" }, 429);
  const ids = await env.DASHBOARD.get(env.DASHBOARD.idFromName(client.id)).recentCallIds(agentId, person.userId!, Date.now() - 24 * 60 * 60_000);
  const calls = await Promise.all(ids.map(async id => {
    try {
      return await conversation(env, client, agentId, id).callState(client.id, agentId, id, person.userId!);
    } catch (error) {
      console.error("call status read failed", error instanceof Error ? error.name : typeof error);
      return null;
    }
  }));
  return new Response(JSON.stringify({ calls: calls.filter(call => call !== null) }), {
    headers: { "content-type": "application/json", "cache-control": "private, no-store" },
  });
}

interface CompletionRequest {
  model?: unknown;
  messages?: { role?: unknown; content?: unknown }[];
  user?: unknown;
  user_id?: unknown;
  elevenlabs_extra_body?: Record<string, unknown>;
}

/**
 * OpenAI-style streaming endpoint for ElevenLabs Custom LLM.
 * `model` names the agent. The conversation id comes from elevenlabs_extra_body.conversation_id,
 * then user_id/user. Only the latest user message is used; history lives here, not in ElevenLabs,
 * and the ElevenLabs system prompt is ignored in favor of the agent template.
 */
async function completions(request: Request, env: Env, client: ClientConfig): Promise<Response> {
  const received = Date.now();
  const body = await request.json().catch(() => null) as CompletionRequest | null;
  const agentId = typeof body?.model === "string" ? body.model : "";
  if (!AGENTS[agentId] || !client.agents.includes(agentId)) return json({ error: { message: "model must be one of this client's agent ids" } }, 404);
  const rawConversation = body?.elevenlabs_extra_body?.conversation_id ?? body?.user_id ?? body?.user;
  if (typeof rawConversation !== "string" || !ID.test(rawConversation)) {
    return json({ error: { message: "A conversation id is required: elevenlabs_extra_body.conversation_id or user_id." } }, 400);
  }
  const person = await personFrom(body?.elevenlabs_extra_body?.user_auth, env, client);
  if (person instanceof Response) return person;
  if (person.userId && !rawConversation.startsWith(`voice-${person.userId}-`)) return json({ error: { message: "The voice conversation id must belong to the signed-in person." } }, 400);
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const userMessages = messages.filter(m => m.role === "user" && typeof m.content === "string");
  const text = String(userMessages.at(-1)?.content ?? "").trim();
  if (!text || text.length > MAX_TEXT) return json({ error: { message: "The last user message is missing or too long." } }, 400);
  // Call-local retry identity: the same words in the same position give the same input id.
  const inputId = `u${userMessages.length}-${(await sha256Hex(text)).slice(0, 32)}`;
  const suppliedSession = body?.elevenlabs_extra_body?.session_id ?? (body?.user_id !== rawConversation ? body?.user_id : undefined);
  const voiceSession = typeof suppliedSession === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(suppliedSession) ? suppliedSession : undefined;
  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    JSON.stringify({ id: completionId, object: "chat.completion.chunk", created, model: agentId, choices: [{ index: 0, delta, finish_reason: finish }] });

  // A client that takes calls only from approved numbers (src/phone.ts). Who is calling comes from the call's own record, saved
  // by phone-start, never from this request: whoever opens the ElevenLabs conversation can set its extra body. A conversation
  // with no such record, or a name that is no longer approved, hears one line (without the names), and nothing runs.
  const recorded = client.phone ? await conversation(env, client, agentId, rawConversation).callCaller() : undefined;
  const caller = recorded !== undefined && Object.values(approvedCallers(env, client)).includes(recorded) ? recorded : undefined;
  if (client.phone && !caller) {
    return sse(async send => {
      send(chunk({ role: "assistant" }));
      send(chunk({ content: "Sorry, this line is private. Goodbye." }));
      send(chunk({}, "stop"));
      send("[DONE]");
    }, request);
  }
  // Approved callers are the team the agent works for (the same memory as in Slack); the call's first words say who and when.
  const userId = client.phone ? SLACK_USER : person.userId;
  const timeZone = String(client.agentSettings?.[agentId]?.timezone ?? "America/Chicago");
  const said = client.phone && userMessages.length === 1 ? `[Phone call from ${caller}, ${localTime(new Date(), timeZone)}]\n${text}` : text;

  let stream: ReadableStream<Uint8Array>;
  try {
    stream = await conversation(env, client, agentId, rawConversation).turn({
      clientId: client.id, agentId, conversationId: rawConversation, userId, source: client.phone ? "phone" : person.userId ? "app" : "other", input: { id: inputId, text: said }, voice: true,
      voiceStart: userMessages.length === 1, ...(voiceSession ? { voiceSession } : {}),
      ...(caller ? { caller } : {}),
    });
  } catch {
    return json({ error: { message: "This conversation id is already used for another person." } }, 409);
  }
  const ready = Date.now() - received;
  // When the caller speaks, ElevenLabs cancels this request: stop reading, so the Conversation keeps what it still has to say for their next one.
  return sse(async (send, gone) => {
    let firstText = -1;
    let turnTiming: unknown;
    send(chunk({ role: "assistant" }));
    for await (const event of events(stream, gone)) {
      if (event.type === "text") {
        if (firstText < 0) firstText = Date.now() - received;
        send(chunk({ content: event.delta }));
      }
      if (event.type === "done") turnTiming = event.timing;
      // Never speak internal errors; give the caller a short spoken fallback.
      if (event.type === "error") send(chunk({ content: "Sorry, I ran into a problem. Could you say that again?" }));
    }
    send(chunk({}, "stop"));
    send("[DONE]");
    // What the caller waits for, from the request arriving: the stream opening, the first words, the end. Ids and times only.
    const timing = { event: "voice_request_timing", client: client.id, agent: agentId, input: inputId, readyMs: ready, firstTextMs: firstText, totalMs: Date.now() - received };
    console.log(JSON.stringify(timing));
    // scripts/voice-timing.mjs asks for both records after [DONE]; ElevenLabs never sends this header, so calls never see them.
    if (request.headers.get("x-voice-timing") === "1") send(JSON.stringify({ timing: { request: timing, turn: turnTiming ?? null } }));
  }, request);
}

/** Dashboard routes for the client's staff, authorised by a signed dashboard pass instead of the client token. */
async function staffDashboard(request: Request, env: Env, url: URL): Promise<Response | undefined> {
  const page = url.pathname.match(/^\/dashboard\/([a-z0-9-]{1,64})$/);
  if (page && request.method === "GET") return CLIENTS.some(c => c.id === page[1]) ? dashboardPage(page[1]) : json({ error: "Not found" }, 404);
  const api = url.pathname.match(/^\/v1\/clients\/([a-z0-9-]{1,64})\/dashboard$/);
  if (!api || request.method !== "GET" || !request.headers.has("x-dashboard-pass")) return undefined;
  const client = CLIENTS.find(c => c.id === api[1]);
  if (client && !(await env.CLIENT_LIMITER.limit({ key: client.id })).success) return json({ error: "Too many requests" }, 429);
  if (!client || !await staffPass(request, env, client)) return json({ error: "Unauthorized" }, 401);
  return dashboardCards(env, client);
}

/** Whether the request carries a valid staff dashboard pass for this client: signed with its dashboard key, purpose "dashboard". */
async function staffPass(request: Request, env: Env, client: ClientConfig): Promise<boolean> {
  const secret = client.dashboardSigningEnv ? env[client.dashboardSigningEnv] : undefined;
  return typeof secret === "string" && secret.length >= 32
    && !!await verifyUserPass(secret, client.id, request.headers.get("x-dashboard-pass") ?? "", Math.floor(Date.now() / 1000), "dashboard");
}

/** Registered conversations wiped per call: each is one Durable Object call, and a Worker request has a subrequest limit. */
const RESET_BATCH = 400;

/**
 * POST /v1/agents/:agent/reset {conversationIds?: string[]} with the client token AND a staff `x-dashboard-pass` (never a
 * user or approver pass). Erases one agent's history for this client: its conversations (the registered ones, up to
 * RESET_BATCH per call, plus any `conversationIds` given, for conversations from before the registry), its dashboard
 * cards, approvals and snapshots, and its R2 records under `<agent>/<client>/`. Settings, the connection log, lessons,
 * memory, usage and schedules stay. While registered conversations remain the answer is `{done: false, remaining}` and
 * only conversations were wiped: call again until `done`.
 */
async function resetAgent(request: Request, env: Env, client: ClientConfig, agentId: string): Promise<Response> {
  if (!await staffPass(request, env, client)) return json({ error: "A valid staff dashboard pass is required." }, 401);
  const body = await request.json().catch(() => null) as { conversationIds?: unknown } | null;
  const extra = body?.conversationIds ?? [];
  if (!Array.isArray(extra) || extra.length > 100 || !extra.every(id => typeof id === "string" && ID.test(id))) {
    return json({ error: "conversationIds must be a list of at most 100 conversation ids" }, 400);
  }
  const dashboard = env.DASHBOARD.get(env.DASHBOARD.idFromName(client.id));
  const ids = [...new Set([...await dashboard.conversationIds(agentId, RESET_BATCH), ...extra as string[]])];
  let conversations = 0;
  for (let i = 0; i < ids.length; i += 20) {
    const wiped = await Promise.all(ids.slice(i, i + 20).map(id => conversation(env, client, agentId, id).wipe(client.id, agentId)));
    conversations += wiped.filter(Boolean).length;
  }
  const remaining = await dashboard.forgetConversations(agentId, ids);
  if (remaining) return json({ agent: agentId, done: false, conversations, remaining });

  const removed = await dashboard.resetAgent(agentId);
  let records = 0;
  let cursor: string | undefined;
  do {
    const listed = await env.IMAGES.list({ prefix: `${agentId}/${client.id}/`, cursor });
    if (listed.objects.length) await env.IMAGES.delete(listed.objects.map(object => object.key));
    records += listed.objects.length;
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return json({ agent: agentId, done: true, conversations, ...removed, records });
}

async function dashboardCards(env: Env, client: ClientConfig): Promise<Response> {
  const body = await env.DASHBOARD.get(env.DASHBOARD.idFromName(client.id)).list(100, client.id);
  return new Response(body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

const ACTIVE_MS = 24 * 60 * 60 * 1000;
/** GET /v1/agents/:agent/{setup,data,settings}, and PUT for settings. */
const PANEL = /^\/v1\/agents\/([a-z0-9-]+)\/(setup|data|settings)$/;

/** GET /v1/agents: the client's agents with status, items to review, last activity and newest card. */
async function agentsSummary(env: Env, client: ClientConfig): Promise<Response> {
  const summary = await env.DASHBOARD.get(env.DASHBOARD.idFromName(client.id)).summary(client.agents);
  const now = Date.now();
  return json({
    agents: client.agents.filter(id => AGENTS[id]).map(id => {
      const { toReview, latest } = summary[id];
      const status = toReview > 0 ? "needs_approval" : latest && now - latest.at < ACTIVE_MS ? "active" : "idle";
      return { id, name: AGENTS[id].name, role: AGENTS[id].role, status, toReview, lastActive: latest?.at ?? null, latest };
    }),
  });
}

/**
 * GET /v1/approvals/:id, or POST {decision: "approve"|"decline", reason?} with an approver or admin pass.
 * With access sync, only an admin or the requester with this agent's approve right can decide.
 * Clients without access sync keep their static approver rule.
 * A decision is recorded once; repeating it returns the stored outcome and never runs the action twice.
 * The opposite decision on a decided approval is refused with 409.
 */
async function approvalRoute(request: Request, env: Env, client: ClientConfig, id: string): Promise<Response> {
  const dashboard = env.DASHBOARD.get(env.DASHBOARD.idFromName(client.id));
  const reply = (text: string | undefined, status = 200) => text
    ? new Response(text, { status, headers: { "content-type": "application/json", "cache-control": "no-store" } })
    : json({ error: "Not found" }, 404);
  if (request.method === "GET") return reply(await dashboard.approvalJson(id, client.id));

  const adminPerson = client.accessSigningEnv && request.headers.has("x-admin-pass") ? await admin(request, env, client) : undefined;
  if (adminPerson instanceof Response && !request.headers.has("x-approver-pass")) return adminPerson;
  const isAdmin = typeof adminPerson === "string";
  const decidedBy = isAdmin ? adminPerson : await approver(request, env, client);
  if (decidedBy instanceof Response) return decidedBy;

  const body = await request.json().catch(() => null) as { decision?: unknown; reason?: unknown; choice?: unknown } | null;
  if (body?.decision !== "approve" && body?.decision !== "decline" && body?.decision !== "revise") return json({ error: 'decision must be "approve", "decline", or "revise"' }, 400);
  const approve = body.decision === "approve";
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  const existing = await dashboard.approvalJson(id, client.id);
  if (!existing) return json({ error: "Not found" }, 404);
  const approval = JSON.parse(existing) as Approval;
  if (!isAdmin) {
    const allowed = (!client.accessSigningEnv || approval.requestedBy === decidedBy) && await may(env, client, "approve", decidedBy, approval.agent);
    if (!allowed) return json({ error: client.accessSigningEnv
      ? "Only the person who asked, or an admin, can decide this request."
      : "This person may not approve for this agent." }, 403);
  }

  if (body.decision === "revise") {
    const revise = AGENTS[approval.agent]?.reviseApproval;
    if (!revise) return json({ error: "This agent does not support revisions." }, 409);
    const revision = await revise(env, client, approval);
    return reply(revision.body, revision.status);
  }
  const decided = await decideApproval(env, client, id, approve, decidedBy, reason, undefined, typeof body.choice === "string" ? body.choice : undefined);
  return reply(decided.body, decided.status);
}


/**
 * The person behind a valid approver pass, or the error response. The pass is signed by the client's server with its
 * approver key (purpose "approve"); whether the person may decide the thing at hand is checked with `may`.
 */
async function approver(request: Request, env: Env, client: ClientConfig): Promise<string | Response> {
  const secret = client.approverSigningEnv ? env[client.approverSigningEnv] : undefined;
  if (typeof secret !== "string" || secret.length < 32) return json({ error: "Approvals are not enabled for this client." }, 403);
  const person = await verifyUserPass(secret, client.id, request.headers.get("x-approver-pass") ?? "", Math.floor(Date.now() / 1000), "approve");
  return person ?? json({ error: "A valid approver pass is required." }, 401);
}

async function admin(request: Request, env: Env, client: ClientConfig): Promise<string | Response> {
  const secret = client.approverSigningEnv ? env[client.approverSigningEnv] : undefined;
  if (typeof secret !== "string" || secret.length < 32) return json({ error: "Admin passes are not enabled for this client." }, 403);
  const person = await verifyUserPass(secret, client.id, request.headers.get("x-admin-pass") ?? "", Math.floor(Date.now() / 1000), "admin");
  return person ?? json({ error: "A valid admin pass is required." }, 401);
}

async function stuckRoute(request: Request, env: Env, client: ClientConfig, agentId: string, conversationId: string, actionId?: string): Promise<Response> {
  const adminPerson = request.method === "POST" && request.headers.has("x-admin-pass") ? await admin(request, env, client) : undefined;
  if (adminPerson instanceof Response && !request.headers.has("x-user-pass")) return adminPerson;
  const isAdmin = typeof adminPerson === "string";
  const person = isAdmin ? adminPerson : await personFrom(request.headers.get("x-user-pass") ?? "", env, client);
  if (person instanceof Response) return person;
  const userId = typeof person === "string" ? person : person.userId!;
  const stub = conversation(env, client, agentId, conversationId);
  if (request.method === "GET" && !actionId) {
    try { return json(await stub.stuck(client.id, agentId, conversationId, userId)); }
    catch { return json({ error: "Not found" }, 404); }
  }
  if (request.method !== "POST" || !actionId) return json({ error: "Not found" }, 404);
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !("outcome" in body) || body.outcome !== "not_created") {
    return json({ error: 'body must be exactly {"outcome":"not_created"}' }, 400);
  }
  const result = await stub.checkStuck(client.id, agentId, conversationId, actionId, userId, isAdmin);
  return json(result.body, result.status);
}

async function adminStuck(env: Env, client: ClientConfig, ctx: ExecutionContext): Promise<Response> {
  const dashboard = env.DASHBOARD.get(env.DASHBOARD.idFromName(client.id));
  const agents = client.agents.filter(id => AGENTS[id]?.tools.some(name => TOOLS[name]?.checkedRetry));
  const claim = await dashboard.beginStuckReconcile(agents);
  if (claim) {
    ctx.waitUntil((async () => {
      const results = [];
      for (const page of claim.pages) {
        let failed = false;
        for (let i = 0; i < page.ids.length; i += 20) {
          await Promise.all(page.ids.slice(i, i + 20).map(async id => {
            try {
              const steps = await conversation(env, client, page.agent, id).currentStuck(client.id, page.agent, id);
              await dashboard.replaceStuck(page.agent, id, steps);
            } catch (error) {
              failed = true;
              console.error("stuck reconcile failed", error instanceof Error ? error.name : typeof error);
            }
          }));
        }
        results.push({ ...page, failed });
      }
      await dashboard.finishStuckReconcile(claim.id, agents, results);
    })().catch(error => console.error("stuck reconcile failed", error instanceof Error ? error.name : typeof error)));
  }
  return json(await dashboard.stuck());
}

/**
 * PUT /v1/access/approvers {version, approvers: {agent: [userId]}, managers: {agent: [userId]}}: the full approver and
 * manager state for this client, pushed by the agents app. Besides the client token it needs `x-access-timestamp` and
 * `x-access-signature` (see src/access.ts). An older `version` than the stored one is ignored: 200 {applied: false}.
 */
async function accessApprovers(request: Request, env: Env, client: ClientConfig): Promise<Response> {
  // Only clients whose approvers come from the agents app have this route.
  if (!client.accessSigningEnv) return json({ error: "Not found" }, 404);
  const secret = env[client.accessSigningEnv];
  if (typeof secret !== "string" || secret.length < 32) return json({ error: "Access sync is not enabled for this client." }, 403);
  const raw = await request.text();
  const signed = await verifyAccess(secret, client.id, request.headers.get("x-access-timestamp") ?? "", request.headers.get("x-access-signature") ?? "", raw, Math.floor(Date.now() / 1000));
  if (!signed) return json({ error: "A valid access signature is required." }, 401);
  const parsed = parseApprovers(raw, client.agents);
  if (typeof parsed === "string") return json({ error: parsed }, 400);
  return json({ applied: await env.DASHBOARD.get(env.DASHBOARD.idFromName(client.id)).setApprovers(parsed.version, parsed.approvers, parsed.managers) });
}

const noStore = { headers: { "content-type": "application/json", "cache-control": "no-store" } };

/** The editable settings of an agent with their effective values; nothing else, so internal settings never leave. */
async function settingsView(env: Env, client: ClientConfig, agentId: string): Promise<Response> {
  const editable = EDITABLE[agentId];
  const effective = await agentSettings(env, client, agentId);
  return json({ agent: agentId, settings: Object.fromEntries(editable.map(({ key }) => [key, effective[key] ?? null])), editable });
}

/**
 * GET /v1/agents/:agent/setup (what the agent still needs, names only), GET /v1/agents/:agent/data (the dashboard
 * snapshots) and GET or PUT /v1/agents/:agent/settings. PUT {settings: {key: value}} needs the approver pass of a person on the agent's manager list (never just an approver) and only
 * accepts the agent's editable keys, validated by type; the answer is the GET shape.
 */
async function agentPanel(request: Request, env: Env, client: ClientConfig, agentId: string, panel: string): Promise<Response> {
  if (panel === "settings" && request.method === "PUT") {
    const person = await approver(request, env, client);
    if (person instanceof Response) return person;
    if (!await may(env, client, "manage", person, agentId)) return json({ error: "This person may not change this agent's settings." }, 403);
    const body = await request.json().catch(() => null) as { settings?: unknown } | null;
    try {
      const changes = validateSettings(EDITABLE[agentId], body?.settings);
      await env.DASHBOARD.get(env.DASHBOARD.idFromName(client.id)).saveSettings(agentId, JSON.stringify(changes));
    } catch (error) {
      if (!(error instanceof InvalidSetting)) throw error;
      return json({ error: error.message, ...(error.field ? { field: error.field } : {}) }, 400);
    }
    return settingsView(env, client, agentId);
  }
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  if (panel === "settings") return settingsView(env, client, agentId);
  if (panel === "data") {
    const dashboard = env.DASHBOARD.get(env.DASHBOARD.idFromName(client.id));
    return new Response(await dashboard.snapshots(agentId), noStore);
  }
  // Connection env names come from the desk (names only); a desk that cannot answer reads as nothing set up.
  const presence: Record<string, boolean> = await env.DESK.presence(client.id, agentId).catch(() => ({}));
  const items = SETUP[agentId]({ clientId: client.id, settings: await agentSettings(env, client, agentId), has: name => presence[name] === true, connections: client.connections?.filter(connection => connection.agents.includes(agentId)) });
  return json({ agent: agentId, ready: isReady(items), items });
}

/**
 * GET /v1/agents/:agent/lessons: proposed then active lessons for the agent and client-wide.
 * POST /v1/lessons/:id {decision: "approve"|"remove"} with header `x-approver-pass`: the person must be on the lesson's agent's
 * approver list (a client-wide lesson: on any agent's list).
 */
async function lessonsRoute(request: Request, env: Env, client: ClientConfig, url: URL): Promise<Response | undefined> {
  const learning = env.LEARNING.get(env.LEARNING.idFromName(client.id));
  const list = url.pathname.match(/^\/v1\/agents\/([a-z0-9-]+)\/lessons$/);
  if (list && request.method === "GET") {
    if (!AGENTS[list[1]] || !client.agents.includes(list[1])) return json({ error: "Not found" }, 404);
    return new Response(JSON.stringify({ lessons: await learning.list(list[1]) }), noStore);
  }
  const one = url.pathname.match(/^\/v1\/lessons\/([A-Za-z0-9_.:-]{1,128})$/);
  if (!one || request.method !== "POST") return undefined;
  const decidedBy = await approver(request, env, client);
  if (decidedBy instanceof Response) return decidedBy;
  const body = await request.json().catch(() => null) as { decision?: unknown } | null;
  if (body?.decision !== "approve" && body?.decision !== "remove") return json({ error: 'decision must be "approve" or "remove"' }, 400);
  const agent = await learning.agentOf(one[1]);
  if (agent === undefined) return json({ error: "Not found" }, 404);
  if (!await may(env, client, "approve", decidedBy, agent)) return json({ error: "This person may not approve for this agent." }, 403);
  const result = await learning.decide(one[1], body.decision, decidedBy);
  return result.ok ? new Response(JSON.stringify({ lesson: result.lesson }), noStore) : json({ error: result.error }, result.status);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true });
    const library = url.pathname === "/v1/media" || url.pathname.startsWith("/v1/media/");
    const leadsApi = url.pathname === "/v1/leads" || url.pathname.startsWith("/v1/leads/");
    const calls = request.method === "GET" ? url.pathname.match(/^\/v1\/agents\/([a-z0-9-]+)\/calls$/) : null;
    const folderDelete = request.method === "DELETE" && url.pathname === "/v1/media/folders";
    const mediaDelete = request.method === "DELETE" && url.pathname === "/v1/media" || folderDelete;
    const shareDelete = request.method === "DELETE" && url.pathname === "/v1/leads/shares";
    const accessPush = request.method === "PUT" && url.pathname === "/v1/access/approvers";
    if (request.method !== "POST" && request.method !== "GET" && !mediaDelete && !shareDelete && !accessPush && !(request.method === "PUT" && PANEL.test(url.pathname))) return json({ error: "Method not allowed" }, 405);

    // A site's own lead route posts with that site's key, not a client token (src/lead-routes.ts).
    const intake = url.pathname.match(/^\/v1\/leads\/in\/([a-z0-9-]{1,64})\/([a-z0-9-]{1,63})$/);
    if (intake) return request.method === "POST" ? leadIntake(request, env, intake[1], intake[2]) : json({ error: "Method not allowed" }, 405);

    // Slack signs its own requests (no client token): events and the Approve / Decline buttons.
    const slack = url.pathname.match(/^\/v1\/slack\/([a-z0-9-]{1,64})\/(events|interactions)$/);
    if (slack && request.method === "POST") {
      const client = CLIENTS.find(c => c.id === slack[1] && c.slack);
      if (!client) return json({ error: "Not found" }, 404);
      if (!(await env.CLIENT_LIMITER.limit({ key: client.id })).success) return json({ error: "Too many requests" }, 429);
      const deps = { desk: env.DESK };
      const handled = slack[2] === "events"
        ? await slackEvents(request, env, client, deps)
        : await slackInteractions(request, env, client, deps, (approval, decision) =>
          conversation(env, client, approval.agent, approval.conversationId).queueSlackDecision(client.id, approval.agent, decision));
      if (handled.work) ctx.waitUntil(handled.work.catch(error => console.error("slack work failed", error instanceof Error ? error.message.slice(0, 120) : typeof error)));
      return handled.response;
    }

    const staff = await staffDashboard(request, env, url);
    if (staff) return staff;

    const client = await authenticate(request, env);
    if (!client) return json({ error: "Unauthorized" }, 401);
    if (calls) return AGENTS[calls[1]] && client.agents.includes(calls[1]) ? callStatus(request, env, client, calls[1]) : json({ error: "Not found" }, 404);
    // Per client, so a leaked token or a stuck script cannot run up costs; 429 tells callers to slow down. The media
    // library has its own allowance: an upload is two requests a file, and a folder of photos must not use up the chats' one.
    // So do the leads, and within them the share links their own: a link is read by whoever holds it (or guesses at one),
    // which must never slow the chats down nor keep staff from their leads or from turning that link off.
    const sharedLink = url.pathname === "/v1/leads/shared";
    const allowance = library ? env.MEDIA_LIMITER : leadsApi ? env.LEADS_LIMITER : env.CLIENT_LIMITER;
    if (!(await allowance.limit({ key: sharedLink ? `${client.id}/shared` : client.id })).success) return json({ error: "Too many requests" }, 429);

    const callDraft = /^\/v1\/agents\/iris\/calls\/(conv_[A-Za-z0-9_-]{1,120})\/services-draft$/.exec(url.pathname);
    if (callDraft) {
      if (!client.agents.includes("iris") || !client.permissions.includes("website.copy.review")) return json({error:"Not found"}, 404);
      const person = await personFrom(request.headers.get("x-user-pass") ?? "", env, client);
      if (person instanceof Response) return person;
      if (!person.userId || !await may(env, client, "manage", person.userId, "iris")) return json({error:"Website manager access required."}, 403);
      return servicesCallDraft(request, env, client, person.userId, callDraft[1]);
    }

    if (request.method === "POST" && url.pathname === "/v1/agents/iris/homepage-preview") {
      if (!client.agents.includes("iris") || !client.permissions.includes("website.preview")) return json({ error: "Not found" }, 404);
      const person = await personFrom(request.headers.get("x-user-pass") ?? "", env, client);
      if (person instanceof Response) return person;
      if (!person.userId || !await may(env, client, "manage", person.userId, "iris")) return json({ error: "Website manager access required." }, 403);
      const body = await request.json().catch(() => null) as { first?: unknown; second?: unknown } | null;
      if (!body || typeof body.first !== "string" || typeof body.second !== "string") return json({ error: "Provide both heading lines." }, 400);
      const context = deskClientContext({ desk: env.DESK, state: { presence: {}, ids: {} }, client, agentId: "iris",
        toolName: "build_homepage_preview", actionId: crypto.randomUUID(), signal: AbortSignal.timeout(60000) });
      try {
        const settings = await agentSettings(env, client, "iris");
        return json(await buildHomepagePreview(context.connection(String(settings.previewConnection)), body.first, body.second, settings));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Preview build failed." }, 422);
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") return completions(request, env, client);
    if (request.method === "POST" && url.pathname === "/v1/voice/phone-start") return phoneStart(request, env, client, ctx);
    if (request.method === "GET" && url.pathname === "/v1/dashboard") return dashboardCards(env, client);
    if (request.method === "GET" && url.pathname === "/v1/agents") return agentsSummary(env, client);
    if (request.method === "GET" && url.pathname === "/v1/stuck") {
      const person = await admin(request, env, client);
      if (person instanceof Response) return person;
      return adminStuck(env, client, ctx);
    }
    // The media library: the client token plus a signed-in person's pass, like the conversation history.
    if (library) {
      const person = await personFrom(request.headers.get("x-user-pass") ?? "", env, client);
      if (person instanceof Response) return person;
      if (folderDelete) {
        // A whole folder cannot be brought back, so it takes more than being signed in: the same person's approver pass,
        // and a place on the approver list of an agent that works from the library.
        const approving = await approver(request, env, client);
        if (approving instanceof Response) return approving;
        const agents = client.agents.filter(id => AGENTS[id]?.tools.includes(MEDIA_TOOL));
        const allowed = approving === person.userId && (await Promise.all(agents.map(agent => may(env, client, "approve", approving, agent)))).some(Boolean);
        if (!allowed) return json({ error: "Only people who can approve for an agent that uses the media library can delete a folder." }, 403);
      }
      return mediaRoute(request, env, client, url, person.userId!, folderDelete);
    }
    if (leadsApi) {
      // A share link's page: the link's secret is the permission, so no person is named.
      if (sharedLink) return request.method === "POST" ? sharedLeads(request, env, client) : json({ error: "Method not allowed" }, 405);
      const person = await personFrom(request.headers.get("x-user-pass") ?? "", env, client);
      if (person instanceof Response) return person;
      const leadChange = ["/v1/leads/add", "/v1/leads/delete", "/v1/leads/merge"].includes(url.pathname);
      if (url.pathname === "/v1/leads/shares" && request.method !== "GET" || leadChange && request.method === "POST") {
        // Writes to people's leads take the same person's approver pass and site-building approver permission as shares.
        const approving = await approver(request, env, client);
        if (approving instanceof Response) return leadChange ? json({ error: "An approver pass is required to change leads." }, 403) : approving;
        const agents = client.agents.filter(id => AGENTS[id]?.tools.includes(LEADS_TOOL));
        const allowed = approving === person.userId && (await Promise.all(agents.map(agent => may(env, client, "approve", approving, agent)))).some(Boolean);
        if (!allowed) return json({ error: leadChange ? "Only people who can approve for an agent that builds sites can change leads." : "Only people who can approve for an agent that builds sites can share leads." }, 403);
      }
      return leadsRoute(request, env, client, url, person.userId!);
    }
    if (url.pathname === "/v1/approvals" && request.method === "GET") {
      const status = url.searchParams.get("status") ?? undefined;
      const body = await env.DASHBOARD.get(env.DASHBOARD.idFromName(client.id)).approvals(status, client.id);
      return new Response(body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    if (accessPush) return accessApprovers(request, env, client);
    const approval = url.pathname.match(/^\/v1\/approvals\/([A-Za-z0-9_.:-]{1,128})$/);
    if (approval) return approvalRoute(request, env, client, approval[1]);
    const lessons = await lessonsRoute(request, env, client, url);
    if (lessons) return lessons;

    // Front desk log: every outside request this client's agents sent or were refused (no credentials).
    if (request.method === "GET" && url.pathname === "/v1/connections/log") {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
      return new Response(await env.DASHBOARD.get(env.DASHBOARD.idFromName(client.id)).requestLog(limit), noStore);
    }

    // Schedules: list runs, or run one job now (for testing) outside its timetable.
    const scheduler = env.SCHEDULER.get(env.SCHEDULER.idFromName(client.id));
    if (request.method === "GET" && url.pathname === "/v1/schedules") {
      return json({ schedules: client.schedules ?? [], nextAlarm: await scheduler.ensure(client.id), runs: await scheduler.runs() });
    }
    const runNow = url.pathname.match(/^\/v1\/schedules\/([A-Za-z0-9_-]{1,64})\/run$/);
    if (request.method === "POST" && runNow) {
      if (!client.schedules?.some(s => s.id === runNow[1])) return json({ error: "Not found" }, 404);
      return json({ finished: await scheduler.runNow(client.id, runNow[1]) });
    }

    // Image drafts: only the client that created them can download them.
    const image = url.pathname.match(/^\/v1\/images\/([A-Za-z0-9_.:-]{1,128})$/);
    if (request.method === "GET" && image) {
      const object = await env.IMAGES.get(`images/${client.id}/${image[1]}.png`);
      if (!object) return json({ error: "Not found" }, 404);
      return new Response(object.body, { headers: { "content-type": "image/png", "cache-control": "private, no-store" } });
    }

    const reset = url.pathname.match(/^\/v1\/agents\/([a-z0-9-]+)\/reset$/);
    if (reset && request.method === "POST") {
      return AGENTS[reset[1]] && client.agents.includes(reset[1]) ? resetAgent(request, env, client, reset[1]) : json({ error: "Not found" }, 404);
    }

    const panel = url.pathname.match(PANEL);
    if (panel) return AGENTS[panel[1]] && client.agents.includes(panel[1]) ? agentPanel(request, env, client, panel[1], panel[2]) : json({ error: "Not found" }, 404);
    const stuck = url.pathname.match(/^\/v1\/agents\/([a-z0-9-]+)\/conversations\/([A-Za-z0-9_.:-]{1,128})\/stuck(?:\/([A-Za-z0-9_.:-]{1,128}))?$/);
    if (stuck) return AGENTS[stuck[1]] && client.agents.includes(stuck[1])
      ? stuckRoute(request, env, client, stuck[1], stuck[2], stuck[3]) : json({ error: "Not found" }, 404);

    const match = url.pathname.match(/^\/v1\/agents\/([a-z0-9-]+)\/conversations\/([A-Za-z0-9_.:-]{1,128})(\/messages|\/jobs?)?$/);
    // Unknown and other clients' agents look the same: not found.
    if (!match || !AGENTS[match[1]] || !client.agents.includes(match[1])) return json({ error: "Not found" }, 404);
    const [, agentId, conversationId, sub] = match;
    if (request.method === "POST" && sub === "/messages") return chat(request, env, client, agentId, conversationId);
    if (request.method === "POST" && sub === "/jobs") return startJob(request, env, client, agentId, conversationId);
    if (request.method === "GET" && sub === "/job") return jobState(request, env, client, agentId, conversationId);
    if (request.method === "GET" && !sub) return json(await conversation(env, client, agentId, conversationId).state(client.id, agentId));
    if (request.method === "GET" && sub === "/messages") return history(request, env, client, agentId, conversationId);
    return json({ error: "Not found" }, 404);
  },

  /** Hourly: make sure every client's scheduler has its next alarm set (after deploys and config changes). */
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(Promise.all(CLIENTS.filter(c => c.schedules?.length)
      .map(c => env.SCHEDULER.get(env.SCHEDULER.idFromName(c.id)).ensure(c.id))));
  },
} satisfies ExportedHandler<Env>;
