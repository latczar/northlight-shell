import type { ClientConfig } from "./contracts";

// Approvers per agent are pushed by the agents app (PUT /v1/access/approvers), signed with the client's access key.
// Signature: `v1=<hex HMAC-SHA256 of "access\n<clientId>\n<timestamp>\n<sha256 hex of the raw body>">`.

const WINDOW_SECONDS = 300;
const USER_ID = /^[A-Za-z0-9_:-]{1,128}$/;
const MAX_PER_AGENT = 200;

const hex = (bytes: ArrayBuffer | Uint8Array) => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");

async function message(clientId: string, timestamp: string, body: string): Promise<Uint8Array> {
  const bodyHash = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
  return new TextEncoder().encode(`access\n${clientId}\n${timestamp}\n${bodyHash}`);
}

const hmacKey = (secret: string, usage: "sign" | "verify") =>
  crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);

/** What the agents app runs; exported for tests and documentation. */
export async function signAccess(secret: string, clientId: string, timestamp: string, body: string): Promise<string> {
  return `v1=${hex(await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), await message(clientId, timestamp, body)))}`;
}

/** True when the timestamp is within 300 s of now and the signature matches (constant-time compare). */
export async function verifyAccess(secret: string, clientId: string, timestamp: string, signature: string, body: string, nowSeconds: number): Promise<boolean> {
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(Number(timestamp) - nowSeconds) > WINDOW_SECONDS) return false;
  const match = signature.match(/^v1=([0-9a-f]{64})$/);
  if (!match) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), Uint8Array.from(match[1].match(/../g)!, b => parseInt(b, 16)), await message(clientId, timestamp, body));
}

type Lists = Record<string, string[]>;

/** One `{agent: [userId]}` list: agents must be the client's own, ids plain user ids. */
function parseLists(name: string, value: unknown, agents: string[]): Lists | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return `${name} must be an object of agent id to user ids.`;
  const clean: Lists = {};
  for (const [agent, users] of Object.entries(value)) {
    if (!agents.includes(agent)) return `Unknown agent: ${agent}.`;
    if (!Array.isArray(users) || users.length > MAX_PER_AGENT || !users.every(u => typeof u === "string" && USER_ID.test(u))) {
      return `${name}.${agent} must be a list of at most ${MAX_PER_AGENT} user ids.`;
    }
    clean[agent] = [...new Set(users as string[])];
  }
  return clean;
}

/** The body `{version, approvers, managers}` (each `{agent: [userId]}`), or an error message. Agents must be the client's own. */
export function parseApprovers(raw: string, agents: string[]): { version: number; approvers: Lists; managers: Lists } | string {
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return "Body must be JSON."; }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "Body must be an object.";
  const { version, approvers, managers, ...extra } = body as Record<string, unknown>;
  if (Object.keys(extra).length) return `Unknown field: ${Object.keys(extra)[0]}.`;
  if (!Number.isSafeInteger(version) || (version as number) <= 0) return "version must be a positive whole number.";
  const approverLists = parseLists("approvers", approvers, agents);
  if (typeof approverLists === "string") return approverLists;
  const managerLists = parseLists("managers", managers, agents);
  if (typeof managerLists === "string") return managerLists;
  return { version: version as number, approvers: approverLists, managers: managerLists };
}

/**
 * App approval and management use synced per-agent lists when configured. A static list may remain for Slack and voice;
 * it never augments the app's lists (src/index.ts may).
 */
export function validateAccess(client: ClientConfig): void {
  if (client.accessSigningEnv === undefined) return;
  if (!/^[A-Z][A-Z0-9_]*$/.test(client.accessSigningEnv)) throw new Error(`Client ${client.id} must name its access signing key\'s env var.`);
  if (!client.agents.length) throw new Error(`Client ${client.id} has accessSigningEnv but no agents.`);
}
