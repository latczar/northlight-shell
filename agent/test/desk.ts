import { env } from "cloudflare:test";
import { AGENTS } from "../agents";
import { CLIENTS } from "../clients";
import { connectionHandle, type DeskLogEntry, type DeskTurn } from "../src/connections";
import type { ClientConfig, JsonObject, ToolContext } from "../src/contracts";
import type { DeskApi } from "../src/desk-api";
import { ids, mediaUploadUrl, ownsContext, presence, send, type DeskEnv } from "../desk/service";

// Test helpers only: production tools always reach the desk through the `DESK` service binding.

/**
 * The real front desk for a hand-built test context: `secrets` stands in for the Worker's env vars. Ownership runs the
 * agent template's own `owns` with the desk's real `ownsContext` (its bindings, `settings` as the effective settings,
 * `clientId` for a test-specific client id), exactly as in production; pass `owns` only to stub it for a made-up client.
 * Pass `log` to collect the desk's log entries, `approved` / `planning` for approval runs.
 */
export function testDesk(options: {
  agentId: string;
  secrets: Record<string, string>;
  client?: ClientConfig;
  clientId?: string;
  settings?: JsonObject;
  actionId?: string;
  owns?: (kind: string, value: string) => Promise<boolean>;
  approved?: Map<string, number>;
  planning?: DeskTurn["planning"];
  log?: DeskLogEntry[];
  used?: Set<string>;
}): Pick<ToolContext, "connection" | "hasSecret"> {
  const base = options.client ?? CLIENTS.find(c => c.id === "acme")!;
  const client = options.clientId ? { ...base, id: options.clientId } : base;
  const agent = AGENTS[options.agentId];
  const turn: DeskTurn = {
    client, agentId: options.agentId, toolName: "test", actionId: options.actionId ?? "a1",
    signal: new AbortController().signal, env: name => options.secrets[name] || undefined, used: options.used ?? new Set(),
    approved: options.approved, planning: options.planning,
    owns: options.owns ?? (async (kind, value) => agent?.owns
      ? agent.owns(ownsContext(env, client, agent, options.settings ?? client.agentSettings?.[agent.id] ?? {}, id => connectionHandle(turn, id)), kind, value)
      : false),
    log: async entry => { options.log?.push(entry); },
  };
  return { connection: id => connectionHandle(turn, id), hasSecret: name => Boolean(options.secrets[name]) };
}

/**
 * The desk Worker's own functions (desk/service.ts) run in-process with a fake env, as a `DeskApi` for `runTurn`.
 * `secrets` stands in for the desk's secrets; `clients` replaces the configured clients (a test client, other settings).
 */
export function testDeskApi(secrets: Record<string, string> = {}, clients: ClientConfig[] = CLIENTS): DeskApi {
  const deskEnv = (): DeskEnv => ({ IMAGES: env.IMAGES, DASHBOARD: env.DASHBOARD, ...secrets });
  return {
    presence: async (clientId, agentId) => presence(deskEnv(), clientId, agentId, clients),
    ids: async (clientId, agentId) => ids(deskEnv(), clientId, agentId, clients),
    send: request => send(deskEnv(), request, clients),
    mediaUploadUrl: (clientId, key, contentType, size, meta) => mediaUploadUrl(deskEnv(), clientId, key, contentType, size, meta, clients),
  };
}

/** A desk with no connections, for tests of the loop itself: every connection reads as not set up and nothing is sent. */
export const noDesk: DeskApi = {
  presence: async () => ({}),
  ids: async () => ({}),
  send: async () => { throw new Error("This test has no desk."); },
  mediaUploadUrl: async () => { throw new Error("This test has no desk."); },
};
