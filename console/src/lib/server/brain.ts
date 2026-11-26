import "server-only";
import { revalidateTag, unstable_cache } from "next/cache";
import { cache } from "react";
import type { AgentData, AgentSetup, AgentSummary, Approval, Card, ChatLine, Job, Lesson } from "@/lib/brain-types";
import { signAccessUpdate, signPass } from "@/lib/pass";
import { accessSigningKey, brainCredentials, type BrainCredentials } from "./config";

// Every call to the agent goes through here, on the server. Tokens and signing keys never reach the browser.

const READ_TIMEOUT_MS = 15_000;
// passes are signed per call and used at once; minutes cover clock drift
const USER_PASS_SECONDS = 5 * 60;
const APPROVER_PASS_SECONDS = 5 * 60;

export class BrainError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

const READ_MESSAGES: Record<number, string> = {
  401: "Northlight's service did not accept this app's key for this business. Tell your Northlight contact.",
  404: "Northlight's service does not know this business or employee.",
  429: "Northlight's service is busy. Wait a minute and refresh.",
};

const DECISION_MESSAGES: Record<number, { status: number; message: string }> = {
  400: { status: 400, message: "The decision was not understood. Refresh and try again." },
  401: { status: 502, message: "Northlight's service did not accept this app's signature. Tell your Northlight contact." },
  404: { status: 404, message: "This request no longer exists. Refresh to see the current list." },
  409: { status: 409, message: "This request was already decided the other way. Refresh to see it." },
  429: { status: 429, message: "Too many requests right now. Wait a minute and try again." },
};

const CHAT_MESSAGES: Record<number, { status: number; message: string }> = {
  400: { status: 400, message: "The message was empty or too long (8,000 characters at most)." },
  401: { status: 502, message: "Northlight's service did not accept this app's signature for you. Tell your Northlight contact." },
  404: { status: 404, message: "This employee is not available for this business." },
  409: { status: 409, message: "This conversation belongs to someone else." },
  429: { status: 429, message: "Too many messages right now. Wait a minute and try again." },
};

function credentials(clientId: string): BrainCredentials {
  const found = brainCredentials(clientId);
  if ("missing" in found) throw new BrainError(`This business is not connected yet. Missing settings: ${found.missing.join(", ")}.`, 503);
  return found;
}

async function call(creds: BrainCredentials, path: string, init: RequestInit, timeoutMs = READ_TIMEOUT_MS): Promise<Response> {
  try {
    return await fetch(`${creds.url}${path}`, {
      cache: "no-store",
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${creds.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new BrainError("Northlight's service did not answer. Try again in a minute.", 504);
  }
}

async function read<T>(clientId: string, path: string, headers?: Record<string, string>): Promise<T> {
  const response = await call(credentials(clientId), path, { headers });
  if (!response.ok) throw new BrainError(READ_MESSAGES[response.status] ?? `Northlight's service failed (HTTP ${response.status}).`);
  try {
    return await response.json() as T;
  } catch {
    throw new BrainError("Northlight's service sent an answer this app could not read.");
  }
}

/** Seconds a shared read stays fresh. Chat history and jobs are per person and live, so they are never kept. */
const TTL = { agents: 60, cards: 15, approvals: 10, agent: 60 } as const;

/**
 * A read shared by everyone who may see this client (callers check the viewer's access first), kept for `ttl` seconds
 * under the client's tag. It uses the client's own token, never a person's, so sharing it across viewers shows nobody
 * more. React's `cache` makes the layout and the page of one render share one read.
 */
const cachedRead = cache(async (clientId: string, path: string, ttl: number): Promise<unknown> => {
  const load = unstable_cache(async () => ({ at: Date.now(), value: await read<unknown>(clientId, path) }), ["brain-read", clientId, path], { revalidate: ttl, tags: [`brain:${clientId}`] });
  const hit = await load();
  // unstable_cache hands back an expired entry while it refreshes in the background; past the ttl, read fresh instead.
  return Date.now() - hit.at <= ttl * 1000 ? hit.value : read<unknown>(clientId, path);
});

/** Drops this client's kept reads (after a decision, a lesson decision or a finished job). */
export function clearBrainCache(clientId: string): void {
  revalidateTag(`brain:${clientId}`, { expire: 0 });
}

export async function listAgents(clientId: string): Promise<AgentSummary[]> {
  return (await cachedRead(clientId, "/v1/agents", TTL.agents) as { agents?: AgentSummary[] }).agents ?? [];
}

/** The client's employees as the brain has them now, for the People page, which must not act on a remembered list. */
export async function readAgents(clientId: string): Promise<AgentSummary[]> {
  return (await read<{ agents?: AgentSummary[] }>(clientId, "/v1/agents")).agents ?? [];
}

export async function listCards(clientId: string): Promise<Card[]> {
  return (await cachedRead(clientId, "/v1/dashboard", TTL.cards) as { cards?: Card[] }).cards ?? [];
}

/** Requests waiting for a decision (the brain's newest 200). */
export async function listPendingApprovals(clientId: string): Promise<Approval[]> {
  return (await cachedRead(clientId, "/v1/approvals?status=pending", TTL.approvals) as { approvals?: Approval[] }).approvals ?? [];
}

/** The brain's newest 200 requests, decided ones included, for an employee's history. */
export async function listApprovals(clientId: string): Promise<Approval[]> {
  return (await cachedRead(clientId, "/v1/approvals", TTL.approvals) as { approvals?: Approval[] }).approvals ?? [];
}

/** One request read now, or null when the brain does not have it. Decisions check ownership against this, never a kept copy. */
export async function getApproval(clientId: string, approvalId: string): Promise<Approval | null> {
  const response = await call(credentials(clientId), `/v1/approvals/${encodeURIComponent(approvalId)}`, {});
  if (response.status === 404) return null;
  if (!response.ok) throw new BrainError(READ_MESSAGES[response.status] ?? `Northlight's service failed (HTTP ${response.status}).`);
  try {
    return await response.json() as Approval;
  } catch {
    throw new BrainError("Northlight's service sent an answer this app could not read.");
  }
}

const agentPath = (agentId: string, rest: string) => `/v1/agents/${encodeURIComponent(agentId)}/${rest}`;

export async function getSetup(clientId: string, agentId: string): Promise<AgentSetup> {
  return await cachedRead(clientId, agentPath(agentId, "setup"), TTL.agent) as AgentSetup;
}

export async function getData(clientId: string, agentId: string): Promise<AgentData> {
  return await cachedRead(clientId, agentPath(agentId, "data"), TTL.agent) as AgentData;
}

/** Lessons for one employee plus the client-wide ones: proposed first, then active. */
export async function listLessons(clientId: string, agentId: string): Promise<Lesson[]> {
  return (await cachedRead(clientId, agentPath(agentId, "lessons"), TTL.agent) as { lessons?: Lesson[] }).lessons ?? [];
}

export type Decision = "approve" | "decline" | "revise";
export type DecisionResult = { ok: true; approval: Approval } | { ok: false; status: number; message: string };

/**
 * Decides a request as the person who asked (with the approve right), or as an Northlight admin. `revise` asks the employee for
 * a new draft of a declined one and answers with the new request. Callers check ownership and admin status before signing.
 */
export async function decideApproval(clientId: string, approvalId: string, decision: Decision, reason: string, personId: string, admin: boolean): Promise<DecisionResult> {
  const creds = credentials(clientId);
  if (admin && creds.approverKey.length < 32) throw new BrainError("This app's admin signing key is not set up. Tell your Northlight contact.", 503);
  const pass = signPass(creds.approverKey, clientId, personId, Math.floor(Date.now() / 1000) + APPROVER_PASS_SECONDS, admin ? "admin" : "approve");
  const response = await call(creds, `/v1/approvals/${encodeURIComponent(approvalId)}`, {
    method: "POST",
    headers: { "content-type": "application/json", [admin ? "x-admin-pass" : "x-approver-pass"]: pass },
    body: JSON.stringify(reason ? { decision, reason } : { decision }),
  }, decision === "revise" ? 90_000 : READ_TIMEOUT_MS * 4);
  // Any answer (decided, or decided before by someone else) means the kept lists may be out of date.
  clearBrainCache(clientId);
  if (response.ok) return { ok: true, approval: await response.json() as Approval };
  // The brain's own sentence explains a refusal or a failed revision best (who may decide, what to do next).
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  if ((response.status === 403 || response.status === 503 || (decision === "revise" && response.status === 409)) && typeof body?.error === "string") {
    return { ok: false, status: response.status, message: body.error };
  }
  return { ok: false, ...(DECISION_MESSAGES[response.status] ?? { status: 502, message: `Northlight's service could not record your decision (HTTP ${response.status}). Try again.` }) };
}

export type LessonDecisionResult = { ok: true; lesson: Lesson } | { ok: false; status: number; message: string };

/** Approves or removes one lesson as `personId` (who must be on the brain's approver list for its employee). */
export async function decideLesson(clientId: string, lessonId: string, decision: "approve" | "remove", personId: string): Promise<LessonDecisionResult> {
  const creds = credentials(clientId);
  const pass = signPass(creds.approverKey, clientId, personId, Math.floor(Date.now() / 1000) + APPROVER_PASS_SECONDS, "approve");
  const response = await call(creds, `/v1/lessons/${encodeURIComponent(lessonId)}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-approver-pass": pass },
    body: JSON.stringify({ decision }),
  });
  clearBrainCache(clientId);
  if (response.ok) return { ok: true, lesson: (await response.json() as { lesson: Lesson }).lesson };
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  if (response.status === 403 && typeof body?.error === "string") return { ok: false, status: 403, message: body.error };
  return { ok: false, ...(DECISION_MESSAGES[response.status] ?? { status: 502, message: `Northlight's service could not record your decision (HTTP ${response.status}). Try again.` }) };
}

const conversationPath = (agentId: string, personId: string, rest: string) => agentPath(agentId, `conversations/web-${encodeURIComponent(personId)}/${rest}`);
const userPass = (creds: BrainCredentials, clientId: string, personId: string) =>
  signPass(creds.userKey, clientId, personId, Math.floor(Date.now() / 1000) + USER_PASS_SECONDS);

/** One page of this person's conversation with an employee, oldest first. `before` is the first shown line's `seq`. */
export async function listMessages(clientId: string, agentId: string, personId: string, before?: number, limit = 30): Promise<{ messages: ChatLine[]; more: boolean }> {
  const creds = credentials(clientId);
  const query = new URLSearchParams({ limit: String(limit), ...(before ? { before: String(before) } : {}) });
  const response = await call(creds, `${conversationPath(agentId, personId, "messages")}?${query}`, { headers: { "x-user-pass": userPass(creds, clientId, personId) } });
  if (!response.ok) throw new BrainError(CHAT_MESSAGES[response.status]?.message ?? `Northlight's service failed (HTTP ${response.status}).`);
  const body = await response.json().catch(() => null) as { messages?: ChatLine[]; more?: boolean } | null;
  if (!body || !Array.isArray(body.messages)) throw new BrainError("Northlight's service sent an answer this app could not read.");
  return { messages: body.messages, more: body.more === true };
}

export type JobResult<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

/**
 * Hands one chat message to the employee as a background job and returns at once. One conversation per person and
 * employee; re-sending the same message id is a safe retry. While a job runs, the message is queued (`queued: true`).
 */
export async function startJob(clientId: string, agentId: string, personId: string, message: { id: string; text: string }): Promise<JobResult<{ job: Job; queued: boolean }>> {
  const creds = credentials(clientId);
  const response = await call(creds, conversationPath(agentId, personId, "jobs"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-user-pass": userPass(creds, clientId, personId) },
    body: JSON.stringify({ id: message.id, text: message.text }),
  });
  if (!response.ok) return { ok: false, ...(CHAT_MESSAGES[response.status] ?? { status: 502, message: `Northlight's service failed (HTTP ${response.status}). Try again.` }) };
  const body = await response.json().catch(() => null) as { job?: Job; queued?: boolean } | null;
  if (!body?.job) return { ok: false, status: 502, message: "Northlight's service sent an answer this app could not read." };
  return { ok: true, value: { job: body.job, queued: body.queued === true } };
}

/** The conversation's current (or latest) job, or null when it has none. Throws BrainError. */
export async function getJob(clientId: string, agentId: string, personId: string): Promise<Job | null> {
  const creds = credentials(clientId);
  const response = await call(creds, conversationPath(agentId, personId, "job"), { headers: { "x-user-pass": userPass(creds, clientId, personId) } });
  if (!response.ok) throw new BrainError(CHAT_MESSAGES[response.status]?.message ?? `Northlight's service failed (HTTP ${response.status}).`);
  const body = await response.json().catch(() => undefined) as { job?: Job | null } | undefined;
  if (!body || body.job === undefined) throw new BrainError("Northlight's service sent an answer this app could not read.");
  return body.job;
}

/**
 * Hands the brain the client's full approver and manager lists (employee id → person ids), signed with
 * ACCESS_SIGNING_KEY_<CLIENT>. Throws unless the brain answers 200 {applied: true}. The brain skips a list whose
 * `version` is lower than the one it holds: either a newer send from this app got there first (pushAccess checks for
 * that), or another sender holds the same key (another environment, a database restored to older versions), which must
 * not count as delivered.
 */
export async function putApprovers(clientId: string, version: number, approvers: Record<string, string[]>, managers: Record<string, string[]>): Promise<void> {
  const creds = credentials(clientId);
  const { name, key } = accessSigningKey(clientId);
  if (!key) throw new BrainError(`This business is not connected yet. Missing settings: ${name}.`, 503);
  const body = JSON.stringify({ version, approvers, managers });
  const timestamp = Math.floor(Date.now() / 1000);
  const response = await call(creds, "/v1/access/approvers", {
    method: "PUT",
    headers: { "content-type": "application/json", "x-access-timestamp": String(timestamp), "x-access-signature": signAccessUpdate(key, clientId, timestamp, body) },
    body,
  });
  if (!response.ok) throw new BrainError(`Northlight's service refused the access list (HTTP ${response.status}).`, response.status);
  const answer = await response.json().catch(() => null) as { applied?: unknown } | null;
  if (answer === null) throw new BrainError("Northlight's service sent an answer this app could not read.", 502);
  if (answer.applied !== true) {
    throw new BrainError("Northlight's service holds a newer access list than this app sent. Check that only this app sends access lists for this business.", 409);
  }
}

export type CallDraftState = {state:"new" | "working" | "retry"} | {state:"ready"; original:Approval; latest:Approval};

export async function callDraft(client: string, person: string, callId: string, remarks?: string): Promise<CallDraftState> {
  const creds = credentials(client);
  const response = await call(creds, agentPath("iris", "calls/" + encodeURIComponent(callId) + "/services-draft"), {
    method: remarks === undefined ? "GET" : "POST",
    headers: {"content-type":"application/json", "x-user-pass":userPass(creds, client, person)},
    ...(remarks === undefined ? {} : {body:JSON.stringify({remarks})}),
  });
  if (!response.ok) throw new BrainError(response.status === 403 ? "Website manager access is required." : "Iris could not open this draft. Try again.");
  const data = await response.json() as CallDraftState;
  if (!data || !["new","working","retry","ready"].includes(data.state) ||
      (data.state === "ready" && (!data.original?.preview || !data.latest?.preview))) throw new BrainError("Iris returned an unknown draft status.");
  return data;
}
