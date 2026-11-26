import { CLIENTS } from "../clients";
import type { ClientConfig } from "./contracts";
import type { Env } from "./conversation";
import { cleanFields, cleanText, type LeadQuery, type ManualLead, SHARE_DAYS, sha256, SITE, siteKey } from "./leads";

// The lead store's HTTP side (src/leads.ts): the intake a site's own lead route posts to, and what the agents app reads.

/** The tool that points a new site at the intake. The approvers of an agent that has it may share that client's leads. */
export const LEADS_TOOL = "vercel_create_project";
const MAX_BODY = 20_000;

const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const store = (env: Env, clientId: string) => env.LEADS.get(env.LEADS.idFromName(clientId));

/** The request's body as text, or nothing when it is over `max` bytes: read no further than that, whatever was announced. */
async function bodyUpTo(request: Request, max: number): Promise<string | undefined> {
  if (Number(request.headers.get("content-length") ?? 0) > max) return undefined;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const text = new TextDecoder();
  let out = "", size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out + text.decode();
    size += value.byteLength;
    if (size > max) { void reader.cancel().catch(() => undefined); return undefined; }
    out += text.decode(value, { stream: true });
  }
}

/**
 * POST /v1/leads/in/<client>/<site>: one lead from that site's own lead route, with the site's key as its Authorization
 * (the key alone or after "Bearer "; the site template drops a header value that has a space). No client token: a site
 * holds nothing but its own key, which adds leads to its own list and reads nothing. Saved under the form's idempotency
 * key, so a form sent twice is one lead.
 *
 * 200 when the lead is kept here, now or from an earlier send; 507 when the store is full (not saved). The site's own
 * route tells the visitor the form did not send on any answer but 200.
 */
export async function leadIntake(request: Request, env: Env, clientId: string, site: string): Promise<Response> {
  // An unknown client, a name that is no site's, an intake that is not set up and a wrong key all answer the same.
  const expected = CLIENTS.some(client => client.id === clientId) && SITE.test(site) ? await siteKey(env.LEADS_SIGNING_KEY, clientId, site) : undefined;
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  // Digests of both, so the comparison takes the same time whatever was sent.
  const digest = async (value: string) => new TextEncoder().encode(await sha256(value));
  const same = crypto.subtle.timingSafeEqual(await digest(given), await digest(expected ?? crypto.randomUUID()));
  if (!expected || !same) return json({ error: "Unauthorized" }, 401);
  if (!(await env.LEAD_INTAKE_LIMITER.limit({ key: `${clientId}/${site}` })).success) return json({ error: "Too many requests" }, 429);

  const raw = await bodyUpTo(request, MAX_BODY);
  if (raw === undefined) return json({ error: "The lead is too large." }, 413);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return json({ error: "The lead must be JSON." }, 400); }
  const fields = cleanFields(body);
  if (!fields) return json({ error: "A lead needs at least one filled field." }, 400);
  // Listed under the site the key was made for, whatever the form calls itself.
  delete fields.site;
  const key = fields.idempotency_key ?? "";
  const id = /^[A-Za-z0-9_.:-]{8,80}$/.test(key) ? (await sha256(`${site}\n${key}`)).slice(0, 32) : crypto.randomUUID().replaceAll("-", "");
  const saved = await store(env, clientId).add({ id, site, page: (fields.referring_url ?? fields.page ?? "").slice(0, 300), fields });
  // Ids and counts only: a lead is a person's contact details.
  console.log(JSON.stringify({ event: "lead_received", client: clientId, site, saved }));
  if (saved === "full") return json({ error: "The lead store is full." }, 507);
  return json({ ok: true, id });
}

/** A read's filter, from its JSON body: a search holds a person's name or address, which must not sit in a URL (and so in request logs). */
async function queryOf(request: Request): Promise<LeadQuery> {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const text = (value: unknown) => typeof value === "string" ? value : "";
  const limit = Number(body?.limit);
  return {
    ...(SITE.test(text(body?.site)) ? { site: text(body?.site) } : {}),
    search: text(body?.search).slice(0, 100),
    before: text(body?.before) || undefined,
    ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
    // A blank source is "not given", never "only leads without a source".
    ...(typeof body?.source === "string" && body.source.trim() ? { source: body.source.trim().slice(0, 80) } : {}),
    ...(typeof body?.since === "number" && Number.isSafeInteger(body.since) && body.since >= 0 ? { since: body.since } : {}),
    ...(typeof body?.until === "number" && Number.isSafeInteger(body.until) && body.until >= 0 ? { until: body.until } : {}),
    duplicates: body?.duplicates === true,
  };
}

/**
 * For a signed-in person of the client (index.ts checks the pass and, for writes, the site-building approver permission):
 * POST /v1/leads/search lists whole leads; add, delete and merge change only this store.
 * GET /v1/leads/shares?site= reads the link; POST makes its one link; DELETE turns it off.
 */
export async function leadsRoute(request: Request, env: Env, client: ClientConfig, url: URL, userId: string): Promise<Response> {
  const leads = store(env, client.id);
  if (url.pathname === "/v1/leads/search" && request.method === "POST") return json({ sites: await leads.sites(), ...await leads.list(await queryOf(request)) });
  if (["/v1/leads/add", "/v1/leads/delete", "/v1/leads/merge"].includes(url.pathname)) {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const raw = await bodyUpTo(request, MAX_BODY);
    if (raw === undefined) return json({ error: "The request is too large." }, 400);
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return json({ error: "The request must be JSON." }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Send an object with the lead details." }, 400);
    const values = body as Record<string, unknown>;
    if (url.pathname === "/v1/leads/add") {
      const limits: Record<string, number> = { site: 63, name: 120, email: 200, phone: 40, source: 80, note: 2000, addedBy: 120 };
      for (const [name, value] of Object.entries(values)) {
        if (!Object.hasOwn(limits, name) || typeof value !== "string") return json({ error: "Lead details must be text in the supported fields." }, 400);
        if (value.length > limits[name]) return json({ error: `${name === "addedBy" ? "Added by" : name[0].toUpperCase() + name.slice(1)} is too long (at most ${limits[name]} characters).` }, 400);
      }
      if (typeof values.site !== "string" || !SITE.test(values.site)) return json({ error: "Choose a valid website name." }, 400);
      if (typeof values.name !== "string" || !values.name.trim()) return json({ error: "Enter a name." }, 400);
      if (typeof values.addedBy !== "string" || !values.addedBy.trim()) return json({ error: "Include the name of the person adding the lead." }, 400);
      if (!(typeof values.email === "string" && values.email.trim()) && !(typeof values.phone === "string" && values.phone.trim())) return json({ error: "Enter an email address or phone number." }, 400);
      if (typeof values.email === "string" && values.email.trim() && !values.email.includes("@")) return json({ error: "Enter an email address containing @." }, 400);
      const lead = await leads.addManual(Object.fromEntries(Object.entries(values).map(([name, value]) => [name, cleanText(value as string)])) as unknown as ManualLead);
      console.log(JSON.stringify({ event: "lead_added", client: client.id, by: userId, id: lead?.id, status: lead ? "saved" : "full" }));
      return lead ? json({ lead }) : json({ error: "The lead store is full." }, 507);
    }
    const merging = url.pathname === "/v1/leads/merge";
    const ids = values.ids;
    if (Object.keys(values).some(name => name !== "ids") || !Array.isArray(ids) || ids.length < (merging ? 2 : 1) || ids.length > (merging ? 20 : 100) ||
        ids.some(value => typeof value !== "string" || !/^(?:[0-9a-f]{32}|manual-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(value)) || new Set(ids).size !== ids.length) {
      return json({ error: merging ? "Choose 2 to 20 different lead ids." : "Choose 1 to 100 different lead ids." }, 400);
    }
    if (merging) {
      const result = await leads.merge(ids as string[]);
      console.log(JSON.stringify({ event: "leads_merged", client: client.id, by: userId, ids, count: "merged" in result ? result.merged : 0, status: "error" in result ? "refused" : "merged" }));
      return json(result, "error" in result ? 400 : 200);
    }
    const result = await leads.delete(ids as string[]);
    console.log(JSON.stringify({ event: "leads_deleted", client: client.id, by: userId, ids, count: result.deleted }));
    return json(result);
  }
  if (url.pathname !== "/v1/leads/shares") return json({ error: "Not found" }, 404);
  if (request.method === "POST") {
    const body = await request.json().catch(() => null) as { site?: unknown; days?: unknown } | null;
    const site = typeof body?.site === "string" ? body.site : "";
    const days = Number(body?.days);
    if (!SITE.test(site)) return json({ error: "Choose the site to share." }, 400);
    if (!SHARE_DAYS.includes(days)) return json({ error: `A link lasts ${SHARE_DAYS.join(", ")} days.` }, 400);
    const share = await leads.createShare(site, userId, days);
    console.log(JSON.stringify({ event: "leads_share_created", client: client.id, site, days }));
    // The client's id leads the token, so the agents app knows whose brain to ask without a lookup of its own.
    return json({ site, token: `${client.id}.${share.secret}`, expiresAt: share.expiresAt });
  }
  const site = url.searchParams.get("site") ?? "";
  if (!SITE.test(site)) return json({ error: "Choose the site." }, 400);
  if (request.method === "DELETE") {
    const removed = await leads.revokeShares(site);
    console.log(JSON.stringify({ event: "leads_share_removed", client: client.id, site, removed }));
    return json({ removed });
  }
  if (request.method === "GET") return json({ site, share: await leads.share(site) ?? null });
  return json({ error: "Method not allowed" }, 405);
}

/**
 * POST /v1/leads/shared {search?, source?, since?, duplicates?, before?, limit?} with the link's secret in `x-share-token`: the leads of the one site
 * that link opens, for the agents app's view-only page. No person: the link is the permission, while it lasts.
 */
export async function sharedLeads(request: Request, env: Env, client: ClientConfig): Promise<Response> {
  const secret = request.headers.get("x-share-token") ?? "";
  const leads = store(env, client.id);
  const share = /^[0-9a-f]{64}$/.test(secret) ? await leads.shared(secret) : undefined;
  if (!share) return json({ error: "This link no longer works." }, 404);
  const page = await leads.list({ ...await queryOf(request), site: share.site });
  // Who on the staff added a lead by hand is not for the link's holder.
  const unsigned = <T extends { manual: boolean; fields: Record<string, string> }>(request: T): T =>
    request.manual ? { ...request, fields: Object.fromEntries(Object.entries(request.fields).filter(([name]) => name !== "added_by")) } : request;
  return json({ site: share.site, expiresAt: share.expiresAt, ...page, leads: page.leads.map(lead => ({ ...unsigned(lead), requests: lead.requests.map(unsigned) })) });
}
