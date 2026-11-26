import { AGENTS } from "../agents";
import { CLIENTS } from "../clients";
import { connectionEnvNames, connectionHandle, redactText, type DeskTurn } from "../src/connections";
import { toolBindings } from "../src/bindings";
import type { AgentTemplate, ClientConfig, ConnectionHandle, JsonObject, PlannedRequest, ToolContext } from "../src/contracts";
import type { Dashboard } from "../src/dashboard";
import type { DeskReply, DeskRequest, MediaUploadLink, MediaUploadMeta } from "../src/desk-api";
import { SafeConfigurationError, ToolError } from "../src/errors";
import { agentSettings } from "../src/settings";
import { FILE_NAME, FOLDER, MEDIA_BUCKET, parsePendingKey, UPLOAD_TTL_S, validateUpload } from "../src/media";
import { presign } from "./presign";

// The desk's logic, as plain functions so tests can run them with a fake env. desk/index.ts only exposes them over RPC.
// Everything a caller sends is untrusted: the client, agent and connection must exist and match, and the request is
// checked by the same rules as an in-process desk (src/connections.ts). Credentials never leave this Worker.

export interface DeskEnv {
  /** Same bucket as the brain's: an agent's `owns` may read the records its tools wrote. */
  IMAGES: R2Bucket;
  /** The brain's Dashboard object (script_name northlight-agent): receives the connection log, serves setting overrides. */
  DASHBOARD: DurableObjectNamespace<Dashboard>;
  /** Service credentials, by env var name (clients/<id>/<agent>.json connections). */
  [secret: string]: unknown;
}

/** Longest the desk waits for an outside service. The brain's own tool timeout usually fires first. */
const TIMEOUT_MS = 120_000;
const MAX_APPROVED = 100;
const METHOD = /^[A-Za-z]{1,16}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const REDIRECTS = ["follow", "manual", "error"];
/** Response bodies with these statuses cannot be rebuilt with a body. */
const NO_BODY = [101, 204, 205, 304];
const TEXT_TYPE = /^(text\/|application\/(json|xml|x-www-form-urlencoded)|[^;]*\+(json|xml))/i;

const secretValue = (env: DeskEnv, name: string): string | undefined => {
  const value = env[name];
  return typeof value === "string" && value ? value : undefined;
};

function lookup(clients: ClientConfig[], clientId: unknown, agentId: unknown): { client: ClientConfig; agent: AgentTemplate } {
  const client = clients.find(c => c.id === clientId);
  if (!client) throw new Error("Unknown client.");
  const agent = typeof agentId === "string" && client.agents.includes(agentId) ? AGENTS[agentId] : undefined;
  if (!agent) throw new Error("Unknown agent for this client.");
  return { client, agent };
}

/** Which of the agent's connection env vars are set. Names only. */
export function presence(env: DeskEnv, clientId: unknown, agentId: unknown, clients = CLIENTS): Record<string, boolean> {
  const { client, agent } = lookup(clients, clientId, agentId);
  return Object.fromEntries(connectionEnvNames(client, agent.id).map(name => [name, secretValue(env, name) !== undefined]));
}

/** The identifiers (a connection's `ids`, never credentials) the agent's connections have set. */
export function ids(env: DeskEnv, clientId: unknown, agentId: unknown, clients = CLIENTS): Record<string, Record<string, string>> {
  const { client, agent } = lookup(clients, clientId, agentId);
  return Object.fromEntries((client.connections ?? []).filter(c => c.agents.includes(agent.id) && c.ids).map(c => [
    c.id,
    Object.fromEntries(Object.entries(c.ids!).flatMap(([name, envName]) => { const value = secretValue(env, envName); return value === undefined ? [] : [[name, value]]; })),
  ]));
}

const UPLOADER = /^[A-Za-z0-9%._~-]{1,300}$/;

/**
 * A presigned S3 PUT into the media bucket for this client's pending upload `key`, valid 15 minutes (not single-use). The
 * content type, the exact size and the folder/name/uploader are signed headers, so R2 refuses a PUT whose bytes or headers
 * differ from what the brain checked. The S3 credentials live only here. `now` is a test seam.
 */
export async function mediaUploadUrl(env: DeskEnv, clientId: unknown, key: unknown, contentType: unknown, size: unknown, meta: unknown, clients = CLIENTS, now = new Date()): Promise<MediaUploadLink> {
  if (!clients.some(c => c.id === clientId)) throw new Error("Unknown client.");
  if (typeof clientId !== "string" || !parsePendingKey(clientId, key)) throw new Error("Bad request: key.");
  const problem = validateUpload(contentType, size);
  if (problem) throw new Error(`Bad request: ${problem}`);
  const { folder, name, uploader } = (meta ?? {}) as Partial<MediaUploadMeta>;
  if (typeof folder !== "string" || !FOLDER.test(folder) || typeof name !== "string" || !FILE_NAME.test(name) || typeof uploader !== "string" || !UPLOADER.test(uploader)) throw new Error("Bad request: meta.");
  const [accessKeyId, secretAccessKey, account] = ["R2_MEDIA_ACCESS_KEY_ID", "R2_MEDIA_SECRET_ACCESS_KEY", "R2_MEDIA_ACCOUNT_ID"].map(secret => secretValue(env, secret));
  if (!accessKeyId || !secretAccessKey || !account) throw new Error("Media uploads are not set up on the desk.");
  const headers = {
    "Content-Type": contentType as string, "Content-Length": String(size),
    "x-amz-meta-folder": folder, "x-amz-meta-name": name, "x-amz-meta-size": String(size), "x-amz-meta-uploader": uploader,
  };
  const uploadUrl = await presign({
    method: "PUT", host: `${account}.r2.cloudflarestorage.com`, path: `/${MEDIA_BUCKET}/${key as string}`, headers,
    accessKeyId, secretAccessKey, region: "auto", service: "s3", expiresSeconds: UPLOAD_TTL_S, now,
  });
  return { uploadUrl, headers, expiresAt: new Date(now.getTime() + UPLOAD_TTL_S * 1000).toISOString() };
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value || value.length > max) throw new Error(`Bad request: ${label}.`);
  return value;
}

function parseRequest(raw: unknown): DeskRequest {
  if (typeof raw !== "object" || raw === null) throw new Error("Bad request.");
  const r = raw as Record<string, unknown>;
  const headers = r.headers ?? {};
  if (typeof headers !== "object" || headers === null || Array.isArray(headers) || !Object.values(headers).every(v => typeof v === "string")) throw new Error("Bad request: headers.");
  if (r.body !== undefined && typeof r.body !== "string" && !(r.body instanceof Uint8Array)) throw new Error("Bad request: body.");
  if (r.redirect !== undefined && !REDIRECTS.includes(r.redirect as string)) throw new Error("Bad request: redirect.");
  if (r.planning !== undefined && typeof r.planning !== "boolean") throw new Error("Bad request: planning.");
  const approved = r.approved;
  if (approved !== undefined && (!Array.isArray(approved) || approved.length > MAX_APPROVED || !approved.every(p => typeof p === "string" && FINGERPRINT.test(p)))) throw new Error("Bad request: approved.");
  const method = text(r.method, "method", 16);
  if (!METHOD.test(method)) throw new Error("Bad request: method.");
  return {
    clientId: text(r.clientId, "clientId", 100), agentId: text(r.agentId, "agentId", 100), toolName: text(r.toolName, "toolName", 200),
    actionId: text(r.actionId, "actionId", 200), connection: text(r.connection, "connection", 100), url: text(r.url, "url", 8192), method,
    headers: headers as Record<string, string>, body: r.body as DeskRequest["body"], redirect: r.redirect as DeskRequest["redirect"],
    approved: approved as string[] | undefined, planning: r.planning as boolean | undefined,
  };
}

/**
 * What an agent's `owns` gets: the desk's own bindings and no credentials. It may read state (IMAGES, DASHBOARD) and a
 * connection's non-secret identifiers (`id`, `optionalId`, `missing`), but a connection's `fetch` is unavailable.
 */
export function ownsContext(env: Pick<DeskEnv, "IMAGES" | "DASHBOARD">, client: ClientConfig, agent: AgentTemplate, settings: JsonObject, connection: (id: string) => ConnectionHandle): ToolContext {
  const unavailable = (): never => { throw new ToolError("Not available while the desk checks ownership.", true); };
  return {
    clientId: client.id, agentId: agent.id, conversationId: "", actionId: "", signal: AbortSignal.timeout(TIMEOUT_MS),
    bindings: toolBindings({ IMAGES: env.IMAGES, DASHBOARD: env.DASHBOARD }),
    hasSecret: () => false, connection: id => ({ ...connection(id), fetch: unavailable }),
    actionResult: () => undefined, brokenRule: () => undefined, settings, reserveSpend: async () => false,
  };
}

/** Replaces credential values in the response headers and, for text-like bodies, the body; other bodies (images, files) pass through untouched. */
async function redactResponse(response: Response, secrets: Set<string>): Promise<Response> {
  if (!secrets.size) return response;
  const headers = new Headers();
  let changed = false;
  for (const [name, value] of response.headers) {
    const clean = redactText(value, secrets);
    changed ||= clean !== value;
    headers.append(name, clean);
  }
  const text = response.body && !NO_BODY.includes(response.status) && TEXT_TYPE.test(response.headers.get("content-type") ?? "");
  if (!text && !changed) return response;
  if (text) {
    headers.delete("content-length");
    headers.delete("content-encoding");
  }
  return new Response(text ? redactText(await response.text(), secrets) : response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Why presented approval fingerprints cannot be trusted, or undefined when they are fine: the action's approval (read
 * from the client's own Dashboard object) must exist for this agent and tool, be approved by a person and not yet
 * finished, and every presented fingerprint must be in the write plan stored when it was proposed (each as often as
 * the plan lists it).
 */
async function unapproved(env: DeskEnv, client: ClientConfig, agent: AgentTemplate, request: DeskRequest): Promise<string | undefined> {
  const dashboard = env.DASHBOARD.get(env.DASHBOARD.idFromName(client.id));
  const [raw, plan] = await Promise.all([dashboard.approvalJson(request.actionId), dashboard.writePlan(request.actionId)]);
  const approval = raw ? JSON.parse(raw) as { agent: string; tool: string; status: string } : undefined;
  if (!approval || approval.status !== "approved" || approval.agent !== agent.id || approval.tool !== request.toolName) {
    return "No person has approved this action.";
  }
  const left = new Map<string, number>();
  for (const print of plan) left.set(print, (left.get(print) ?? 0) + 1);
  for (const print of request.approved!) {
    const count = left.get(print) ?? 0;
    if (count === 0) return "This request is not in the plan a person approved.";
    left.set(print, count - 1);
  }
  return undefined;
}

/** Checks one request and sends it with the credential. Every refusal (bad arguments, unknown client or agent, a rule) comes back as `refused`. */
export async function send(env: DeskEnv, raw: unknown, clients = CLIENTS): Promise<DeskReply> {
  let request: DeskRequest;
  let client: ClientConfig;
  let agent: AgentTemplate;
  try {
    request = parseRequest(raw);
    ({ client, agent } = lookup(clients, request.clientId, request.agentId));
  } catch (error) {
    return { status: "refused", message: error instanceof Error ? error.message : "Bad request.", definite: true };
  }
  // Approved fingerprints are the brain's claim: the desk checks them against the approval it stored itself.
  const refusal = request.approved?.length ? await unapproved(env, client, agent, request) : undefined;
  if (refusal) return { status: "refused", message: refusal, definite: true };
  const approved = new Map<string, number>();
  for (const print of request.approved ?? []) approved.set(print, (approved.get(print) ?? 0) + 1);
  const before = new Map(approved);
  const planning: PlannedRequest[] = [];
  const used = new Set<string>();
  let settings: Promise<JsonObject> | undefined;
  const turn: DeskTurn = {
    client, agentId: agent.id, toolName: request.toolName, actionId: request.actionId, signal: AbortSignal.timeout(TIMEOUT_MS),
    env: name => secretValue(env, name), used,
    approved: request.approved ? approved : undefined, planning: request.planning ? planning : undefined,
    owns: async (kind, value) => {
      if (!agent.owns) return false;
      settings ??= agentSettings(env, client, agent.id);
      return agent.owns(ownsContext(env, client, agent, await settings, id => connectionHandle(turn, id)), kind, value);
    },
    log: entry => env.DASHBOARD.get(env.DASHBOARD.idFromName(client.id)).logRequest(entry).catch(() => {}),
  };
  const dashboard = env.DASHBOARD.get(env.DASHBOARD.idFromName(client.id));
  // Each approved fingerprint is used up in the Dashboard object (one thread, so concurrent sends cannot both pass)
  // before anything is sent. A request refused before sending gives its fingerprints back; an error after that point
  // (the service may have received it) keeps them used.
  const taken: string[] = [];
  const giveBack = (prints: string[]) => Promise.all(prints.map(print => dashboard.releaseFingerprint(request.actionId, print))).catch(() => {});
  for (const print of request.approved ?? []) {
    if (!await dashboard.consumeFingerprint(request.actionId, print)) {
      await giveBack(taken);
      return { status: "refused", message: "This approved request was already sent.", definite: true };
    }
    taken.push(print);
  }
  try {
    const response = await connectionHandle(turn, request.connection).fetch(request.url, {
      method: request.method, headers: request.headers, body: request.body, redirect: request.redirect,
    });
    if (planning.length) { await giveBack(taken); return { status: "planned", planned: planning[0] }; }
    const consumed = [...before].find(([print, count]) => (approved.get(print) ?? 0) < count)?.[0];
    // Presented but not used by this request (it was a read, say): not sent, so not spent.
    await giveBack(taken.filter(print => print !== consumed));
    return { status: "response", response: await redactResponse(response, used), consumed };
  } catch (error) {
    if (error instanceof ToolError || error instanceof SafeConfigurationError) {
      const definite = error instanceof SafeConfigurationError || error.definite;
      if (definite) await giveBack(taken);
      return { status: "refused", message: error.message, definite };
    }
    throw error;
  }
}
