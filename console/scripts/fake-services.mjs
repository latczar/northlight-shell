// Fake agent + Supabase Auth + PostgREST for local runs and screenshots. Never talks to a real service; every key is a fake value
// from scripts/fake.env. Start: `node scripts/fake-services.mjs` (127.0.0.1:54339, or FAKE_PORT), then `node scripts/fake-app.mjs start -p 3310 -H 127.0.0.1`.
// Env: FAKE_APP_URL (default http://127.0.0.1:3310), FAKE_JOB_STEP_MS (default 1500), FAKE_LOG=1 prints each request line (never bodies).
// Auth and REST follow supabase/migrations/20261124000000_agent_access.sql; /v1/* follows the agent (src/index.ts, src/access.ts).
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { parseEnv } from "node:util";
import { AGENTS, buildWorld, isReady } from "./fake-world.mjs";

const PORT = Number(process.env.FAKE_PORT ?? 54339);
const APP = process.env.FAKE_APP_URL ?? "http://127.0.0.1:3310";
const JOB_STEP_MS = Number(process.env.FAKE_JOB_STEP_MS ?? 1500);
const LOG = process.env.FAKE_LOG === "1";
const ENV = parseEnv(readFileSync(new URL("./fake.env", import.meta.url), "utf8"));
const ANON_KEY = ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY, SERVICE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY;
const START = Date.now();

// ---- Helpers
const hmac = (key, text) => createHmac("sha256", key).update(text).digest("hex");
const b64 = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const nowSeconds = () => Math.floor(Date.now() / 1000);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
const empty = (res, status = 204) => { res.writeHead(status); res.end(); };
async function readRaw(req) { let raw = ""; for await (const chunk of req) raw += chunk; return raw; }
async function readJson(req) { try { return JSON.parse((await readRaw(req)) || "null"); } catch { return null; } }
const bearer = req => { const header = req.headers.authorization ?? ""; return header.startsWith("Bearer ") ? header.slice(7) : ""; };

/** The person behind a pass (agent/src/user-auth.ts verifyUserPass), or undefined. */
function verifyPass(key, clientId, pass, purpose) {
  const parts = typeof pass === "string" ? pass.split(".") : [];
  if (parts.length !== 3) return undefined;
  const [person, expiry, sig] = parts;
  const exp = Number(expiry), now = nowSeconds();
  if (!/^[A-Za-z0-9_:-]{1,128}$/.test(person) || !/^\d{1,12}$/.test(expiry) || !(exp > now) || exp > now + 86_400 || !/^[0-9a-f]{64}$/.test(sig)) return undefined;
  return same(sig, hmac(key, `${purpose ? `${purpose}\n` : ""}${clientId}\n${person}\n${exp}`)) ? person : undefined;
}

// ---- People: fake Supabase users. Accounts created through the admin API are added to the same list.
const SEED = [
  ["admin", "00000000-0000-4000-8000-000000000001", "admin@northlight.example", "Northlight Admin", "111111"],
  ["manager", "00000000-0000-4000-8000-000000000002", "alex@kestrel.example", "Alex Morgan", "222222"],
  ["viewer", "00000000-0000-4000-8000-000000000003", "jamie@kestrel.example", "Jamie Ford", "333333"],
  ["stranger", "00000000-0000-4000-8000-000000000004", "someone@else.example", "Someone Else", "444444"],
];
// names an admin gave live in app metadata, as addPerson writes them; a person cannot change those
const USERS = SEED.map(([key, id, email, name, code]) => ({ key, id, email, meta: {}, app: { full_name: name }, code, createdAt: START, confirmedAt: START }));
const user = key => USERS.find(u => u.key === key);
const userById = id => USERS.find(u => u.id === id);
const userByEmail = email => typeof email === "string" ? USERS.find(u => u.email.toLowerCase() === email.toLowerCase()) : undefined;
const iso = ms => new Date(ms).toISOString();
const userJson = u => ({ id: u.id, aud: "authenticated", role: "authenticated", email: u.email, email_confirmed_at: u.confirmedAt ? iso(u.confirmedAt) : null, user_metadata: u.meta, app_metadata: u.app, created_at: iso(u.createdAt) });

// ---- Supabase Auth (the endpoints supabase-js and @supabase/ssr use). The JWT carries a fake signature, so getClaims() falls back to GET /user.
function session(u) {
  const exp = nowSeconds() + 3600;
  const payload = { sub: u.id, email: u.email, iat: nowSeconds(), exp, role: "authenticated", aud: "authenticated", user_metadata: u.meta, app_metadata: u.app };
  return { access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.fake`, refresh_token: `fake-refresh-${u.id}`, token_type: "bearer", expires_in: 3600, expires_at: exp, user: userJson(u) };
}
function userFromToken(token) {
  const [, payload, sig] = token.split(".");
  if (sig !== "fake") return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    return claims.exp > nowSeconds() ? userById(claims.sub) : undefined;
  } catch { return undefined; }
}
const authError = (res, status, error_code, msg) => json(res, status, { code: status, error_code, msg });

async function auth(req, res, url) {
  const path = url.pathname.slice("/auth/v1".length);
  const post = req.method === "POST";
  if (req.method === "GET" && path === "/user") {
    const u = userFromToken(bearer(req));
    return u ? json(res, 200, userJson(u)) : authError(res, 401, "bad_jwt", "invalid JWT");
  }
  if (post && path === "/otp") {
    const u = userByEmail((await readJson(req))?.email);
    if (!u) return authError(res, 422, "otp_disabled", "Signups not allowed for otp");
    console.log(`[fake auth] code for ${u.email}: ${u.code}`);
    return json(res, 200, {});
  }
  if (post && path === "/verify") {
    const body = await readJson(req);
    if (typeof body?.token_hash === "string") {
      const u = /^fake-hash-(.+)$/.test(body.token_hash) ? userById(body.token_hash.slice("fake-hash-".length)) : undefined;
      if (u) return json(res, 200, session(u));
    } else if (body?.type === "email" || body?.type === "magiclink") {
      const u = userByEmail(body.email);
      if (u && typeof body.token === "string" && same(body.token, u.code)) return json(res, 200, session(u));
    }
    return authError(res, 403, "otp_expired", "Token has expired or is invalid");
  }
  if (post && path === "/token") {
    const u = url.searchParams.get("grant_type") === "refresh_token" ? userById(String((await readJson(req))?.refresh_token ?? "").replace(/^fake-refresh-/, "")) : undefined;
    return u ? json(res, 200, session(u)) : authError(res, 400, "refresh_token_not_found", "Invalid Refresh Token");
  }
  if (post && path === "/logout") return empty(res);
  if (path.startsWith("/admin/users")) {
    if (bearer(req) !== SERVICE_KEY) return json(res, 401, { msg: "Invalid service key" });
    if (post && path === "/admin/users") {
      const body = await readJson(req);
      if (typeof body?.email !== "string" || !/^[^@\s]+@[^@\s]+$/.test(body.email)) return authError(res, 422, "email_address_invalid", "Unable to validate email address: invalid format");
      if (userByEmail(body.email)) return authError(res, 422, "email_exists", "A user with this email address has already been registered");
      const u = { id: randomUUID(), email: body.email, meta: body.user_metadata ?? {}, app: body.app_metadata ?? {}, code: "123456", createdAt: Date.now(), confirmedAt: body.email_confirm ? Date.now() : null };
      USERS.push(u);
      return json(res, 200, userJson(u));
    }
    const found = req.method === "GET" && path.startsWith("/admin/users/") ? userById(decodeURIComponent(path.slice("/admin/users/".length))) : undefined;
    return found ? json(res, 200, userJson(found)) : authError(res, 404, "user_not_found", "User not found");
  }
  return json(res, 404, { msg: "not found" });
}

// ---- PostgREST: public.agent_access and the RPC functions of the migration.
const ACCESS_COLUMNS = ["user_id", "client_id", "agent_id", "can_approve", "can_manage", "revoked_at", "updated_at", "updated_by", "changed_version"];
const ACCESS = ["admin", "manager", "viewer"].map(key => ({
  user_id: user(key).id, client_id: "kestrel", agent_id: "iris", can_approve: key !== "viewer", can_manage: key !== "viewer", revoked_at: null, updated_at: iso(START), updated_by: null, changed_version: 1,
}));
let syncSequence = 1; // brain_sync_version: kestrel holds 1, the next version is 2
const SYNC = new Map([["kestrel", { wanted_version: 1, pushed_version: 1, last_error: null, updated_at: iso(START) }]]);
const pgError = (status, code, message) => Object.assign(new Error(message), { status, code });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BOOLEAN = value => value === undefined || value === null || typeof value === "boolean";

function setAgentAccess({ p_actor, p_user_id, p_client_id, p_rows, p_expected, p_add }) {
  if (p_client_id === null || !/^[a-z0-9-]{1,64}$/.test(p_client_id)) throw pgError(400, "22023", "client id must be lowercase letters, digits and -");
  if (!Array.isArray(p_rows)) throw pgError(400, "22023", "p_rows must be a JSON array");
  // e->>'agent_id': text of the value, null for anything that has none.
  const text = row => row && typeof row === "object" && !Array.isArray(row) && row.agent_id != null ? (typeof row.agent_id === "string" ? row.agent_id : JSON.stringify(row.agent_id)) : null;
  const ids = p_rows.map(text);
  if (new Set(ids.filter(id => id !== null)).size !== p_rows.length) throw pgError(400, "22023", "each employee may appear once");
  for (const row of p_rows) {
    for (const flag of [row.can_approve, row.can_manage]) if (!BOOLEAN(flag)) throw pgError(400, "22P02", `invalid input syntax for type boolean: ${JSON.stringify(flag)}`);
  }
  if (p_rows.length) {
    if (p_user_id === null) throw pgError(400, "23502", 'null value in column "user_id" of relation "agent_access" violates not-null constraint');
    if (ids.some(id => !/^[a-z0-9-]{1,32}$/.test(id))) throw pgError(400, "23514", 'new row for relation "agent_access" violates check constraint "agent_access_shape"');
    if (!userById(p_user_id)) throw pgError(409, "23503", 'insert or update on table "agent_access" violates foreign key constraint "agent_access_user_id_fkey"');
    if (p_actor !== null && !userById(p_actor)) throw pgError(409, "23503", 'insert or update on table "agent_access" violates foreign key constraint "agent_access_updated_by_fkey"');
  }
  // every write says what it saw: the page's p_expected, or p_add for someone new
  if ((p_expected === null || p_expected === undefined) && p_add !== true) throw pgError(400, "22023", "pass p_expected (what the page read) or p_add (a new person)");
  // p_add: someone being added; refused when they already have access here (checked under the lock in SQL)
  if (p_add === true && ACCESS.some(a => a.user_id === p_user_id && a.client_id === p_client_id && a.revoked_at === null)) {
    throw pgError(409, "23505", "this person already has access here");
  }
  // p_expected: the person's newest change (revoked rows too) as the page read it; any change since refuses the write
  if (p_expected !== null && p_expected !== undefined) {
    const newest = ACCESS.filter(a => a.user_id === p_user_id && a.client_id === p_client_id).map(a => Date.parse(a.updated_at)).sort((a, b) => b - a)[0];
    if (newest !== Date.parse(p_expected)) throw pgError(409, "40001", "this person's access changed since it was read");
  }
  const at = iso(Date.now());
  const next = syncSequence + 1; // the version changed rows carry, as nextval() in set_agent_access
  let changed = 0;
  for (const row of ACCESS) {
    if (row.user_id === p_user_id && row.client_id === p_client_id && row.revoked_at === null && !ids.includes(row.agent_id)) {
      Object.assign(row, { revoked_at: at, updated_at: at, updated_by: p_actor, changed_version: next });
      changed++;
    }
  }
  p_rows.forEach((row, i) => {
    const wanted = { can_approve: row.can_approve ?? false, can_manage: row.can_manage ?? false };
    const held = ACCESS.find(a => a.user_id === p_user_id && a.client_id === p_client_id && a.agent_id === ids[i]);
    if (!held) ACCESS.push({ user_id: p_user_id, client_id: p_client_id, agent_id: ids[i], ...wanted, revoked_at: null, updated_at: at, updated_by: p_actor, changed_version: next });
    else if (held.revoked_at !== null || held.can_approve !== wanted.can_approve || held.can_manage !== wanted.can_manage) Object.assign(held, wanted, { revoked_at: null, updated_at: at, updated_by: p_actor, changed_version: next });
    else return;
    changed++;
  });
  if (changed) {
    syncSequence = next;
    SYNC.set(p_client_id, { pushed_version: 0, last_error: null, ...SYNC.get(p_client_id), wanted_version: next, updated_at: at });
  }
  return { changed: changed > 0, wanted_version: SYNC.get(p_client_id)?.wanted_version ?? null };
}

const active = clientId => ACCESS.filter(a => a.client_id === clientId && a.revoked_at === null);
const byKeys = (...keys) => (a, b) => { for (const k of keys) { const order = String(a[k]).localeCompare(String(b[k])); if (order) return order; } return 0; };
// type: uuid | text | bigint | jsonb (null is always allowed, as in SQL).
const RPC = {
  access_user_id_for_email: { args: { p_email: "text" }, run: ({ p_email }) => userByEmail(p_email)?.id ?? null },
  set_agent_access: { args: { p_actor: "uuid", p_user_id: "uuid", p_client_id: "text", p_rows: "jsonb", p_expected: "timestamptz", p_add: "boolean" }, run: setAgentAccess },
  access_pending: { args: { p_user_id: "uuid", p_client_id: "text" }, run: ({ p_user_id, p_client_id }) => {
    const sync = SYNC.get(p_client_id);
    return !!sync && ACCESS.some(a => a.user_id === p_user_id && a.client_id === p_client_id && a.changed_version > sync.pushed_version);
  } },
  access_push_state: { args: { p_client_id: "text" }, run: ({ p_client_id }) => {
    const sync = SYNC.get(p_client_id);
    const rows = active(p_client_id).filter(a => a.can_approve || a.can_manage).sort(byKeys("agent_id", "user_id"))
      .map(({ user_id, agent_id, can_approve, can_manage }) => ({ user_id, agent_id, can_approve, can_manage }));
    return sync ? { wanted_version: sync.wanted_version, pushed_version: sync.pushed_version, last_error: sync.last_error, updated_at: sync.updated_at, rows } : null;
  } },
  access_push_done: { args: { p_client_id: "text", p_version: "bigint" }, run: ({ p_client_id, p_version }) => {
    const sync = SYNC.get(p_client_id);
    if (sync) Object.assign(sync, { pushed_version: Math.max(sync.pushed_version, Number(p_version)), last_error: null, updated_at: iso(Date.now()) });
  } },
  access_push_failed: { args: { p_client_id: "text", p_error: "text" }, run: ({ p_client_id, p_error }) => {
    const sync = SYNC.get(p_client_id);
    if (sync && sync.pushed_version < sync.wanted_version) Object.assign(sync, { last_error: p_error === null ? null : p_error.slice(0, 300), updated_at: iso(Date.now()) });
  } },
  access_people: { args: { p_client_id: "text" }, run: ({ p_client_id }) => {
    const changedAt = userId => ACCESS.filter(a => a.user_id === userId && a.client_id === p_client_id).map(a => a.updated_at).sort().at(-1);
    return active(p_client_id)
      .map(a => ({ user_id: a.user_id, email: userById(a.user_id).email, full_name: userById(a.user_id).app.full_name || null, agent_id: a.agent_id, can_approve: a.can_approve, can_manage: a.can_manage, changed_at: changedAt(a.user_id) }))
      .sort((a, b) => a.email.toLowerCase().localeCompare(b.email.toLowerCase()) || a.agent_id.localeCompare(b.agent_id));
  } },
};
const TYPE_OK = { uuid: v => typeof v === "string" && UUID.test(v), text: v => typeof v === "string", bigint: v => Number.isInteger(Number(v)) && v !== "" && typeof v !== "boolean", jsonb: () => true, timestamptz: v => typeof v === "string" && !Number.isNaN(Date.parse(v)), boolean: v => typeof v === "boolean" };

async function rest(req, res, url) {
  const token = bearer(req);
  const role = token === SERVICE_KEY ? "service" : !token || token === ANON_KEY ? "anon" : userFromToken(token) ? "user" : undefined;
  if (!role) return json(res, 401, { code: "PGRST301", message: "JWT invalid" });
  const name = url.pathname.slice("/rest/v1/".length);
  if (req.method === "POST" && name.startsWith("rpc/")) {
    const fn = name.slice(4);
    if (role !== "service") return json(res, 403, { code: "42501", message: `permission denied for function ${fn}` });
    const def = Object.hasOwn(RPC, fn) ? RPC[fn] : undefined;
    const args = await readJson(req);
    if (!def || !args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).sort().join() !== Object.keys(def.args).sort().join()) {
      return json(res, 404, { code: "PGRST202", message: `Could not find the function public.${fn} in the schema cache` });
    }
    for (const [arg, type] of Object.entries(def.args)) {
      if (args[arg] !== null && !TYPE_OK[type](args[arg])) return json(res, 400, { code: "22P02", message: `invalid input syntax for type ${type}: ${JSON.stringify(args[arg])}` });
    }
    try {
      const result = def.run(args);
      return result === undefined ? empty(res) : json(res, 200, result);
    } catch (error) {
      if (!error.code) throw error;
      return json(res, error.status, { code: error.code, message: error.message });
    }
  }
  if (name !== "agent_access") return json(res, 404, { code: "PGRST205", message: `Could not find the table 'public.${name}' in the schema cache` });
  if (req.method !== "GET") return role === "service" ? json(res, 404, { message: "not found" }) : json(res, 403, { code: "42501", message: "permission denied for table agent_access" });
  if (role === "anon") return json(res, 401, { code: "42501", message: "permission denied for table agent_access" });
  let rows = role === "service" ? ACCESS : ACCESS.filter(a => a.user_id === userFromToken(token).id); // RLS: a person reads only their own rows
  for (const [column, filter] of url.searchParams) {
    if (["select", "order", "limit", "offset"].includes(column)) continue;
    const value = /^eq\.(.*)$/.exec(filter)?.[1];
    if (!ACCESS_COLUMNS.includes(column) || (filter !== "is.null" && value === undefined)) return json(res, 400, { code: "PGRST100", message: `unsupported filter ${column}=${filter}` });
    rows = rows.filter(a => filter === "is.null" ? a[column] === null : String(a[column]) === value);
  }
  const order = (url.searchParams.get("order") ?? "").split(",").filter(Boolean).map(part => part.split("."));
  rows = [...rows].sort((a, b) => { for (const [column, dir] of order) { const o = String(a[column]).localeCompare(String(b[column])); if (o) return dir === "desc" ? -o : o; } return 0; });
  const select = (url.searchParams.get("select") ?? "*").split(",").map(c => c.trim());
  const missing = select.find(c => c !== "*" && !ACCESS_COLUMNS.includes(c));
  if (missing) return json(res, 400, { code: "42703", message: `column agent_access.${missing} does not exist` });
  return json(res, 200, rows.map(a => select.includes("*") ? { ...a } : Object.fromEntries(select.map(c => [c, a[c]]))));
}

// ---- the agent
const CLIENTS = Object.fromEntries(JSON.parse(ENV.AGENT_CLIENTS).map(({ id, name }) => {
  const up = id.toUpperCase();
  const client = { id, name, agents: ["iris"], token: ENV[`BRAIN_TOKEN_${up}`], userKey: ENV[`BRAIN_USER_SIGNING_KEY_${up}`], approverKey: ENV[`BRAIN_APPROVER_SIGNING_KEY_${up}`], accessKey: ENV[`ACCESS_SIGNING_KEY_${up}`] };
  for (const key of ["token", "userKey", "approverKey", "accessKey"]) if (!(client[key]?.length >= 32)) throw new Error(`scripts/fake.env: ${id} ${key} must be at least 32 characters`);
  return [id, client];
}));
const WORLD = buildWorld(START, { admin: user("admin").id, manager: user("manager").id });
const BRAIN = {
  kestrel: { ...WORLD.kestrel, access: { version: 1, approvers: { "iris": [user("admin").id, user("manager").id] }, managers: { "iris": [user("admin").id, user("manager").id] } } },
  harbour: { ...WORLD.harbour, access: { version: 0, approvers: {}, managers: {} } },
};
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const may = (state, person, agent) => Object.entries(state.access.approvers).some(([name, people]) => (agent === null || name === agent) && people.includes(person));
const notFound = res => json(res, 404, { error: "Not found" });
const newestFirst = (list, key) => [...list].sort((a, b) => b[key] - a[key]);
const history = (state, key) => (state.history[key] ??= []);

/** Parses PUT /v1/access/approvers like agent/src/access.ts parseApprovers: the lists, or an error message. */
function parseApprovers(raw, agents) {
  let body;
  try { body = JSON.parse(raw); } catch { return "Body must be JSON."; }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "Body must be an object.";
  const { version, approvers, managers, ...extra } = body;
  if (Object.keys(extra).length) return `Unknown field: ${Object.keys(extra)[0]}.`;
  if (!Number.isSafeInteger(version) || version <= 0) return "version must be a positive whole number.";
  const lists = (name, value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return `${name} must be an object of agent id to user ids.`;
    const clean = {};
    for (const [agent, people] of Object.entries(value)) {
      if (!agents.includes(agent)) return `Unknown agent: ${agent}.`;
      if (!Array.isArray(people) || people.length > 200 || !people.every(p => typeof p === "string" && /^[A-Za-z0-9_:-]{1,128}$/.test(p))) return `${name}.${agent} must be a list of at most 200 user ids.`;
      clean[agent] = [...new Set(people)];
    }
    return clean;
  };
  const approverLists = lists("approvers", approvers);
  if (typeof approverLists === "string") return approverLists;
  const managerLists = lists("managers", managers);
  return typeof managerLists === "string" ? managerLists : { version, approvers: approverLists, managers: managerLists };
}

// POST /__fake/access-push {"down": true} makes every access send fail with 503 until {"down": false}: the failed-send case.
let accessPushDown = false;

function putApprovers(client, state, req, res, raw) {
  const timestamp = req.headers["x-access-timestamp"] ?? "", signature = req.headers["x-access-signature"] ?? "";
  const expected = `v1=${hmac(client.accessKey, `access\n${client.id}\n${timestamp}\n${createHash("sha256").update(raw).digest("hex")}`)}`;
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(Number(timestamp) - nowSeconds()) > 300 || !/^v1=[0-9a-f]{64}$/.test(signature) || !same(signature, expected)) {
    return json(res, 401, { error: "A valid access signature is required." });
  }
  if (accessPushDown) return json(res, 503, { error: "fake: access sends are switched off" });
  const parsed = parseApprovers(raw, client.agents);
  if (typeof parsed === "string") return json(res, 400, { error: parsed });
  // The real brain ignores only an older version; the same version is stored again.
  if (parsed.version < state.access.version) return json(res, 200, { applied: false });
  state.access = { version: parsed.version, approvers: parsed.approvers, managers: parsed.managers };
  return json(res, 200, { applied: true });
}

// ---- Approvals
const approvalCard = (state, id) => state.cards.find(c => c.id === `approval-${id}`);
const WAITERS = new Map(); // `${clientId}/${approval id}` -> resolve("approved" | "declined") for the job waiting on it

function fileApproval(state, approval) {
  state.approvals.push(approval);
  state.cards.push({ id: `approval-${approval.id}`, agent: approval.agent, kind: "needs_approval", title: approval.title, summary: approval.summary, data: approval.preview,
    conversationId: approval.conversationId, requestedBy: approval.requestedBy, source: approval.source, createdAt: approval.createdAt, updatedAt: approval.createdAt });
}

/** agents/iris/revisions.ts requestEditorialRevision: one child per parent, a retry returns the same one. */
function revise(state, parent) {
  if (parent.agent !== "iris" || parent.tool !== "submit_seo_copy" || parent.status !== "declined" || !parent.reason?.trim()) {
    return { status: 409, body: { error: "Decline an editorial draft with feedback before requesting a revision." } };
  }
  const conversationId = `editorial-revision/${parent.id}`;
  const existing = state.approvals.find(a => a.conversationId === conversationId && a.agent === parent.agent && a.tool === parent.tool);
  if (existing) return { status: 200, body: existing };
  const { url, field, current, proposed } = parent.preview;
  const revised = field === "title" ? "Sample revised title: Kestrel Garage | Brakes and Tyres in Milbrook"
    : "Sample revised description: Brake, suspension and tyre repair in Milbrook. Call or book online.";
  const reason = "Sample: rewritten to follow the reviewer's feedback.";
  const child = { id: `appr-rev-${randomUUID().slice(0, 8)}`, agent: parent.agent, conversationId, tool: parent.tool, title: parent.title,
    summary: `${reason} Approval records this copy for implementation.`, requestedBy: parent.requestedBy, source: parent.source,
    preview: { url, field, current, proposed: revised === proposed ? `${revised} (revised again)` : revised, reason, revisionOf: parent.id, previousProposed: proposed, reviewerFeedback: parent.reason },
    status: "pending", createdAt: Date.now() };
  fileApproval(state, child);
  return { status: 200, body: child };
}

async function approvalRoute(req, res, client, state, id) {
  const record = state.approvals.find(a => a.id === id);
  if (req.method === "GET") return record ? json(res, 200, record) : notFound(res);
  const h = req.headers;
  const adminPerson = h["x-admin-pass"] !== undefined ? verifyPass(client.approverKey, client.id, h["x-admin-pass"], "admin") : undefined;
  if (h["x-admin-pass"] !== undefined && !adminPerson && h["x-approver-pass"] === undefined) return json(res, 401, { error: "A valid admin pass is required." });
  const decidedBy = adminPerson ?? verifyPass(client.approverKey, client.id, h["x-approver-pass"] ?? "", "approve");
  if (!decidedBy) return json(res, 401, { error: "A valid approver pass is required." });
  const body = await readJson(req);
  if (body?.decision !== "approve" && body?.decision !== "decline" && body?.decision !== "revise") return json(res, 400, { error: 'decision must be "approve", "decline", or "revise"' });
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  if (!record) return notFound(res);
  if (!adminPerson && !(record.requestedBy === decidedBy && may(state, decidedBy, record.agent))) {
    return json(res, 403, { error: "Only the person who asked, or an admin, can decide this request." });
  }
  if (body.decision === "revise") {
    const { status, body: reply } = revise(state, record);
    return json(res, status, reply);
  }
  const approve = body.decision === "approve";
  if (record.status === "pending") {
    Object.assign(record, { status: approve ? "done" : "declined", decidedBy, reason, decidedAt: Date.now() });
    if (approve) record.result = { ...record.preview, status: "approved_for_implementation" };
    const card = approvalCard(state, id);
    if (card) Object.assign(card, { kind: "status", title: `${approve ? "Done" : "Declined"}: ${record.title}`.slice(0, 120), updatedAt: Date.now() });
    WAITERS.get(`${client.id}/${id}`)?.(approve ? "approved" : "declined");
    WAITERS.delete(`${client.id}/${id}`);
  }
  return json(res, (record.status === "declined") === approve ? 409 : 200, record);
}

// ---- Lessons (src/index.ts lessonsRoute, src/learning.ts applyDecision)
async function lessonDecision(req, res, client, state, id) {
  const person = verifyPass(client.approverKey, client.id, req.headers["x-approver-pass"] ?? "", "approve");
  if (!person) return json(res, 401, { error: "A valid approver pass is required." });
  const body = await readJson(req);
  if (body?.decision !== "approve" && body?.decision !== "remove") return json(res, 400, { error: 'decision must be "approve" or "remove"' });
  const lesson = state.lessons.find(l => l.id === id);
  if (!lesson) return notFound(res);
  if (!may(state, person, lesson.agent)) return json(res, 403, { error: "This person may not approve for this agent." });
  const decided = { decidedBy: person, decidedAt: Date.now() };
  if (body.decision === "approve") {
    if (lesson.status === "removed") return json(res, 409, { error: "This lesson was removed." });
    if (lesson.status === "proposed") {
      Object.assign(lesson, { status: "active", ...decided });
      const replaced = state.lessons.find(l => l.id === lesson.replaces && l.status === "active");
      if (replaced) Object.assign(replaced, { status: "removed", ...decided });
    }
  } else if (lesson.status !== "removed") Object.assign(lesson, { status: "removed", ...decided });
  return json(res, 200, { lesson });
}

// ---- Background jobs: a stand-in for the brain's job contract. A message becomes a job whose steps tick along (FAKE_JOB_STEP_MS each).
// At the second step Iris files a real pending approval and the job waits for its decision; then it finishes with a plain line.
const JOB_STEPS = ["Checking page metadata", "Submitting SEO copy for review", "Writing up what I did"];
const MAX_QUEUED = 10;
const CONVERSATIONS = new Map(); // `${clientId}/${agent}/${conversation}` -> { latest, queue, seen }
const running = job => job && !["done", "failed", "stopped"].includes(job.status);

/** Saves the person's line and starts the job, or queues it behind the running one. The same message id gets the same answer. */
function submitJob(ctx, conv, message) {
  const known = conv.seen.get(message.id);
  if (known) return known.queued && running(conv.latest) ? { job: { ...conv.latest, queued: conv.queue.length }, queued: true } : { job: known.job ?? conv.latest };
  if (running(conv.latest) && conv.queue.length >= MAX_QUEUED) throw pgError(429, "", "Too many messages are waiting behind the running job.");
  const entry = { job: null, queued: false };
  conv.seen.set(message.id, entry);
  ctx.lines.push({ seq: ctx.lines.length + 1, role: "user", text: message.text });
  if (running(conv.latest)) {
    entry.queued = true;
    conv.queue.push({ ...message, entry });
    return { job: { ...conv.latest, queued: conv.queue.length }, queued: true };
  }
  return { job: launchJob(ctx, conv, { ...message, entry }) };
}

function launchJob(ctx, conv, message) {
  const now = Date.now();
  const job = { id: message.id, status: "running", startedAt: now, updatedAt: now, steps: JOB_STEPS.map(label => ({ label, state: "pending" })), current: null, queued: conv.queue.length };
  conv.latest = job;
  message.entry.job = job;
  message.entry.queued = false;
  runJob(ctx, conv, job, message).catch(error => console.error(error));
  return job;
}

async function runJob(ctx, conv, job, message) {
  const touch = change => Object.assign(job, change, { updatedAt: Date.now(), queued: conv.queue.length });
  const finish = (status, text, error) => {
    touch({ status, finishedAt: Date.now(), current: null, ...(error && { error }) });
    ctx.lines.push({ seq: ctx.lines.length + 1, role: "assistant", text });
    const next = conv.queue.shift();
    if (next) launchJob(ctx, conv, next);
  };
  let outcome;
  for (let i = 0; i < JOB_STEPS.length; i++) {
    job.steps.forEach((step, n) => { step.state = n < i ? "done" : n === i ? "active" : "pending"; });
    touch({ current: JOB_STEPS[i], status: i === 1 ? "needs_approval" : "running" });
    if (i === 1) {
      const now = Date.now();
      const approval = { id: `act-${job.id}`, agent: ctx.agent, conversationId: `web-${ctx.person}`, tool: "submit_seo_copy", title: "Review page description",
        summary: "Sample: the description does not mention a phone call to action. Approval records this copy for implementation.",
        requestedBy: ctx.person, source: "app", status: "pending", createdAt: now,
        preview: { url: "https://kestrel-garage.example/", field: "description", current: "Sample current description: Auto repair you can trust.",
          proposed: "Sample proposed description: Auto repair you can trust in Milbrook. Call us for a free quote.", reason: "Sample: adds a clear next step." } };
      fileApproval(ctx.state, approval);
      outcome = await new Promise(resolve => WAITERS.set(`${ctx.clientId}/${approval.id}`, resolve));
      touch({ status: "running" });
    } else {
      await sleep(JOB_STEP_MS);
      if (i === 0 && /fail/i.test(message.text)) {
        job.steps[0].state = "failed";
        const line = "I hit a problem: The page could not be read. Ask me to try again.";
        return finish("failed", line, line); // the brain's job `error` is the chat line (src/conversation.ts endJob)
      }
    }
  }
  job.steps.forEach(step => { step.state = "done"; });
  finish("done", outcome === "approved"
    ? "All done. The new homepage description was approved, so the wording is recorded for implementation."
    : "The new homepage description was declined, so I left the page wording as it is.");
}

// ---- Routes
const PANEL = /^\/v1\/agents\/([a-z0-9-]+)\/(setup|data|settings)$/;
const CONVERSATION = /^\/v1\/agents\/([a-z0-9-]+)\/conversations\/([A-Za-z0-9_.:-]{1,128})\/(messages|jobs?)$/;
const userPass = (req, client) => verifyPass(client.userKey, client.id, req.headers["x-user-pass"] ?? "");

async function brain(req, res, url) {
  const path = url.pathname;
  if (path === "/health") return json(res, 200, { ok: true });
  if (req.method === "POST" && path === "/__fake/access-push") {
    accessPushDown = (await readJson(req))?.down === true;
    return json(res, 200, { down: accessPushDown });
  }
  const accessPush = req.method === "PUT" && path === "/v1/access/approvers";
  if (req.method !== "POST" && req.method !== "GET" && !accessPush && !(req.method === "PUT" && PANEL.test(path))) return json(res, 405, { error: "Method not allowed" });
  const token = bearer(req);
  const client = Object.values(CLIENTS).find(c => token && same(token, c.token));
  if (!client) return json(res, 401, { error: "Unauthorized" });
  const state = BRAIN[client.id];
  const callDraft = /^\/v1\/agents\/iris\/calls\/(conv_[A-Za-z0-9_-]+)\/services-draft$/.exec(path);
  if (callDraft) {
    const person = userPass(req,client);
    if (!person || !(state.access.managers["iris"] || []).includes(person)) return json(res,403,{});
    const sourceCall = callDraft[1], conversationId = "call-editorial/"+person+"/"+sourceCall;
    const body = req.method === "POST" ? await readJson(req) : null;
    let original = state.approvals.find(a => a.conversationId === conversationId);
    if (!original && req.method === "POST") {
      if (!/services/i.test(body?.remarks || "")) return json(res,400,{});
      original = {id:"call-"+randomUUID(),requestedBy:person,agent:"iris",conversationId,tool:"submit_seo_copy",
        source:"app",status:"pending",createdAt:Date.now(),title:"Review Services title",summary:"A title for staff review.",
        preview:{url:"https://kestrel-garage.example/services/",field:"title",sourceCall,current:"Services",proposed:"Services and Brake Repair at Kestrel Garage",reason:"Name the service in the title."}};
      fileApproval(state,original);
    }
    if (!original) return json(res,200,{state:"new"});
    let latest = original;
    while (latest.status === "declined") {
      const child = state.approvals.find(a => a.conversationId === "editorial-revision/"+latest.id);
      if (!child) break;
      latest = child;
    }
    return json(res,200,{state:"ready",original,latest});
  }
  const pending = agent => state.approvals.filter(a => a.status === "pending" && a.agent === agent).length;

  if (req.method === "GET" && path === "/v1/agents") {
    return json(res, 200, { agents: client.agents.map(id => {
      const latest = newestFirst(state.cards.filter(c => c.agent === id), "updatedAt")[0];
      const toReview = pending(id);
      // The brain calls an agent active for 24 hours after its newest card, and that card's time is its last activity.
      return { id, ...AGENTS[id], status: toReview ? "needs_approval" : latest && Date.now() - latest.updatedAt < 24 * 3600_000 ? "active" : "idle",
        toReview, lastActive: latest?.updatedAt ?? null, latest: latest ? { title: latest.title, kind: latest.kind, at: latest.updatedAt } : null };
    }) });
  }
  if (req.method === "GET" && path === "/v1/dashboard") return json(res, 200, { cards: newestFirst(state.cards, "updatedAt").slice(0, 100) });
  if (req.method === "GET" && path === "/v1/approvals") {
    const status = url.searchParams.get("status");
    return json(res, 200, { approvals: newestFirst(state.approvals.filter(a => !status || a.status === status), "createdAt").slice(0, 200) });
  }
  if (accessPush) return putApprovers(client, state, req, res, await readRaw(req));
  const approval = /^\/v1\/approvals\/([A-Za-z0-9_.:-]{1,128})$/.exec(path);
  if (approval) return approvalRoute(req, res, client, state, approval[1]);

  const lessons = /^\/v1\/agents\/([a-z0-9-]+)\/lessons$/.exec(path);
  if (req.method === "GET" && lessons) {
    if (!AGENTS[lessons[1]] || !client.agents.includes(lessons[1])) return notFound(res);
    const mine = state.lessons.filter(l => (l.status === "proposed" || l.status === "active") && (l.agent === null || l.agent === lessons[1]));
    return json(res, 200, { lessons: [...newestFirst(mine.filter(l => l.status === "proposed"), "createdAt"), ...newestFirst(mine.filter(l => l.status === "active"), "createdAt")] });
  }
  const lesson = /^\/v1\/lessons\/([A-Za-z0-9_.:-]{1,128})$/.exec(path);
  if (req.method === "POST" && lesson) return lessonDecision(req, res, client, state, lesson[1]);

  const panel = PANEL.exec(path);
  if (panel) {
    const [, agent, what] = panel;
    if (!AGENTS[agent] || !client.agents.includes(agent)) return notFound(res);
    if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
    if (what === "setup") return json(res, 200, { agent, ready: isReady(state.setup), items: state.setup });
    if (what === "data") return json(res, 200, { agent, snapshots: state.snapshots });
    return json(res, 200, { agent, settings: {}, editable: [] });
  }

  const conversation = CONVERSATION.exec(path);
  if (!conversation || !AGENTS[conversation[1]] || !client.agents.includes(conversation[1])) return notFound(res);
  const [, agent, conversationId, sub] = conversation;
  const person = userPass(req, client);
  if (!person) return json(res, 401, { error: "Invalid or expired user pass." });
  const own = conversationId === `web-${person}`; // history and job state are readable only by the person the conversation belongs to
  const key = `${client.id}/${agent}/${conversationId}`;

  if (req.method === "GET" && sub === "messages") {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100) || 100, 1), 500);
    const before = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : undefined;
    if (before !== undefined && !(Number.isInteger(before) && before > 0)) return json(res, 400, { error: "before must be a message seq" });
    if (!own) return notFound(res);
    const older = history(state, conversationId).filter(line => before === undefined || line.seq < before);
    return json(res, 200, { messages: older.slice(-limit), more: older.length > limit });
  }
  if (req.method === "GET" && sub === "job") {
    if (!own) return notFound(res);
    const job = CONVERSATIONS.get(key)?.latest;
    return json(res, 200, { job: job ? { ...job, queued: CONVERSATIONS.get(key).queue.length } : null });
  }
  if (req.method === "POST" && sub === "jobs") {
    const body = await readJson(req);
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text || text.length > 8000) return json(res, 400, { error: "text is required (max 8000 characters)" });
    if (typeof body.id !== "string" || !ID.test(body.id)) return json(res, 400, { error: "id is required and must match [A-Za-z0-9_.:-]{1,128}" });
    if (!own) return json(res, 409, { error: "This conversation id or message id is already used for another person or message." });
    if (!CONVERSATIONS.has(key)) CONVERSATIONS.set(key, { latest: null, queue: [], seen: new Map() });
    try {
      return json(res, 202, submitJob({ agent, state, person, clientId: client.id, lines: history(state, conversationId) }, CONVERSATIONS.get(key), { id: body.id, text }));
    } catch (error) {
      if (error.status !== 429) throw error;
      return json(res, 429, { error: error.message });
    }
  }
  return notFound(res);
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://fake");
  if (LOG) console.log(`[fake] ${req.method} ${url.pathname}${url.search}`);
  const supabase = url.pathname.startsWith("/auth/v1/") || url.pathname.startsWith("/rest/v1/");
  if (supabase) { // supabase-js in a browser calls these directly
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "authorization, apikey, content-type, x-client-info, prefer, accept-profile, content-profile");
    res.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    if (req.method === "OPTIONS") return empty(res);
  }
  const handler = url.pathname.startsWith("/auth/v1/") ? auth : url.pathname.startsWith("/rest/v1/") ? rest : brain;
  handler(req, res, url).catch(error => { console.error(error); if (!res.headersSent) json(res, 500, { error: "fake failed" }); });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`[fake] agent + Supabase auth + PostgREST on http://127.0.0.1:${server.address().port} (app expected at ${APP})`);
  for (const u of USERS) console.log(`[fake] sign in as ${u.key}: ${u.email}, code ${u.code}`);
});
