import { missingNames, writeFingerprint } from "./connections";
import type { ClientConfig, ConnectionHandle, PlannedRequest, ToolContext } from "./contracts";
import type { DeskApi, DeskReply, DeskRequest } from "./desk-api";
import { SafeConfigurationError, ToolError } from "./errors";

// The brain's side of the desk: a thin client. It holds no credential; it forwards each request over the `DESK`
// service binding and keeps the bookkeeping the loop owns (which approved writes are used up).

/** What the desk said about an agent's connections, fetched once per turn: names and identifiers, never credentials. */
export interface DeskState {
  presence: Record<string, boolean>;
  ids: Record<string, Record<string, string>>;
}

const READ_METHODS = ["GET", "HEAD"];

/** Fails closed: when the desk cannot be reached, every connection reads as not set up. */
export async function loadDeskState(desk: DeskApi, clientId: string, agentId: string): Promise<DeskState> {
  try {
    const [presence, ids] = await Promise.all([desk.presence(clientId, agentId), desk.ids(clientId, agentId)]);
    return { presence, ids };
  } catch (error) {
    console.error("desk presence failed", error instanceof Error ? error.name : typeof error);
    return { presence: {}, ids: {} };
  }
}

/** Rejects when `signal` aborts; the desk's own timeout ends the request on its side. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export interface DeskClientInput {
  desk: DeskApi;
  state: DeskState;
  client: ClientConfig;
  agentId: string;
  toolName: string;
  actionId: string;
  signal: AbortSignal;
  /** Approved writes still unused (fingerprint -> count). Undefined: nothing approved. */
  approved?: Map<string, number>;
  /** Collects writes instead of sending them. */
  planning?: PlannedRequest[];
}

export function deskClientContext(input: DeskClientInput): Pick<ToolContext, "connection" | "hasSecret"> {
  const { desk, state, client, agentId, approved } = input;
  return {
    hasSecret: name => state.presence[name] === true,
    connection(id): ConnectionHandle {
      const connection = client.connections?.find(c => c.id === id);
      if (!connection || !connection.agents.includes(agentId)) throw new ToolError(`This agent has no "${id}" connection for this client.`, true);
      const idValue = (name: string) => state.ids[id]?.[name];
      return {
        missing: missingNames(connection, name => state.presence[name] === true),
        id(name) {
          const value = idValue(name);
          if (value === undefined) throw new SafeConfigurationError(`The ${id} connection has no ${name} set (${connection.ids?.[name] ?? name}).`);
          return value;
        },
        optionalId: idValue,
        async fetch(url, init = {}) {
          const method = (init.method ?? "GET").toUpperCase();
          // An approved write is reserved before it is sent, so two identical parallel requests cannot both use one approval.
          let reserved: string | undefined;
          if (approved && !READ_METHODS.includes(method)) {
            const print = await writeFingerprint({ connection: id, method, url, body: init.body }).catch(() => undefined);
            if (print && (approved.get(print) ?? 0) > 0) { approved.set(print, approved.get(print)! - 1); reserved = print; }
          }
          const release = () => { if (reserved) approved!.set(reserved, (approved!.get(reserved) ?? 0) + 1); };
          const request: DeskRequest = {
            clientId: client.id, agentId, toolName: input.toolName, actionId: input.actionId, connection: id, url, method,
            headers: init.headers ?? {}, body: init.body, redirect: init.redirect,
            approved: approved ? (reserved ? [reserved] : []) : undefined, planning: input.planning ? true : undefined,
          };
          if (input.signal.aborted) { release(); throw new ToolError("Not sent: the request was cancelled before dispatch.", true); }
          // A thrown error (desk unreachable, network) leaves the approval used: the write may have happened.
          const reply: DeskReply = await abortable(desk.send(request), input.signal);
          if (reply.status === "refused") { release(); throw new ToolError(reply.message, reply.definite); }
          if (reply.status === "planned") {
            release();
            input.planning!.push(reply.planned);
            // A plan is recorded, not sent: the tool sees an empty success and must not rely on its body.
            return new Response(null, { status: 204 });
          }
          if (reserved && reply.consumed !== reserved) release();
          return reply.response;
        },
      };
    },
  };
}
