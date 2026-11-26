import { DurableObject } from "cloudflare:workers";

// One lead store per client: what the contact forms of the sites an agent built for it have sent. A site's own lead route
// posts each lead here with that site's key (src/lead-routes.ts); it is saved under an id and kept here. Nothing is passed
// on: the leads are hosted here (since 2026-11-19, when passing them on to the relay stopped) and the agents app lists,
// exports and shares them. Leads hold people's contact details: nothing here is ever logged but ids, counts and statuses.

/** A site's name: the same shape as a lowercase repo or project name. */
export const SITE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const MAX_FIELDS = 40;
const MAX_VALUE = 2_000;
/** The most leads one read returns. */
export const MAX_PAGE = 500;
/** The most requests the same phone and email fold into one lead; the next one starts a new lead. */
const MAX_FOLD = 20;
/** How long a share link may last, in days. */
export const SHARE_DAYS = [7, 30, 90];
/** The store takes no more leads past this size (a Durable Object's SQLite holds 10 GB): a spammed form must not fill it. */
const MAX_STORE_BYTES = 2 * 1024 ** 3;

/** What the store reads from the Worker's env. Both set: sites may be pointed at the intake. */
export interface LeadsEnv {
  /** Signs each site's intake key. */
  LEADS_SIGNING_KEY?: unknown;
  /** This Worker's own public address, for the intake address a site is given. */
  BRAIN_URL?: unknown;
}

/**
 * What became of a lead after it was saved. kept: hosted here, passed on nowhere (every form lead since passing leads on
 * stopped, and the ones still waiting then). none: added by hand, or saved while there was nowhere to pass it on to.
 * sent, failed: passed on to the relay, or given up on, before that.
 */
export type Forward = "kept" | "none" | "sent" | "failed";
/**
 * What became of a lead handed to the store. saved: kept here. repeat: this id was saved before (the form sent it twice,
 * or a person deleted it since), so nothing more is done. full: not saved.
 */
export type Saved = "saved" | "repeat" | "full";
/** A lead as the intake hands it over: `fields` to show and search. */
export interface NewLead { id: string; site: string; page: string; fields: Record<string, string> }
export interface LeadRequest { id: string; site: string; page: string; receivedAt: number; fields: Record<string, string>; forward: Forward; source: string; manual: boolean }
/** `similar`: another lead of the same site that shares only the phone or only the email, with its newest request's answers so a person can tell who it is before merging (never who on the staff added it). */
export interface Lead extends LeadRequest { requests: LeadRequest[]; similar: { id: string; receivedAt: number; match: "phone" | "email"; fields: Record<string, string> }[] }
export interface ManualLead { site: string; name: string; email?: string; phone?: string; source?: string; note?: string; addedBy: string }
export interface SiteLeads { site: string; leads: number; latest: number }
export interface ShareState { createdBy: string; createdAt: number; expiresAt: number }
export interface LeadQuery { site?: string; search?: string; source?: string; since?: number; until?: number; duplicates?: boolean; before?: string; limit?: number }

type LeadRow = { id: string; site: string; page: string; received_at: number; fields: string; forward: Forward; source: string; manual: number; lead_id: string };
const requestOf = (row: LeadRow): LeadRequest => ({
  id: row.id, site: row.site, page: row.page, receivedAt: row.received_at, fields: JSON.parse(row.fields) as Record<string, string>,
  forward: row.forward, source: row.source, manual: Boolean(row.manual),
});
// What a search looks through: the answers, not the form's key, and not who on the staff added a lead (a share link's
// holder searches too, and must not be able to find that name letter by letter).
const searchOf = (fields: Record<string, string>) => Object.entries(fields).filter(([name]) => name !== "idempotency_key" && name !== "added_by").map(([, value]) => value).join("\n").toLowerCase();

interface LeadKeys { phone: string; email: string; source: string }
/** The same contact and source rules for old rows, form intake and hand-added leads. */
export function leadKeys(fields: Record<string, string>): LeadKeys {
  const entries = Object.entries(fields).map(([name, value]) => [name.toLowerCase().replace(/[-_]/g, ""), value] as const);
  const first = (names: string[]) => entries.find(([name, value]) => names.includes(name) && value.trim())?.[1].trim() ?? "";
  const digits = first(["phone", "phonenumber", "tel", "telephone", "mobile", "cell"]).replace(/\D/g, "");
  const email = first(["email", "emailaddress", "youremail"]).toLowerCase();
  const packed = entries.map(([, value]) => /Lead source:[ \t]*([^|\r\n]*)/i.exec(value)?.[1].trim()).find(Boolean) ?? "";
  return {
    phone: digits.length >= 7 ? digits.slice(-10) : "",
    email: email.includes("@") ? email : "",
    source: (first(["source", "leadsource", "utmsource"]) || packed || first(["hearabout", "howdidyouhear", "howdidyouhearaboutus", "referral"])).slice(0, 80),
  };
}

// Compare every request, not just the newest: a manual merge may bring different contact details together.
const SIMILAR = `SELECT other.lead_id FROM leads own JOIN leads other ON other.site = own.site AND other.lead_id != own.lead_id
  AND ((own.phone_key != '' AND other.phone_key = own.phone_key) OR (own.email_key != '' AND other.email_key = own.email_key))
  WHERE own.lead_id = l.lead_id`;
const DUPLICATE = `(EXISTS (SELECT 1 FROM leads folded WHERE folded.lead_id = l.lead_id AND folded.id != l.id) OR EXISTS (${SIMILAR}))`;

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
export const sha256 = async (text: string): Promise<string> => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
const https = (value: unknown): string | undefined => typeof value === "string" && /^https:\/\/[^\s]+$/.test(value) ? value.replace(/\/$/, "") : undefined;

/**
 * A site's intake key: an HMAC of the client and site under the brain's leads key, so it needs no table, cannot be used for
 * another site or client, and the brain's key never leaves the brain.
 */
export async function siteKey(signingKey: unknown, clientId: string, site: string): Promise<string | undefined> {
  // Too short to be a key (or not set): the intake is off.
  const secret = typeof signingKey === "string" && signingKey.length >= 32 ? signingKey : undefined;
  if (!secret) return undefined;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`lead-intake\n${clientId}\n${site}`)));
}

/** Text as it is kept: control characters become spaces, the ends are trimmed. */
export const cleanText = (value: string): string => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim();

/**
 * What a form sent, as text fields: at most 40 named fields of at most 2,000 characters each, control characters removed.
 * The hidden spam field is dropped. Undefined when it is not an object with at least one filled field.
 */
export function cleanFields(body: unknown): Record<string, string> | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const fields: Record<string, string> = {};
  for (const [name, value] of Object.entries(body)) {
    if (Object.keys(fields).length >= MAX_FIELDS) break;
    if (!FIELD.test(name) || name === "company_website" || !["string", "number", "boolean"].includes(typeof value)) continue;
    const text = cleanText(String(value)).slice(0, MAX_VALUE);
    if (text) fields[name] = text;
  }
  return Object.keys(fields).some(name => name !== "site" && name !== "idempotency_key") ? fields : undefined;
}

export class Leads extends DurableObject<LeadsEnv> {
  private readonly sql = this.ctx.storage.sql;
  /** This Worker's own address, for the intake address a site is given. Test seam: tests switch the intake off by clearing it. */
  brainUrl = https(this.env.BRAIN_URL);
  /** Test seam: the size past which no more leads are taken. */
  maxBytes = MAX_STORE_BYTES;

  constructor(ctx: DurableObjectState, env: LeadsEnv) {
    super(ctx, env);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS leads (id TEXT PRIMARY KEY, site TEXT NOT NULL, page TEXT NOT NULL, received_at INTEGER NOT NULL,
      fields TEXT NOT NULL, search TEXT NOT NULL, raw TEXT, forward TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0, next_try_at INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS leads_by_time ON leads (received_at DESC, id DESC)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS leads_by_site ON leads (site, received_at DESC, id DESC)");
    const columns = new Set(this.sql.exec<{ name: string }>("PRAGMA table_info(leads)").toArray().map(column => column.name));
    for (const [name, type] of Object.entries({ source: "TEXT NOT NULL DEFAULT ''", phone_key: "TEXT NOT NULL DEFAULT ''", email_key: "TEXT NOT NULL DEFAULT ''", manual: "INTEGER NOT NULL DEFAULT 0", lead_id: "TEXT NOT NULL DEFAULT ''" })) {
      if (!columns.has(name)) this.sql.exec(`ALTER TABLE leads ADD COLUMN ${name} ${type}`);
    }
    this.sql.exec("CREATE INDEX IF NOT EXISTS leads_by_group ON leads (lead_id, received_at DESC, id DESC)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS leads_by_phone ON leads (site, phone_key, email_key, received_at, id)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS leads_by_email ON leads (site, email_key, received_at, id)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS leads_by_source ON leads (site, source)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS leads_to_backfill ON leads (received_at, id) WHERE lead_id = ''");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, site TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, revoked_at INTEGER)`);
    // The form requests a person deleted: a form that sends one of them again must not bring it back.
    this.sql.exec("CREATE TABLE IF NOT EXISTS deleted (id TEXT PRIMARY KEY, forward TEXT NOT NULL, deleted_at INTEGER NOT NULL)");
    // Leads still waiting to be passed on when that stopped stay here, kept like every new one.
    this.sql.exec("UPDATE leads SET forward = 'kept', raw = NULL WHERE forward = 'pending'");
    this.backfill();
  }

  /**
   * Gives the requests saved before leads had sources and duplicates their keys and their lead, oldest first. A row with
   * no lead yet (`lead_id = ''`) is unfinished, so a later start repeats nothing and never undoes a merge.
   * shortcut: runs whole in the constructor; only stores from before this change hold such rows. Do it in batches if a store with tens of thousands of old rows ever turns up.
   */
  private backfill(): void {
    this.ctx.storage.transactionSync(() => {
      for (const row of this.sql.exec<{ id: string; site: string; fields: string }>("SELECT id, site, fields FROM leads WHERE lead_id = '' ORDER BY received_at, id").toArray()) {
        const keys = leadKeys(JSON.parse(row.fields) as Record<string, string>);
        this.sql.exec("UPDATE leads SET source = ?, phone_key = ?, email_key = ?, lead_id = ? WHERE id = ?", keys.source, keys.phone, keys.email, this.groupFor(row.site, keys) ?? row.id, row.id);
      }
    });
  }

  /**
   * The lead a request with this phone and email joins: the newest such lead that has room. Past MAX_FOLD requests a new
   * lead starts, because every read returns a lead whole and a form sent over and over must not grow one without end.
   */
  private groupFor(site: string, keys: LeadKeys): string | undefined {
    if (!keys.phone || !keys.email) return undefined;
    return this.sql.exec<{ lead_id: string }>(`SELECT l.lead_id FROM leads l WHERE l.site = ? AND l.phone_key = ? AND l.email_key = ? AND l.lead_id != ''
      AND (SELECT COUNT(*) FROM leads g WHERE g.lead_id = l.lead_id) < ${MAX_FOLD} ORDER BY l.received_at DESC, l.id DESC LIMIT 1`, site, keys.phone, keys.email).toArray()[0]?.lead_id;
  }
  /** Whether new sites can send leads here: the brain has its own address and a key to sign site keys with. */
  async intakeEnabled(): Promise<boolean> {
    return Boolean(this.brainUrl && typeof this.env.LEADS_SIGNING_KEY === "string" && this.env.LEADS_SIGNING_KEY.length >= 32);
  }

  /** The intake address and key a new site is given, or nothing while the brain is not set up to take leads. */
  async intakeFor(clientId: string, site: string): Promise<{ url: string; auth: string } | undefined> {
    if (!await this.intakeEnabled()) return undefined;
    const auth = SITE.test(site) ? await siteKey(this.env.LEADS_SIGNING_KEY, clientId, site) : undefined;
    return auth ? { url: `${this.brainUrl}/v1/leads/in/${clientId}/${site}`, auth } : undefined;
  }

  /** Saves one lead to keep here. A form sent again, or one a person has deleted since, is answered as already taken care of. */
  async add(lead: NewLead, now = Date.now()): Promise<Saved> {
    if (this.sql.exec("SELECT 1 FROM leads WHERE id = ?1 UNION ALL SELECT 1 FROM deleted WHERE id = ?1", lead.id).toArray().length) return "repeat";
    if (this.sql.databaseSize > this.maxBytes) return "full";
    // `search`: the values a person may look for, without the field names (a search for "email" must not match every lead).
    const keys = leadKeys(lead.fields);
    this.sql.exec("INSERT INTO leads (id, site, page, received_at, fields, search, forward, source, phone_key, email_key, lead_id) VALUES (?, ?, ?, ?, ?, ?, 'kept', ?, ?, ?, ?)",
      lead.id, lead.site, lead.page, now, JSON.stringify(lead.fields), searchOf(lead.fields), keys.source, keys.phone, keys.email, this.groupFor(lead.site, keys) ?? lead.id);
    return "saved";
  }

  /** A separate id space from the intake's 32 hexadecimal characters. */
  async addManual(lead: ManualLead, now = Date.now()): Promise<Lead | undefined> {
    if (this.sql.databaseSize > this.maxBytes) return undefined;
    const id = `manual-${crypto.randomUUID()}`;
    const fields = Object.fromEntries(Object.entries({ name: lead.name, email: lead.email, phone: lead.phone, source: lead.source, message: lead.note, added_by: lead.addedBy }).filter((entry): entry is [string, string] => Boolean(entry[1])));
    const keys = leadKeys(fields);
    const group = this.groupFor(lead.site, keys) ?? id;
    this.sql.exec("INSERT INTO leads (id, site, page, received_at, fields, search, forward, source, phone_key, email_key, manual, lead_id) VALUES (?, ?, '', ?, ?, ?, 'none', ?, ?, ?, 1, ?)",
      id, lead.site, now, JSON.stringify(fields), searchOf(fields), keys.source, keys.phone, keys.email, group);
    return this.readGroup(group);
  }

  /** An alarm a store set while it still passed leads on ends here: nothing is sent any more. */
  async alarm(): Promise<void> {}

  /** Filters select matching requests, but pagination and answers always keep each lead whole. */
  async list(query: LeadQuery = {}): Promise<{ leads: Lead[]; sources: string[]; duplicates: number; next?: string }> {
    const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(query.limit ?? 100)));
    const [beforeAt, beforeId] = /^\d{1,15}:[A-Za-z0-9-]{1,80}$/.test(query.before ?? "") ? [Number(query.before!.split(":")[0]), query.before!.split(":")[1]] : [0, ""];
    // `instr`, not LIKE: a Durable Object's SQLite refuses a LIKE pattern over 50 bytes, and an email address is longer.
    const rows = this.sql.exec<{ id: string; lead_id: string; received_at: number }>(
      `WITH matching AS (
        SELECT l.id, l.lead_id, l.received_at, ROW_NUMBER() OVER (PARTITION BY l.lead_id ORDER BY l.received_at DESC, l.id DESC) AS rank
        FROM leads l WHERE (?1 = '' OR l.site = ?1) AND (?2 = '' OR instr(l.search, ?2) > 0)
        AND (?3 IS NULL OR l.source = ?3) AND (?4 IS NULL OR l.received_at >= ?4) AND (?9 IS NULL OR l.received_at < ?9) AND (?5 = 0 OR ${DUPLICATE})
      ) SELECT id, lead_id, received_at FROM matching WHERE rank = 1
        AND (?6 = 0 OR received_at < ?6 OR (received_at = ?6 AND id < ?7))
        ORDER BY received_at DESC, id DESC LIMIT ?8`,
      query.site ?? "", query.search?.trim().toLowerCase() ?? "", query.source ?? null, query.since ?? null,
      query.duplicates ? 1 : 0, beforeAt, beforeId, limit + 1, query.until ?? null).toArray();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const sources = this.sql.exec<{ source: string }>("SELECT DISTINCT source FROM leads WHERE (? = '' OR site = ?) AND source != '' ORDER BY source LIMIT 50", query.site ?? "", query.site ?? "").toArray().map(row => row.source);
    const duplicates = this.sql.exec<{ count: number }>(`SELECT COUNT(DISTINCT l.lead_id) AS count FROM leads l WHERE (? = '' OR l.site = ?) AND ${DUPLICATE}`, query.site ?? "", query.site ?? "").one().count;
    return {
      leads: page.map(row => this.readGroup(row.lead_id)),
      sources, duplicates,
      ...(rows.length > limit && last ? { next: `${last.received_at}:${last.id}` } : {}),
    };
  }

  private readGroup(group: string): Lead {
    const rows = this.sql.exec<LeadRow>("SELECT * FROM leads WHERE lead_id = ? ORDER BY received_at DESC, id DESC", group).toArray();
    const similar = this.sql.exec<{ id: string; received_at: number; match: "phone" | "email"; fields: string }>(
      `WITH matches AS (
        SELECT other.lead_id, MIN(CASE WHEN own.phone_key != '' AND own.phone_key = other.phone_key THEN 'phone' ELSE 'email' END) AS match
        FROM leads own JOIN leads other ON other.site = own.site AND other.lead_id != own.lead_id
        AND ((own.phone_key != '' AND own.phone_key = other.phone_key) OR (own.email_key != '' AND own.email_key = other.email_key))
        WHERE own.lead_id = ? GROUP BY other.lead_id
      ) SELECT l.id, l.received_at, matches.match, l.fields FROM matches JOIN leads l ON l.lead_id = matches.lead_id
        WHERE NOT EXISTS (SELECT 1 FROM leads newer WHERE newer.lead_id = l.lead_id AND (newer.received_at > l.received_at OR (newer.received_at = l.received_at AND newer.id > l.id)))
        ORDER BY l.received_at DESC, l.id DESC LIMIT 5`, group).toArray();
    return {
      ...requestOf(rows[0]), requests: rows.slice(1).map(requestOf),
      similar: similar.map(row => ({ id: row.id, receivedAt: row.received_at, match: row.match, fields: Object.fromEntries(Object.entries(JSON.parse(row.fields) as Record<string, string>).filter(([name]) => name !== "added_by")) })),
    };
  }

  /** Every site that has leads, the one with the newest lead first. */
  async sites(): Promise<SiteLeads[]> {
    return this.sql.exec<{ site: string; leads: number; latest: number }>("SELECT site, COUNT(DISTINCT lead_id) AS leads, MAX(received_at) AS latest FROM leads GROUP BY site ORDER BY latest DESC").toArray();
  }

  /** Only current lead ids are accepted: an older folded request is not another table row. */
  private groups(ids: string[]): { lead_id: string; site: string }[] {
    return this.sql.exec<{ lead_id: string; site: string }>(`SELECT l.lead_id, l.site FROM leads l WHERE l.id IN (${ids.map(() => "?").join(",")})
      AND NOT EXISTS (SELECT 1 FROM leads newer WHERE newer.lead_id = l.lead_id AND (newer.received_at > l.received_at OR (newer.received_at = l.received_at AND newer.id > l.id)))`, ...ids).toArray();
  }

  /** Removes whole leads from this store. Their form requests are remembered, so a form that sends one again does not bring it back. */
  async delete(ids: string[]): Promise<{ deleted: number }> {
    return this.ctx.storage.transactionSync(() => {
      const groups = this.groups(ids).map(group => group.lead_id);
      if (!groups.length) return { deleted: 0 };
      const marks = groups.map(() => "?").join(",");
      // shortcut: these ids are kept for good (one short row per deleted form request); prune by `deleted_at` if that ever matters.
      this.sql.exec(`INSERT OR REPLACE INTO deleted (id, forward, deleted_at) SELECT id, forward, ? FROM leads WHERE manual = 0 AND lead_id IN (${marks})`, Date.now(), ...groups);
      return { deleted: this.sql.exec(`DELETE FROM leads WHERE lead_id IN (${marks})`, ...groups).rowsWritten };
    });
  }

  async merge(ids: string[]): Promise<{ merged: number } | { error: string }> {
    return this.ctx.storage.transactionSync(() => {
      const groups = this.groups(ids);
      if (groups.length !== ids.length) return { error: "Some of these leads no longer exist. Reload and try again." };
      if (groups.some(group => group.site !== groups[0].site)) return { error: "Only leads of the same website can be merged." };
      for (const group of groups.slice(1)) this.sql.exec("UPDATE leads SET lead_id = ? WHERE lead_id = ?", groups[0].lead_id, group.lead_id);
      return { merged: this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM leads WHERE lead_id = ?", groups[0].lead_id).one().count };
    });
  }

  /**
   * Makes the one view-only link of a site (any earlier one stops working) and returns its secret, which is not kept: only
   * its hash is, so a copy of this object's storage opens nothing.
   */
  async createShare(site: string, by: string, days: number, now = Date.now()): Promise<{ secret: string; expiresAt: number }> {
    const secret = hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
    const expiresAt = now + days * 86_400_000;
    await this.revokeShares(site, now);
    this.sql.exec("INSERT INTO shares (id, site, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)", await sha256(secret), site, by, now, expiresAt);
    return { secret, expiresAt };
  }

  /** Turns a site's link off. Returns whether there was one. */
  async revokeShares(site: string, now = Date.now()): Promise<boolean> {
    return this.sql.exec("UPDATE shares SET revoked_at = ? WHERE site = ? AND revoked_at IS NULL AND expires_at > ?", now, site, now).rowsWritten > 0;
  }

  /** The site's working link, if it has one: who made it and until when. Never the link itself. */
  async share(site: string, now = Date.now()): Promise<ShareState | undefined> {
    const row = this.sql.exec<{ created_by: string; created_at: number; expires_at: number }>(
      "SELECT created_by, created_at, expires_at FROM shares WHERE site = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1", site, now).toArray()[0];
    return row && { createdBy: row.created_by, createdAt: row.created_at, expiresAt: row.expires_at };
  }

  /** The site a link's secret opens, while the link works. */
  async shared(secret: string, now = Date.now()): Promise<{ site: string; expiresAt: number } | undefined> {
    const row = this.sql.exec<{ site: string; expires_at: number }>("SELECT site, expires_at FROM shares WHERE id = ? AND revoked_at IS NULL AND expires_at > ?", await sha256(secret), now).toArray()[0];
    return row && { site: row.site, expiresAt: row.expires_at };
  }
}
