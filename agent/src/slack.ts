import type { ClientConfig, ConnectionHandle, SlackConfig } from "./contracts";
import type { Env } from "./conversation";
import type { DeskApi } from "./desk-api";
import { deskClientContext, loadDeskState } from "./desk-client";
import type { DecisionReply } from "./approvals";

// Slack for an agent people talk to in Slack (ClientConfig.slack). Two signed routes, no client token:
// - events: every message in a channel the app was added to, and its DMs. The agent acts only for the client's `people`,
//   matched by their Slack account's email; a channel message that is not for the agent gets the reply NO_REPLY, which is
//   never posted. Each message starts (or queues) a background job in the thread's conversation; the job's replies and its
//   approval cards are posted back to the thread by the Conversation (deliverSlack).
// - interactions: the Approve / Decline buttons on an approval card. Only a person on the client's `approvers` list counts.
// Slack's bot token stays in the desk: posting and lookups go through the `slack_reply` and `slack` connections.

/** A channel reply that is not for the agent. Never posted. */
export const NO_REPLY = "NO_REPLY";
/** Who the conversation belongs to: the team, so a thread several people reply in stays one conversation. */
export const SLACK_USER = "team";
/** Requests older than this are refused (Slack's replay guidance). */
const MAX_AGE_S = 5 * 60;
const MAX_TEXT = 7_500;
const PERSON_TTL_MS = 10 * 60_000;
const APPROVE = "agent_approve";
const DECLINE = "agent_decline";

/** Where the agent's replies go: a channel, and the thread in it (absent in a DM). */
export interface SlackTarget { channel: string; threadTs?: string }

export type SlackPerson = SlackConfig["people"][number];

/** The body when the request carries a valid Slack signature made in the last five minutes, else undefined. */
export async function verifySlack(request: Request, secret: string, now = Date.now()): Promise<string | undefined> {
  const stamp = request.headers.get("x-slack-request-timestamp") ?? "";
  const signature = request.headers.get("x-slack-signature") ?? "";
  if (!/^\d{1,12}$/.test(stamp) || Math.abs(now / 1000 - Number(stamp)) > MAX_AGE_S || !/^v0=[0-9a-f]{64}$/.test(signature)) return undefined;
  const body = await request.text();
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${stamp}:${body}`)));
  const expected = new TextEncoder().encode(`v0=${[...mac].map(b => b.toString(16).padStart(2, "0")).join("")}`);
  const presented = new TextEncoder().encode(signature);
  return expected.length === presented.length && crypto.subtle.timingSafeEqual(expected, presented) ? body : undefined;
}

/** Fails at startup on a Slack block that names an agent the client lacks, a non-env secret name, or a person who is not an approver. */
export function validateSlack(client: ClientConfig): void {
  const slack = client.slack;
  if (!slack) return;
  if (!client.agents.includes(slack.agent)) throw new Error(`Client ${client.id} answers Slack with ${slack.agent}, who is not one of its agents.`);
  if (!/^[A-Z][A-Z0-9_]*$/.test(slack.signingSecretEnv)) throw new Error(`Client ${client.id} must name its Slack signing secret's env var.`);
  for (const person of slack.people) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(person.id) || !person.email.includes("@")) throw new Error(`Client ${client.id} has a bad Slack person ${person.id}.`);
    if (!client.approvers?.includes(person.id)) throw new Error(`Slack person ${person.id} of ${client.id} must be one of its approvers.`);
  }
  if (slack.channel !== undefined && !/^[CG][A-Z0-9]{8,20}$/.test(slack.channel)) throw new Error(`Client ${client.id} has a bad Slack channel id.`);
}

/** The desk, for requests the runtime itself makes (lookups and posts, not a tool's). */
async function connection(desk: DeskApi, client: ClientConfig, id: "slack" | "slack_reply", actionId: string): Promise<ConnectionHandle> {
  const agentId = client.slack!.agent;
  const state = await loadDeskState(desk, client.id, agentId);
  return deskClientContext({ desk, state, client, agentId, toolName: "slack_runtime", actionId: actionId.slice(0, 200), signal: AbortSignal.timeout(15_000) }).connection(id);
}

/** Posts one message; false when Slack or the desk refused it (logged, never thrown: delivery must not break the job). */
export async function postSlack(desk: DeskApi, client: ClientConfig, target: SlackTarget, message: { text: string; blocks?: unknown[] }, actionId: string): Promise<boolean> {
  try {
    const handle = await connection(desk, client, "slack_reply", actionId);
    const response = await handle.fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: target.channel, ...(target.threadTs ? { thread_ts: target.threadTs } : {}), text: message.text, ...(message.blocks ? { blocks: message.blocks } : {}), unfurl_links: false }),
    });
    const body = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    if (!body?.ok) console.error("slack post failed", response.status, body?.error ?? "no body");
    return body?.ok === true;
  } catch (error) {
    console.error("slack post failed", error instanceof Error ? error.message.slice(0, 120) : typeof error);
    return false;
  }
}

/** Adds the 👀 reaction to a message; failures are logged only (the desk allows this one reaction, nothing else). */
export async function reactSeen(desk: DeskApi, client: ClientConfig, channel: string, ts: string): Promise<void> {
  try {
    const handle = await connection(desk, client, "slack_reply", `slack-seen-${channel}-${ts}`);
    const response = await handle.fetch("https://slack.com/api/reactions.add", {
      method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify({ channel, timestamp: ts, name: "eyes" }),
    });
    const body = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    if (!body?.ok && body?.error !== "already_reacted") console.error("slack reaction failed", response.status, body?.error ?? "no body");
  } catch (error) {
    console.error("slack reaction failed", error instanceof Error ? error.message.slice(0, 120) : typeof error);
  }
}

// Slack user id -> person (or null: not one of the client's people), per isolate.
const people = new Map<string, { person: SlackPerson | null; until: number }>();

/**
 * The client's person behind a Slack user: the account must belong to this workspace, be a person (not a bot or deleted),
 * and its email must be one of `people`. null: someone else (cached). undefined: Slack could not be asked (not cached), so
 * a person is never told "I can't help you" because of a hiccup.
 */
export async function slackPerson(desk: DeskApi, client: ClientConfig, userId: string, teamId: string): Promise<SlackPerson | null | undefined> {
  const key = `${client.id}/${teamId}/${userId}`;
  const hit = people.get(key);
  if (hit && hit.until > Date.now()) return hit.person;
  let person: SlackPerson | null = null;
  try {
    const handle = await connection(desk, client, "slack", `slack-user-${userId}`);
    const response = await handle.fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`);
    const body = await response.json() as { ok?: boolean; error?: string; user?: { team_id?: string; deleted?: boolean; is_bot?: boolean; profile?: { email?: string } } };
    if (!body.ok && body.error !== "user_not_found") throw new Error(`users.info: ${body.error ?? `HTTP ${response.status}`}`);
    const user = body.ok ? body.user : undefined;
    const email = user?.profile?.email?.toLowerCase();
    if (user && user.team_id === teamId && !user.deleted && !user.is_bot && email) person = client.slack!.people.find(p => p.email.toLowerCase() === email) ?? null;
  } catch (error) {
    console.error("slack user lookup failed", error instanceof Error ? error.message.slice(0, 120) : typeof error);
    return undefined;
  }
  people.set(key, { person, until: Date.now() + PERSON_TTL_MS });
  return person;
}

interface SlackFile { id?: string; name?: string; mimetype?: string }
interface SlackMessage {
  type?: string; subtype?: string; user?: string; bot_id?: string; hidden?: boolean; text?: string; channel?: string;
  channel_type?: string; ts?: string; thread_ts?: string; files?: SlackFile[];
}
interface SlackEnvelope { type?: string; team_id?: string; challenge?: string; event?: SlackMessage; authorizations?: { user_id?: string }[] }

/** Seams for tests: the desk and the clock. */
export interface SlackDeps { desk: DeskApi; now?: () => Date }

const ID = /^[A-Za-z0-9.]{1,40}$/;

/** The person's local time for the message header, in the agent's time zone. */
export function localTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(date);
}

/**
 * POST /v1/slack/<client>/events. Answers Slack at once (it retries after 3 seconds); the message is handled in the
 * background. Returns the work as a promise so the caller hands it to `waitUntil`.
 */
export async function slackEvents(request: Request, env: Env, client: ClientConfig, deps: SlackDeps): Promise<{ response: Response; work?: Promise<void> }> {
  const secret = env[client.slack!.signingSecretEnv];
  if (typeof secret !== "string" || secret.length < 16) return { response: Response.json({ error: "Slack is not set up for this client." }, { status: 503 }) };
  const raw = await verifySlack(request, secret, (deps.now?.() ?? new Date()).getTime());
  if (raw === undefined) return { response: Response.json({ error: "Invalid Slack signature." }, { status: 401 }) };
  let envelope: SlackEnvelope;
  try { envelope = JSON.parse(raw) as SlackEnvelope; } catch { return { response: Response.json({ error: "Bad request" }, { status: 400 }) }; }
  if (envelope.type === "url_verification") return { response: Response.json({ challenge: envelope.challenge ?? "" }) };
  if (envelope.type !== "event_callback" || !envelope.event) return { response: new Response(null, { status: 200 }) };
  return { response: new Response(null, { status: 200 }), work: handleMessage(env, client, envelope, deps) };
}

async function handleMessage(env: Env, client: ClientConfig, envelope: SlackEnvelope, deps: SlackDeps): Promise<void> {
  const event = envelope.event!;
  // Edits, deletions, joins and bot posts (the agent's own included) are not messages to answer.
  if (event.type !== "message" || event.bot_id || event.hidden || (event.subtype && !["file_share", "thread_broadcast"].includes(event.subtype))) return;
  const { user, channel, ts } = event;
  if (!user || !channel || !ts || !envelope.team_id || ![user, channel, ts, envelope.team_id].every(value => ID.test(value))) return;
  if (event.thread_ts !== undefined && !ID.test(event.thread_ts)) return;
  const dm = event.channel_type === "im";
  const threadTs = dm ? undefined : event.thread_ts ?? ts;
  const target: SlackTarget = { channel, ...(threadTs ? { threadTs } : {}) };
  const text = (event.text ?? "").trim();
  const agent = client.slack!.agent;

  const bot = envelope.authorizations?.[0]?.user_id;
  const addressed = dm || Boolean(bot && text.includes(`<@${bot}>`));
  const person = await slackPerson(deps.desk, client, user, envelope.team_id);
  if (!person) {
    // Someone the agent does not act for (or Slack could not say who): a reply when they talk to her, silence in the channel.
    const names = client.slack!.people.map(p => p.name);
    const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names.join("");
    const reply = person === null ? `Sorry, I can only help ${list} for now.` : "Sorry, I couldn't check your Slack account just now. Please try again in a minute.";
    if (addressed) await postSlack(deps.desk, client, target, { text: reply }, `slack-no-${channel}-${ts}`);
    return;
  }

  const files = (event.files ?? []).filter(file => file.id && ID.test(file.id));
  const attached = files.length
    ? `\n\nAttached files (read them with read_slack_file before acting on them): ${files.map(f => `${f.id} "${(f.name ?? "file").slice(0, 100)}" (${f.mimetype ?? "unknown type"})`).join(", ")}`
    : "";
  const timeZone = String(client.agentSettings?.[agent]?.timezone ?? "America/Chicago");
  const header = `[Slack ${dm ? "direct message" : event.thread_ts ? "thread reply" : "channel message"} from ${person.name}, ${localTime(deps.now?.() ?? new Date(), timeZone)}; channel ${channel}]`;
  const message = `${header}\n${text.slice(0, MAX_TEXT)}${attached}`;
  const conversationId = dm ? `slack-${channel}` : `slack-${channel}-${threadTs}`;
  try {
    const started = await env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`${client.id}/${agent}/${conversationId}`)).startJob({
      clientId: client.id, agentId: agent, conversationId, userId: SLACK_USER, source: "slack", input: { id: `slack-${channel}-${ts}`, text: message }, slack: { ...target, addressed },
    });
    // 👀 on what is for her (a DM, her name or @mention, a thread she is in), so the person knows she saw it. Never on chatter.
    if (started.slackEngaged) await reactSeen(deps.desk, client, channel, ts);
    // The conversation waits for a decision on a card before it reads anything new: say so, or the person hears nothing.
    if (started.queued && started.job.status === "needs_approval") {
      await postSlack(deps.desk, client, target, { text: "I'm still waiting on an Approve or Decline for the card above. I'll pick this up right after." }, `slack-queued-${channel}-${ts}`);
    }
  } catch (error) {
    console.error("slack job not started", error instanceof Error ? error.message.slice(0, 120) : typeof error);
    await postSlack(deps.desk, client, target, { text: "Sorry, I couldn't take that on right now. Please try again in a minute." }, `slack-busy-${channel}-${ts}`);
  }
}

/** Slack's markdown dialect: **bold** → *bold*, [text](url) → <url|text>, # headings → bold lines. */
export function toSlackText(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*");
}

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * The approval card: what will happen, in full, and the two buttons. The id is the proposal's action id. A long summary is
 * split at line breaks over several sections (Slack allows 3,000 characters in one), never cut: Jess approves what she sees.
 */
export function approvalBlocks(id: string, approval: { title: string; summary: string }): unknown[] {
  const sections: string[] = [];
  for (const line of `*Needs your OK:* ${approval.title}\n${toSlackText(approval.summary)}`.split("\n")) {
    for (let rest = line; ; rest = rest.slice(2_900)) {
      const piece = rest.slice(0, 2_900);
      if (sections.length && sections.at(-1)!.length + piece.length + 1 <= 2_900) sections[sections.length - 1] += `\n${piece}`;
      else sections.push(piece);
      if (rest.length <= 2_900) break;
    }
  }
  return [
    ...sections.map(text => ({ type: "section", text: { type: "mrkdwn", text } })),
    { type: "actions", elements: [
      { type: "button", action_id: APPROVE, style: "primary", text: { type: "plain_text", text: "Approve" }, value: id },
      { type: "button", action_id: DECLINE, style: "danger", text: { type: "plain_text", text: "Decline" }, value: id },
    ] },
  ];
}

interface SlackAction { action_id?: string; value?: string }
interface SlackInteraction {
  type?: string; team?: { id?: string }; user?: { id?: string }; actions?: SlackAction[]; response_url?: string;
  message?: { blocks?: unknown[] };
}

/** A press on a card, handed to the proposal's Conversation, which decides it from its alarm (no 30-second waitUntil cap). */
export interface SlackDecision {
  id: string; approve: boolean;
  /** The approver id and display name of the person who pressed. */
  decidedBy: string; name: string;
  title: string; responseUrl: string;
  /** The card as it was, to put back (buttons included) when the decision could not finish. */
  blocks: unknown[];
}

/**
 * Rewrites the card through its response_url, which only Slack's hooks host serves. `blocks` replaces the card; without them,
 * `text` replaces it with one buttonless line, or (ephemeral) is shown only to the presser and the card stays.
 */
export async function updateCard(responseUrl: string, text: string, mode: "replace" | "ephemeral", blocks?: unknown[]): Promise<void> {
  let url: URL;
  try { url = new URL(responseUrl); } catch { return; }
  if (url.protocol !== "https:" || url.hostname !== "hooks.slack.com") return;
  const body = mode === "ephemeral" ? { replace_original: false, response_type: "ephemeral", text }
    : { replace_original: true, text, blocks: blocks ?? [{ type: "section", text: { type: "mrkdwn", text: clip(text, 2900) } }] };
  await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .catch(error => console.error("slack card update failed", error instanceof Error ? error.name : typeof error));
}

/** What the card says after a decision, from the approval record the decision returned. */
export function decisionText(reply: DecisionReply, approve: boolean, who: string, title: string): string {
  const record = reply.body ? JSON.parse(reply.body) as { status?: string; decidedBy?: string; error?: string } : undefined;
  if (reply.status === 404 || !record) return `${title}\nThis request no longer exists.`;
  if (reply.status === 400) return `${title}\nOpen the app to pick an option and decide this request. Nothing was approved here.`;
  if (reply.status === 409) return `${title}\n${record.error ? `Not done: ${record.error}` : `Already ${record.status === "declined" ? "declined" : "approved"} by ${record.decidedBy ?? "someone"}.`}`;
  if (!approve) return `:x: Declined by ${who}: ${title}`;
  const said: Record<string, string> = { done: ":white_check_mark: Approved by WHO and done", failed: ":warning: Approved by WHO, but it did not go through", uncertain: ":warning: Approved by WHO; the result is uncertain, a person should check" };
  return `${(said[record.status ?? ""] ?? ":white_check_mark: Approved by WHO").replace("WHO", who)}: ${title}`;
}

/** The card back as it was, with a line under it saying the press did not finish, so the buttons can be pressed again. */
export function retryBlocks(blocks: unknown[]): unknown[] {
  return [...blocks, { type: "context", elements: [{ type: "mrkdwn", text: ":warning: That press didn't finish. Check the dashboard, or press again: a request already done is never done twice." }] }];
}

/**
 * POST /v1/slack/<client>/interactions: an Approve or Decline press. Answers Slack at once. The work checks the presser is
 * an approver, reads the proposal, and hands the decision to `queue` (its Conversation), which decides and rewrites the card.
 */
export async function slackInteractions(
  request: Request, env: Env, client: ClientConfig, deps: SlackDeps,
  queue: (approval: { agent: string; conversationId: string }, decision: SlackDecision) => Promise<void>,
): Promise<{ response: Response; work?: Promise<void> }> {
  const secret = env[client.slack!.signingSecretEnv];
  if (typeof secret !== "string" || secret.length < 16) return { response: Response.json({ error: "Slack is not set up for this client." }, { status: 503 }) };
  const raw = await verifySlack(request, secret, (deps.now?.() ?? new Date()).getTime());
  if (raw === undefined) return { response: Response.json({ error: "Invalid Slack signature." }, { status: 401 }) };
  let payload: SlackInteraction;
  try { payload = JSON.parse(new URLSearchParams(raw).get("payload") ?? "") as SlackInteraction; } catch { return { response: Response.json({ error: "Bad request" }, { status: 400 }) }; }
  const action = payload.actions?.[0];
  if (payload.type !== "block_actions" || (action?.action_id !== APPROVE && action?.action_id !== DECLINE) || !action.value || !/^[A-Za-z0-9_.:-]{1,128}$/.test(action.value)) {
    return { response: new Response(null, { status: 200 }) };
  }
  const id = action.value;
  const approve = action.action_id === APPROVE;
  const userId = payload.user?.id ?? "";
  const teamId = payload.team?.id ?? "";
  const responseUrl = payload.response_url ?? "";
  const blocks = Array.isArray(payload.message?.blocks) && JSON.stringify(payload.message.blocks).length < 12_000 ? payload.message.blocks : [];
  const work = (async () => {
    const person = ID.test(userId) && ID.test(teamId) ? await slackPerson(deps.desk, client, userId, teamId) : null;
    if (!person || !client.approvers?.includes(person.id)) {
      await updateCard(responseUrl, person === undefined ? "I couldn't check your Slack account just now; nothing was decided. Press the button again in a minute." : "Only the people this agent works for can approve or decline this.", "ephemeral");
      return;
    }
    const stored = await env.DASHBOARD.get(env.DASHBOARD.idFromName(client.id)).approvalJson(id);
    const approval = stored ? JSON.parse(stored) as { agent: string; conversationId: string; title: string } : undefined;
    if (!approval) {
      await updateCard(responseUrl, "This request no longer exists.", "replace");
      return;
    }
    if (approve) await updateCard(responseUrl, `:hourglass_flowing_sand: Approved by ${person.name}, working on it: ${approval.title}`, "replace");
    try {
      await queue(approval, { id, approve, decidedBy: person.id, name: person.name, title: approval.title, responseUrl, blocks });
    } catch (error) {
      console.error("slack decision not queued", error instanceof Error ? error.message.slice(0, 120) : typeof error);
      await updateCard(responseUrl, `:warning: ${approval.title}`, "replace", blocks.length ? retryBlocks(blocks) : undefined);
    }
  })();
  return { response: new Response(null, { status: 200 }), work };
}
