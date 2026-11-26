import type { ClientConfig, Connection, ConnectionHandle, PlannedRequest, RequestRule } from "./contracts";
import { SafeConfigurationError, ToolError } from "./errors";
import { BODY_POLICIES } from "./policies";

// The front desk: the only place a tool's request to an outside service gets its credential. A tool asks for one of
// its client's connections and hands the desk the request; the desk checks that the agent may use the connection, the
// host, the method and path (reads, the connection's `writes` rules, or a write a person approved, matched byte for
// byte) and only then adds the credential and sends it. The credential never reaches the tool. Every request, sent or
// refused, goes to the client's connection log. Credential values the desk used are collected for redaction.

const READ_METHODS = new Set(["GET", "HEAD"]);
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
/** Redirect hops the desk follows for a read, each checked like a new request. */
const MAX_REDIRECTS = 5;
/** Query parameters (after PHP's `.`, space and `[` to `_` rewrite, lowercased) that make a service read another verb or route. */
const METHOD_PARAMS = ["_method", "method", "rest_route"];

export interface DeskTurn {
  client: ClientConfig;
  agentId: string;
  toolName: string;
  actionId: string;
  signal: AbortSignal;
  /** Reads an env var; undefined when it is not set. Only the desk calls it. */
  env(name: string): string | undefined;
  /** Credential values used by this request; the desk replaces them in the answer. */
  used: Set<string>;
  /** Fingerprints of approved writes still unused (each may run once). Undefined: nothing approved. */
  approved?: Map<string, number>;
  /** Writes recorded instead of sent (computing a write plan). */
  planning?: PlannedRequest[];
  owns(kind: string, value: string): Promise<boolean>;
  log(entry: DeskLogEntry): Promise<void>;
}

export interface DeskLogEntry {
  agent: string; tool: string; actionId: string; connection: string; method: string; host: string; path: string;
  outcome: "sent" | "refused" | "planned"; status?: number; reason?: string;
}

/** Fingerprint of one write: connection, method, URL and a hash of the body. */
export async function writeFingerprint(request: PlannedRequest): Promise<string> {
  const body = await sha256(request.body ?? "");
  return sha256(`${request.connection}\n${request.method.toUpperCase()}\n${new URL(request.url).toString()}\n${body}`);
}

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Env var names a connection's credential needs. */
export function authNames(connection: Connection): string[] {
  const auth = connection.auth;
  if (!auth) return [];
  switch (auth.type) {
    case "bearer": case "header": case "query": return [auth.secret];
    case "basic": return [auth.user, auth.password];
    case "google": return [auth.clientId, auth.clientSecret, auth.refreshToken];
  }
}

/** Env var names of a connection that are not set yet (its credential's, and its required identifiers'). */
export function missingNames(connection: Connection, has: (name: string) => boolean): string[] {
  const optional = new Set(connection.optionalIds ?? []);
  return [
    ...authNames(connection).filter(name => !has(name)),
    ...Object.entries(connection.ids ?? {}).filter(([name, env]) => !optional.has(name) && !has(env)).map(([, env]) => env),
  ];
}

/** Every env var name the agent's connections use (credentials and identifiers). */
export function connectionEnvNames(client: ClientConfig, agentId: string): string[] {
  const names = (client.connections ?? []).filter(c => c.agents.includes(agentId)).flatMap(c => [...authNames(c), ...Object.values(c.ids ?? {})]);
  return [...new Set(names)];
}

/**
 * A host entry is exact, `*.example.com`, or `{name}`. `{name}` is the connection's identifier of that name when it
 * declares one (a host pinned in the desk's own env: only that host, never anything a setting says), else a host the
 * client owns (AgentTemplate.owns, e.g. its CMS site from settings).
 */
async function hostAllowed(connection: Connection, host: string, owns: DeskTurn["owns"], idValue: (name: string) => string | undefined): Promise<boolean> {
  for (const allowed of connection.hosts) {
    const placeholder = allowed.match(/^\{([a-zA-Z]+)\}$/);
    if (placeholder) {
      const [, name] = placeholder;
      if (connection.ids?.[name] ? idValue(name)?.toLowerCase() === host : await owns(name, host)) return true;
    } else if (allowed.startsWith("*.") ? host.endsWith(allowed.slice(1)) && host.length > allowed.length - 1 : host === allowed) return true;
  }
  return false;
}

type Binding = [name: string, value: string];

/** A literal, `{name}` or `prefix{name}` against one value: the placeholder it binds (none for a literal), or undefined when it does not match. */
function matchValue(pattern: string, got: string): Binding[] | undefined {
  const placeholder = pattern.match(/^([^{}]*)\{([a-zA-Z]+)\}$/);
  if (!placeholder) return pattern === got ? [] : undefined;
  const [, prefix, name] = placeholder;
  return got.startsWith(prefix) && got.length > prefix.length ? [[name, got.slice(prefix.length)]] : undefined;
}

/**
 * Checks a rule's `query` / `body` constraints. `read` gives a field's string value, undefined when absent, or null
 * when it is there but not one string (repeated, a number, an object). A `null` pattern requires the field absent.
 */
function matchFields(patterns: Record<string, string | null> | undefined, read: (name: string) => string | undefined | null): Binding[] | undefined {
  const bindings: Binding[] = [];
  for (const [name, pattern] of Object.entries(patterns ?? {})) {
    const got = read(name);
    if (pattern === null) {
      if (got !== undefined) return undefined;
      continue;
    }
    const found = typeof got === "string" ? matchValue(pattern, got) : undefined;
    if (!found) return undefined;
    bindings.push(...found);
  }
  return bindings;
}

/** A JSON body's string at a dotted path; a body that is not JSON matches no body constraint. */
function jsonReader(text: string): ((path: string) => string | undefined | null) | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  return path => {
    let value = parsed;
    for (const key of path.split(".")) {
      if (typeof value !== "object" || value === null || Array.isArray(value) || !Object.hasOwn(value, key)) return undefined;
      value = (value as Record<string, unknown>)[key];
    }
    return typeof value === "string" ? value : typeof value === "boolean" ? String(value) : null;
  };
}

/** Matches a rule; returns the placeholders (`{name}` / `prefix{name}` in the path, query and body) and their values, or undefined. */
function matchRule(rule: RequestRule, method: string, url: URL, body: string): Binding[] | undefined {
  if (rule.method !== "*" && rule.method.toUpperCase() !== method) return undefined;
  const want = rule.path.split("/").filter(Boolean);
  const got = url.pathname.split("/").filter(Boolean).map(segment => decodeURIComponent(segment));
  const bindings: Binding[] = [];
  let rest = false;
  for (let i = 0; i < want.length; i++) {
    if (want[i] === "**") { rest = true; break; }
    if (i >= got.length) return undefined;
    if (want[i] === "*") continue;
    const found = matchValue(want[i], got[i]);
    if (!found) return undefined;
    bindings.push(...found);
  }
  if (!rest && want.length !== got.length) return undefined;
  const query = matchFields(rule.query, name => { const all = url.searchParams.getAll(name); return all.length > 1 ? null : all[0]; });
  if (!query) return undefined;
  bindings.push(...query);
  if (rule.body) {
    const read = jsonReader(body);
    const fields = read && matchFields(rule.body, read);
    if (!fields) return undefined;
    bindings.push(...fields);
  }
  return bindings;
}

// Google access tokens per client + connection + refresh token, until shortly before they expire.
const googleTokens = new Map<string, { token: string; expiresAt: number }>();

async function googleToken(turn: DeskTurn, connection: Connection, auth: Extract<Connection["auth"], { type: "google" }>): Promise<string> {
  const [clientId, clientSecret, refreshToken] = [auth.clientId, auth.clientSecret, auth.refreshToken].map(name => turn.env(name)!);
  const key = `${turn.client.id}/${connection.id}/${await sha256(refreshToken)}`;
  const hit = googleTokens.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.token;
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST", signal: turn.signal,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }).toString(),
  });
  const body = response.ok ? await response.json().catch(() => null) as { access_token?: unknown; expires_in?: unknown } | null : null;
  if (typeof body?.access_token !== "string") throw new ToolError(`Google sign-in for ${connection.id} failed (HTTP ${response.status}). A person must reconnect it.`, true);
  const seconds = typeof body.expires_in === "number" ? body.expires_in : 3600;
  googleTokens.set(key, { token: body.access_token, expiresAt: Date.now() + Math.max(0, seconds - 120) * 1000 });
  return body.access_token;
}

export function connectionHandle(turn: DeskTurn, id: string): ConnectionHandle {
  const found = turn.client.connections?.find(c => c.id === id);
  if (!found || !found.agents.includes(turn.agentId)) {
    throw new ToolError(`This agent has no "${id}" connection for this client.`, true);
  }
  const connection: Connection = found;
  const optional = new Set(connection.optionalIds ?? []);
  const idValue = (name: string) => {
    const env = connection.ids?.[name];
    return env ? turn.env(env) || undefined : undefined;
  };
  const missing = missingNames(connection, name => Boolean(turn.env(name)));

  async function refuse(method: string, url: URL, reason: string): Promise<never> {
    await turn.log({ agent: turn.agentId, tool: turn.toolName, actionId: turn.actionId, connection: id, method, host: url.host, path: url.pathname, outcome: "refused", reason });
    throw new ToolError(`Not sent: ${reason}`, true);
  }

  /** One checked request; redirects are followed here (reads only), each hop checked again as a new request. */
  async function send(raw: string, init: Parameters<ConnectionHandle["fetch"]>[1] = {}, hops = 0): Promise<Response> {
      const method = (init.method ?? "GET").toUpperCase();
      let url: URL;
      try { url = new URL(raw); } catch { throw new ToolError("Not sent: the URL is invalid.", true); }
      if (url.protocol !== "https:" || url.username || url.password) return refuse(method, url, "only https URLs without credentials are allowed.");
      if (!await hostAllowed(connection, url.hostname, turn.owns, idValue)) return refuse(method, url, `${url.hostname} is not a host of the ${id} connection.`);
      if (missing.length) return refuse(method, url, `the ${id} connection is not set up (missing ${missing.join(", ")}).`);
      for (const name of Object.keys(init.headers ?? {})) {
        const lower = name.toLowerCase();
        const authHeader = connection.auth?.type === "header" && connection.auth.name.toLowerCase() === lower;
        if (lower === "authorization" || authHeader) return refuse(method, url, "a tool may not set the credential header.");
      }
      if (connection.auth?.type === "query" && url.searchParams.has(connection.auth.param)) return refuse(method, url, "a tool may not set the credential parameter.");
      if (connection.auth) {
        // A keyed service must see the verb the desk checked: no override header, and no query key PHP or Graph would read as one.
        if (Object.keys(init.headers ?? {}).some(name => /method-override/i.test(name) || /^x-http-method$/i.test(name))) return refuse(method, url, "a tool may not override the HTTP method.");
        // PHP also takes `_method[0]` as the variable `_method`, so the part before the first `[` counts too.
        if ([...url.searchParams.keys()].some(key => [key, key.split("[")[0]].some(name => METHOD_PARAMS.includes(name.replace(/[ .[]/g, "_").toLowerCase())))) return refuse(method, url, "a tool may not override the HTTP method.");
      }
      for (const [param, chars] of Object.entries(connection.forbidQueryChars ?? {})) {
        if (url.searchParams.getAll(param).some(value => [...chars].some(char => value.includes(char)))) return refuse(method, url, `the ${param} parameter may not contain ${[...chars].join(" ")}.`);
      }
      // A rule matches when method, path, query and JSON body fit and every `{name}` is this connection's identifier
      // or a resource the client owns. Read rules are checked the same way as write rules.
      const body = init.body;
      const bodyText = typeof body === "string" ? body : body === undefined ? "" : new TextDecoder().decode(body);
      const ruleAllows = async (rules: RequestRule[] | undefined) => {
        for (const rule of rules ?? []) {
          const bindings = matchRule(rule, method, url, bodyText);
          if (!bindings) continue;
          let ok = true;
          for (const [name, value] of bindings) {
            // A declared identifier must equal its value (unset: no match); anything else must be owned.
            if (connection.ids?.[name] ? idValue(name) !== value : !await turn.owns(name, value)) { ok = false; break; }
          }
          if (ok) return true;
        }
        return false;
      };
      // Before any rule or approval: a request to the path a body policy covers must pass its check, whoever allowed it.
      const policy = connection.bodyPolicy ? BODY_POLICIES[connection.bodyPolicy] : undefined;
      const governed = policy && !READ_METHODS.has(method) && await ruleAllows([policy.rule]) ? policy : undefined;
      const broken = governed?.check(bodyText, method, url);
      if (broken) return refuse(method, url, `this request breaks the ${connection.bodyPolicy} policy: ${broken}`);
      if (READ_METHODS.has(method)) {
        // A keyed connection reads only the paths it declares, scoped to its own identifiers / owned resources.
        if (connection.auth && !await ruleAllows(connection.gets)) return refuse(method, url, `this path is not readable on the ${id} connection.`);
      } else if (!await ruleAllows(connection.reads)) {
        if (connection.access !== "write") return refuse(method, url, `the ${id} connection is read-only.`);
        if (policy && !governed) return refuse(method, url, `the ${id} connection is ${policy.only}`);
        // The body stays as the bytes the tool gave: a fingerprint of decoded text would let different bytes look the same.
        const planned: PlannedRequest = { connection: id, method, url: url.toString(), body };
        if (turn.planning) {
          turn.planning.push(planned);
          await turn.log({ agent: turn.agentId, tool: turn.toolName, actionId: turn.actionId, connection: id, method, host: url.host, path: url.pathname, outcome: "planned" });
          // A plan is recorded, not sent: the tool sees an empty success and must not rely on its body.
          return new Response(null, { status: 204 });
        }
        let allowed = false;
        if (turn.approved) {
          // An approved action sends only what was approved: no fallback to the connection's write rules.
          const print = await writeFingerprint(planned);
          const left = turn.approved.get(print) ?? 0;
          if (left > 0) { turn.approved.set(print, left - 1); allowed = true; }
          if (!allowed) return refuse(method, url, "this request is not the one a person approved.");
        } else {
          allowed = await ruleAllows(connection.writes);
        }
        if (!allowed) return refuse(method, url, `this write is not allowed on the ${id} connection without a person's approval.`);
      }

      const headers = new Headers(init.headers);
      for (const [name, template] of Object.entries(connection.headers ?? {})) {
        const ref = template.match(/^\{([a-zA-Z]+)\}$/);
        const value = ref ? idValue(ref[1]) : template;
        if (value !== undefined) headers.set(name, value);
      }
      const auth = connection.auth;
      if (auth) {
        const values = authNames(connection).map(name => turn.env(name)!);
        values.forEach(value => turn.used.add(value));
        if (auth.type === "bearer") headers.set("authorization", `Bearer ${values[0]}`);
        else if (auth.type === "header") headers.set(auth.name, `${auth.prefix ?? ""}${values[0]}`);
        else if (auth.type === "query") url.searchParams.set(auth.param, values[0]);
        else if (auth.type === "basic") headers.set("authorization", `Basic ${btoa(`${values[0]}:${values[1]}`)}`);
        else {
          const token = await googleToken(turn, connection, auth);
          turn.used.add(token);
          headers.set("authorization", `Bearer ${token}`);
        }
      }
      let response: Response;
      try {
        // Never let fetch follow redirects: a hop could leave the allowed host or account with the credential attached.
        response = await fetch(url, { method, headers, body, redirect: "manual", signal: turn.signal });
      } catch (error) {
        await turn.log({ agent: turn.agentId, tool: turn.toolName, actionId: turn.actionId, connection: id, method, host: url.host, path: url.pathname, outcome: "sent", reason: "no answer" });
        throw error;
      }
      await turn.log({ agent: turn.agentId, tool: turn.toolName, actionId: turn.actionId, connection: id, method, host: url.host, path: url.pathname, outcome: "sent", status: response.status });
      const location = response.headers.get("location");
      if (init.redirect !== "manual" && READ_METHODS.has(method) && response.status >= 300 && response.status < 400 && location) {
        if (hops >= MAX_REDIRECTS) throw new ToolError("Not followed: too many redirects.", true);
        return send(new URL(location, raw).toString(), { ...init, method }, hops + 1);
      }
      return response;
  }

  return {
    missing,
    id(name) {
      const value = idValue(name);
      if (value === undefined) throw new SafeConfigurationError(`The ${id} connection has no ${name} set (${connection.ids?.[name] ?? name}).`);
      return value;
    },
    optionalId: idValue,
    fetch: (raw, init = {}) => send(raw, init),
  };
}

/** Replaces every credential value in `text` (also in its JSON-escaped form) with [REDACTED]. */
export function redactText(text: string, secrets: Set<string>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length <= 3) continue;
    for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1)])) out = out.split(form).join("[REDACTED]");
  }
  return out;
}

/**
 * Checks a client's connections when the config loads: unique ids, env var names only, and no env var that belongs
 * to another client (prefix `<OTHER>_`). Settings must not hold credential values.
 */
export function validateClient(client: ClientConfig, otherClientIds: string[]): void {
  const ids = new Set<string>();
  const foreign = otherClientIds.map(other => `${other.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_`);
  for (const connection of client.connections ?? []) {
    if (ids.has(connection.id)) throw new Error(`Client ${client.id} declares the connection ${connection.id} twice.`);
    ids.add(connection.id);
    if (!connection.hosts.length) throw new Error(`Connection ${connection.id} of ${client.id} has no hosts.`);
    if (connection.bodyPolicy && !Object.hasOwn(BODY_POLICIES, connection.bodyPolicy)) throw new Error(`Connection ${connection.id} of ${client.id} names the unknown body policy ${connection.bodyPolicy}.`);
    for (const name of [...authNames(connection), ...Object.values(connection.ids ?? {})]) {
      if (!ENV_NAME.test(name)) throw new Error(`Connection ${connection.id} of ${client.id} must name env vars, not values (${name.slice(0, 4)}…).`);
      if (foreign.some(prefix => name.startsWith(prefix))) throw new Error(`Connection ${connection.id} of ${client.id} uses another client's secret ${name}.`);
    }
    for (const agent of connection.agents) {
      if (!client.agents.includes(agent)) throw new Error(`Connection ${connection.id} of ${client.id} names ${agent}, who is not one of its agents.`);
    }
  }
  const credentialKey = /^(api_?key|access_?token|refresh_?token|password|authorization|private_?key|client_?secret|secret|token)$/i;
  for (const [agent, settings] of Object.entries(client.agentSettings ?? {})) {
    for (const [key, value] of Object.entries(settings)) {
      if (credentialKey.test(key) && typeof value === "string" && value !== "") throw new Error(`Setting ${key} of ${agent} (${client.id}) looks like a credential; keep credentials in secrets.`);
    }
  }
}
