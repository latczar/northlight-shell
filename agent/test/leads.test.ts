import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signAccess } from "../src/access";
import { cleanFields, leadKeys, Leads, type Lead, type LeadQuery, type NewLead, siteKey } from "../src/leads";
import { signUserPass } from "../src/user-auth";

// Its own file so its requests count against fresh per-minute limits. The intake, the list and the share links all go
// through the Worker: who may do what is decided in its entry. Nothing is passed on: the store keeps every lead.

const token = { authorization: "Bearer test-token-acme-0123456789abcdef", "content-type": "application/json" };
const now = () => Math.floor(Date.now() / 1000);
const userPass = (who: string) => signUserPass("test-signing-key-acme-0123456789abcdef", "acme", who, now() + 3600);
const approverPass = (who: string) => signUserPass("test-approver-key-acme-0123456789abcdef", "acme", who, now() + 3600, "approve");
const id = () => crypto.randomUUID().replaceAll("-", "");
/** A site of this test's own: the store is shared by the tests of this file. */
const siteName = () => `s${id().slice(0, 12)}`;
const keyOf = async (site: string, client = "acme") => (await siteKey("test-leads-signing-key-0123456789abcdef", client, site))!;
const newLead = (leadId: string, site: string, fields: Record<string, string>, page = "/"): NewLead => ({ id: leadId, site, page, fields });
/** The test limiter counts by wall-clock minute: a loop that must fall inside one first waits out a minute about to end. */
async function insideOneMinute() {
  const left = 60_000 - Date.now() % 60_000;
  if (left < 8_000) await new Promise(resolve => setTimeout(resolve, left + 50));
}

/** What a site's own lead route does: POST the lead with the site's key. */
async function send(site: string, lead: Record<string, unknown>, authorization?: string, client = "acme") {
  return SELF.fetch(`https://brain/v1/leads/in/${client}/${site}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: authorization ?? await keyOf(site, client) }, body: JSON.stringify(lead),
  });
}

/** What the agents app does for a signed-in person: the filter goes in the body, never in the address. */
async function list(who: string, query: LeadQuery = {}) {
  const response = await SELF.fetch("https://brain/v1/leads/search", { method: "POST", headers: { ...token, "x-user-pass": await userPass(who) }, body: JSON.stringify(query) });
  expect(response.status).toBe(200);
  return await response.json() as { sites: { site: string; leads: number }[]; sources: string[]; duplicates: number; leads: Lead[]; next?: string };
}

/** What the agents app does: a signed PUT of who may approve for each agent. */
async function approvers(lists: Record<string, string[]>) {
  const body = JSON.stringify({ version: Date.now(), approvers: lists, managers: {} });
  const timestamp = String(now());
  const pushed = await SELF.fetch("https://brain/v1/access/approvers", {
    method: "PUT", body, headers: { ...token, "x-access-timestamp": timestamp, "x-access-signature": await signAccess("test-access-key-acme-0123456789abcdef", "acme", timestamp, body) },
  });
  expect(pushed.status).toBe(200);
}

async function share(method: "POST" | "DELETE" | "GET", site: string, who: string, approving?: string, days = 30) {
  return SELF.fetch(`https://brain/v1/leads/shares${method === "POST" ? "" : `?site=${site}`}`, {
    method, headers: { ...token, "x-user-pass": await userPass(who), ...(approving ? { "x-approver-pass": await approverPass(approving) } : {}) },
    ...(method === "POST" ? { body: JSON.stringify({ site, days }) } : {}),
  });
}
/** What the agents app's view-only page does with a link's secret. */
const shared = (secret: string, query: LeadQuery = {}) =>
  SELF.fetch("https://brain/v1/leads/shared", { method: "POST", headers: { ...token, "x-share-token": secret }, body: JSON.stringify(query) });

describe("the lead intake", () => {
  it.each([
    { overrides: {}, enabled: true },
    { overrides: { BRAIN_URL: "http://brain.test" }, enabled: false },
    { overrides: { LEADS_SIGNING_KEY: "short" }, enabled: false },
  ])("uses the same readiness condition for setup and a site's intake: %j", async ({ overrides, enabled }) => {
    const stub = env.LEADS.get(env.LEADS.idFromName(`readiness-${id()}`));
    await runInDurableObject(stub, async (_instance, state) => {
      const leads = new Leads(state, { BRAIN_URL: "https://brain.test", LEADS_SIGNING_KEY: "k".repeat(32), ...overrides });
      expect(await leads.intakeEnabled()).toBe(enabled);
      expect(Boolean(await leads.intakeFor("acme", "real-site"))).toBe(enabled);
    });
  });

  it("saves a site's lead for that site, whatever the form calls itself, and keeps it here: nothing is passed on", async () => {
    const site = siteName();
    // The body of the site template's lead route: its own `site` word, a real boolean, empty fields.
    const body = { site: "Acme Test Co hail repair", first_name: "Casey", last_name: "Rowe", email: "casey@example.com", phone: "(555) 555-0142", city: "", roof_concerns: "Hail hit us last week.", sms_consent: true, referring_url: "/contact", idempotency_key: `site-${id()}` };
    const response = await send(site, body);
    expect(response.status).toBe(200);
    const saved = await response.json() as { ok: boolean; id: string };
    expect(saved.ok).toBe(true);

    const { leads, sites } = await list("alex", { site });
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ id: saved.id, site, page: "/contact", forward: "kept" });
    expect(leads[0].fields).toMatchObject({ first_name: "Casey", last_name: "Rowe", email: "casey@example.com", phone: "(555) 555-0142", roof_concerns: "Hail hit us last week.", sms_consent: "true" });
    expect(leads[0].fields).not.toHaveProperty("site");
    expect(leads[0].fields).not.toHaveProperty("city");
    expect(Date.now() - leads[0].receivedAt).toBeLessThan(60_000);
    expect(sites.find(entry => entry.site === site)).toMatchObject({ leads: 1 });
    // No copy of what the site sent waits to be passed on, and no alarm is set to pass anything on.
    await runInDurableObject(env.LEADS.get(env.LEADS.idFromName("acme")), async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT raw FROM leads WHERE id = ?", saved.id).one().raw).toBeNull();
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("takes the key alone or after Bearer, and refuses a wrong key, another site's, another client's, none, and an unknown client", async () => {
    const site = siteName();
    const lead = { name: "Marcus Lee", phone: "(913) 555-0177" };
    expect((await send(site, lead, `Bearer ${await keyOf(site)}`)).status).toBe(200);
    for (const wrong of ["", "0".repeat(64), await keyOf(siteName()), await keyOf(site, "beacon"), "Bearer"]) expect((await send(site, lead, wrong)).status, wrong.slice(0, 12)).toBe(401);
    expect((await send(site, lead, await keyOf(site, "nobody"), "nobody")).status).toBe(401);
    expect((await list("alex", { site })).leads).toHaveLength(1);
    // Only a POST is taken.
    expect((await SELF.fetch(`https://brain/v1/leads/in/acme/${site}`, { headers: { authorization: await keyOf(site) } })).status).toBe(405);
  });

  it("keeps a form that was sent twice as one lead", async () => {
    const site = siteName();
    const lead = { name: "Priya Raman", email: "priya@example.com", idempotency_key: `site-${id()}` };
    const first = await (await send(site, lead)).json() as { id: string };
    const second = await send(site, lead);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ id: first.id });
    // The same key from another site is another lead.
    const other = siteName();
    await send(other, lead);
    expect((await list("alex", { site })).leads).toHaveLength(1);
    expect((await list("alex", { site: other })).leads).toHaveLength(1);
  });

  it("refuses what is not a lead: not JSON, nothing filled in, or too large, however the size is announced", async () => {
    const site = siteName();
    const post = async (body: BodyInit, init: RequestInit = {}) => (await SELF.fetch(`https://brain/v1/leads/in/acme/${site}`, { method: "POST", headers: { authorization: await keyOf(site) }, body, ...init })).status;
    expect(await post("name=Casey")).toBe(400);
    expect(await post(JSON.stringify(["Casey"]))).toBe(400);
    expect(await post(JSON.stringify({ company_website: "spam.example", site, idempotency_key: "site-12345678" }))).toBe(400);
    expect(await post(JSON.stringify({ message: "x".repeat(20_001) }))).toBe(413);
    // A body sent in pieces announces no size: it is still read no further than the cap.
    const pieces = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < 30; i++) controller.enqueue(new TextEncoder().encode("x".repeat(1_000))); controller.close(); } });
    expect(await post(pieces, { duplex: "half" } as RequestInit)).toBe(413);
    expect((await list("alex", { site })).leads).toEqual([]);
  });

  it("keeps every client's leads, and answers the site with a failure only when the store is full", async () => {
    // Any client's store keeps its leads: a form sent twice is one lead, answered as taken care of both times.
    const site = siteName();
    const lead = { name: "Casey", idempotency_key: `site-${id()}` };
    const key = await keyOf(site, "beacon");
    expect((await send(site, lead, key, "beacon")).status).toBe(200);
    expect((await send(site, lead, key, "beacon")).status).toBe(200);
    await runInDurableObject(env.LEADS.get(env.LEADS.idFromName("beacon")), async instance => {
      expect((await instance.list({ site })).leads).toMatchObject([{ forward: "kept", fields: { name: "Casey" } }]);
    });

    // A store that has reached its size takes nothing more, and keeps nothing of what it refused.
    const store = env.LEADS.get(env.LEADS.idFromName("acme"));
    const refusedSite = siteName();
    await runInDurableObject(store, instance => { instance.maxBytes = 0; });
    const full = await send(refusedSite, { name: "Marcus" });
    await runInDurableObject(store, instance => { instance.maxBytes = 2 * 1024 ** 3; });
    expect(full.status).toBe(507);
    expect((await list("alex", { site: refusedSite })).leads).toEqual([]);
  });

  it("takes 30 leads a minute from one site, and no more", async () => {
    await insideOneMinute();
    const site = siteName();
    const key = await keyOf(site);
    const codes: number[] = [];
    for (let i = 0; i < 32; i++) codes.push((await send(site, { name: `Person ${i}` }, key)).status);
    expect(codes.filter(code => code === 200)).toHaveLength(30);
    expect(codes.slice(30)).toEqual([429, 429]);
    // Another site is not held back by it.
    expect((await send(siteName(), { name: "Casey" })).status).toBe(200);
  }, 30_000);

  it("keeps a lead's fields as plain capped text, whatever was sent", () => {
    const fields = cleanFields({ name: "  Casey\u0000 W  ", age: 41, ok: false, nested: { a: 1 }, list: ["x"], "bad name": "x", message: "m".repeat(5_000), empty: "   ", ...Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}`, "v"])) })!;
    expect(fields).toMatchObject({ name: "Casey  W", age: "41", ok: "false" });
    expect(fields.message).toHaveLength(2_000);
    for (const dropped of ["nested", "list", "bad name", "empty"]) expect(fields).not.toHaveProperty(dropped);
    expect(Object.keys(fields)).toHaveLength(40);
  });
});

describe("keeping leads here", () => {
  it("saves a lead once and answers the same form again as taken care of", async () => {
    const stub = env.LEADS.get(env.LEADS.idFromName(`kept-${id()}`));
    await runInDurableObject(stub, async instance => {
      expect(await instance.add(newLead("l1", "acme", { name: "Casey" }), 100)).toBe("saved");
      expect(await instance.add(newLead("l1", "acme", { name: "Changed" }), 200)).toBe("repeat");
      expect((await instance.list({ site: "acme" })).leads).toMatchObject([{ id: "l1", forward: "kept", receivedAt: 100, fields: { name: "Casey" } }]);
    });
  });

  it("keeps the leads that were still waiting to be passed on, and leaves passed-on history as it was", async () => {
    const stub = env.LEADS.get(env.LEADS.idFromName(`waiting-${id()}`));
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      for (const [rowId, forward, raw] of [["w1", "pending", '{"name":"Casey"}'], ["s1", "sent", null], ["f1", "failed", null], ["n1", "none", null]]) {
        sql.exec("INSERT INTO leads (id, site, page, received_at, fields, search, raw, forward, tries, next_try_at, lead_id) VALUES (?, 'acme', '/', 1, '{\"name\":\"Casey\"}', 'casey', ?, ?, 2, 5, ?)", rowId, raw, forward, rowId);
      }
      const restarted = new Leads(state, {});
      expect(Object.fromEntries((await restarted.list({ site: "acme" })).leads.map(lead => [lead.id, lead.forward]))).toEqual({ w1: "kept", s1: "sent", f1: "failed", n1: "none" });
      // Nothing is left waiting with a copy to pass on.
      expect(sql.exec("SELECT COUNT(*) AS n FROM leads WHERE raw IS NOT NULL").one().n).toBe(0);
    });
  });
});

describe("reading leads", () => {
  it("lists newest first, one site or all, in pages, and searches what people wrote, not the field names", async () => {
    const [one, two] = [siteName(), siteName()];
    const store = env.LEADS.get(env.LEADS.idFromName("acme"));
    const start = Date.now() + 10 * 60_000; // ahead of every other test's leads, so these are the newest of all
    const long = "christopher.montgomery-williams@a-rather-long-company-name.example";
    await runInDurableObject(store, async instance => {
      await instance.add(newLead(`${one}-a`, one, { name: "Casey Rowe", email: "casey@example.com" }), start);
      await instance.add(newLead(`${two}-b`, two, { name: "Marcus Lee", message: "The EMAIL bounced, call me." }), start + 1);
      await instance.add(newLead(`${one}-c`, one, { name: "Priya Raman", message: "100% sure about the roof_type." }, "/quote"), start + 2);
      await instance.add(newLead(`${one}-d`, one, { name: "Tom Becker", email: long }), start + 2);
    });
    const ours = (leads: Lead[]) => leads.filter(lead => lead.site === one || lead.site === two).map(lead => lead.id);

    expect(ours((await list("alex")).leads).slice(0, 4)).toEqual([`${one}-d`, `${one}-c`, `${two}-b`, `${one}-a`]);
    expect(ours((await list("alex", { site: one })).leads)).toEqual([`${one}-d`, `${one}-c`, `${one}-a`]);

    // A page may end between two leads that arrived in the same millisecond: neither is lost or shown twice.
    const pages: string[] = [];
    for (let before: string | undefined, turn = 0; turn < 5; turn++) {
      const page = await list("alex", { site: one, limit: 1, before });
      pages.push(...ours(page.leads));
      before = page.next;
      if (!before) break;
    }
    expect(pages).toEqual([`${one}-d`, `${one}-c`, `${one}-a`]);

    // "email" is a field's name on Casey's lead and a word Marcus wrote: only Marcus matches.
    expect(ours((await list("alex", { search: "email" })).leads)).toEqual([`${two}-b`]);
    expect(ours((await list("alex", { search: "RAMAN" })).leads)).toEqual([`${one}-c`]);
    // The search is for those characters, not a pattern, and may be as long as an address is.
    expect(ours((await list("alex", { search: "100%" })).leads)).toEqual([`${one}-c`]);
    expect(ours((await list("alex", { search: "roof_type" })).leads)).toEqual([`${one}-c`]);
    expect(ours((await list("alex", { site: one, search: "%" })).leads)).toEqual([`${one}-c`]);
    expect(ours((await list("alex", { search: long })).leads)).toEqual([`${one}-d`]);
  });

  it("is for a signed-in person of that client only, and never takes a search from the address", async () => {
    const site = siteName();
    await send(site, { name: "Casey Rowe" });
    const search = (headers: Record<string, string>, path = "/v1/leads/search") => SELF.fetch(`https://brain${path}`, { method: "POST", headers, body: JSON.stringify({ site }) });
    expect((await search(token)).status).toBe(401);
    expect((await search({ "x-user-pass": await userPass("alex") })).status).toBe(401);
    expect((await search({ ...token, "x-user-pass": await signUserPass("some-other-key-0123456789abcdef0123", "acme", "alex", now() + 3600) })).status).toBe(401);
    // A GET with the search in its address is not a way in.
    expect((await SELF.fetch(`https://brain/v1/leads?site=${site}&search=casey`, { headers: { ...token, "x-user-pass": await userPass("alex") } })).status).toBe(404);
  });
});


/** A write from the app, with the signed-in person's separate approval proof. */
async function change(action: "add" | "delete" | "merge", body: unknown, who = "alex", approving: string | undefined = "alex") {
  return SELF.fetch(`https://brain/v1/leads/${action}`, {
    method: "POST", headers: { ...token, "x-user-pass": await userPass(who), ...(approving ? { "x-approver-pass": await approverPass(approving) } : {}) },
    body: JSON.stringify(body),
  });
}

describe("leads across different forms", () => {
  it("derives contact keys and source without rewriting what the form sent", () => {
    expect(leadKeys({ "Phone-Number": "+1 (555) 555-0142", Your_Email: " CASEY@EXAMPLE.COM ", details: "Service: roof | Lead source: Facebook | City: Milbrook" }))
      .toEqual({ phone: "5555550142", email: "casey@example.com", source: "Facebook" });
    expect(leadKeys({ phone: "123456", email: "no address", utm_source: "  Paid search ", note: "Lead source: ignored", referral: "ignored too" }))
      .toEqual({ phone: "", email: "", source: "Paid search" });
    expect(leadKeys({ tel: "1234567", email_address: " a@b ", note: "Lead source: \nOther answer: second line", how_did_you_hear_about_us: "Friend" }))
      .toEqual({ phone: "1234567", email: "a@b", source: "Friend" });
    expect(leadKeys({ source: " ".repeat(3), lead_source: "x".repeat(100) }).source).toHaveLength(80);
    expect(leadKeys({}).source).toBe("");
  });

  it("upgrades an old table, backfills oldest first, keeps the leads that were waiting, and changes nothing on another start", async () => {
    const stub = env.LEADS.get(env.LEADS.idFromName(`legacy-${id()}`));
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP TABLE leads");
      sql.exec(`CREATE TABLE leads (id TEXT PRIMARY KEY, site TEXT NOT NULL, page TEXT NOT NULL, received_at INTEGER NOT NULL,
        fields TEXT NOT NULL, search TEXT NOT NULL, raw TEXT, forward TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0, next_try_at INTEGER NOT NULL DEFAULT 0)`);
      for (let i = 0; i < 252; i++) {
        const fields = JSON.stringify({ name: `Request ${i}`, telephone: "(555) 555-0142", email: "CASEY@example.com", details: "Lead source: Meta | Roof: flat" });
        sql.exec("INSERT INTO leads VALUES (?, 'legacy', '/', ?, ?, ?, ?, 'pending', 3, 987654)", String(i).padStart(4, "0"), i + 1000, fields, fields.toLowerCase(), `{"untouched":${i}}`);
      }
      const delivery = () => sql.exec("SELECT id, fields, raw, forward, tries, received_at, next_try_at FROM leads ORDER BY id").toArray();
      const before = delivery();
      const upgraded = new Leads(state, {});
      const result = await upgraded.list({ site: "legacy" });
      // 20 requests to a lead: the same phone and email 252 times is 12 full leads and one of 12.
      expect(result.leads).toHaveLength(13);
      expect(result.leads[0]).toMatchObject({ id: "0251", source: "Meta", manual: false });
      expect(result.leads[0].requests).toHaveLength(11);
      expect(result.leads[0].requests.at(-1)?.id).toBe("0240");
      expect(sql.exec("SELECT lead_id, COUNT(*) AS n FROM leads WHERE phone_key = '5555550142' AND email_key = 'casey@example.com' GROUP BY lead_id ORDER BY lead_id").toArray())
        .toEqual(Array.from({ length: 13 }, (_, i) => ({ lead_id: String(i * 20).padStart(4, "0"), n: i < 12 ? 20 : 12 })));
      expect((await upgraded.sites())[0].leads).toBe(13);
      const kept = before.map(row => ({ ...row, forward: "kept", raw: null }));
      expect(delivery()).toEqual(kept);
      const again = new Leads(state, {});
      expect(await again.list({ site: "legacy" })).toEqual(result);
      expect(delivery()).toEqual(kept);
    });
  });

  it("folds only a full contact match, flags single-key matches in both directions, and keeps intake's old answers", async () => {
    const stub = env.LEADS.get(env.LEADS.idFromName(`fold-${id()}`));
    await runInDurableObject(stub, async instance => {
      const site = siteName();
      expect(await instance.add(newLead("first", site, { phone: "5555550142", email: "casey@example.com", name: "First" }), 100)).toBe("saved");
      expect(await instance.add(newLead("second", site, { mobile: "+1 (555) 555-0142", email_address: "CASEY@example.com", name: "Second" }), 200)).toBe("saved");
      expect(await instance.add(newLead("second", site, { name: "Ignored" }), 999)).toBe("repeat");
      await instance.add(newLead("phone", site, { phone: "5555550142", email: "someone@else.test" }), 300);
      await instance.add(newLead("email", site, { phone: "9135550177", email: "casey@example.com" }), 400);
      await instance.add(newLead("other-site", siteName(), { phone: "5555550142", email: "casey@example.com" }), 500);
      const result = await instance.list({ site });
      expect(result.leads.map(lead => lead.id)).toEqual(["email", "phone", "second"]);
      expect(result.duplicates).toBe(3);
      expect(result.leads[2].requests.map(request => request.id)).toEqual(["first"]);
      // Each carries its newest answers, so a person can tell who it is before merging.
      expect(result.leads[2].similar).toEqual([
        { id: "email", receivedAt: 400, match: "email", fields: { phone: "9135550177", email: "casey@example.com" } },
        { id: "phone", receivedAt: 300, match: "phone", fields: { phone: "5555550142", email: "someone@else.test" } },
      ]);
      expect(result.leads[0].similar).toContainEqual({ id: "second", receivedAt: 200, match: "email", fields: { mobile: "+1 (555) 555-0142", email_address: "CASEY@example.com", name: "Second" } });
      expect(result.leads[1].similar).toContainEqual({ id: "second", receivedAt: 200, match: "phone", fields: { mobile: "+1 (555) 555-0142", email_address: "CASEY@example.com", name: "Second" } });
      expect(result.leads[2]).toMatchObject({ site, page: "/", receivedAt: 200, fields: { name: "Second" }, forward: "kept", manual: false, source: "" });
      expect((await instance.sites()).find(entry => entry.site === site)?.leads).toBe(3);
    });
  });

  it("filters across old requests, returns whole leads, and pages leads by the newest matching request", async () => {
    const site = siteName();
    const stub = env.LEADS.get(env.LEADS.idFromName(`filters-${id()}`));
    await runInDurableObject(stub, async instance => {
      const contact = { phone: "5555550142", email: "a@b.test" };
      await instance.add(newLead("old", site, { ...contact, source: "Meta", message: "Storm damage 100%" }), 100);
      await instance.add(newLead("single", site, { source: "Search", message: "Storm damage 100%" }), 200);
      await instance.add(newLead("new", site, { ...contact, source: "Search", message: "New request" }), 300);
      await instance.add(newLead("later", site, { source: "Referral", message: "Storm damage 100%" }), 400);
      await instance.add(newLead("similar", site, { phone: "5555550142" }), 500);
      const filtered = await instance.list({ site, search: "Storm damage 100%", limit: 1 });
      expect(filtered.sources).toEqual(["Meta", "Referral", "Search"]);
      expect(filtered.duplicates).toBe(2);
      expect(filtered.leads[0].id).toBe("later");
      const middle = await instance.list({ site, search: "Storm damage 100%", limit: 1, before: filtered.next });
      expect(middle.leads[0].id).toBe("single");
      const last = await instance.list({ site, search: "Storm damage 100%", limit: 1, before: middle.next });
      expect(last.leads[0].id).toBe("new");
      expect(last.leads[0].requests[0].id).toBe("old");
      expect(last.next).toBeUndefined();
      expect((await instance.list({ site, source: "Meta" })).leads.map(lead => lead.id)).toEqual(["new"]);
      expect((await instance.list({ site, since: 301 })).leads.map(lead => lead.id)).toEqual(["similar", "later"]);
      expect((await instance.list({ site, source: "Meta", since: 101 })).leads).toEqual([]);
      const duplicates = await instance.list({ site, duplicates: true });
      expect(duplicates.leads.map(lead => lead.id)).toEqual(["similar", "new"]);
      expect((await instance.list({ site, search: "nothing" })).duplicates).toBe(2);
    });
  });

  it("caps similar leads at five, newest first, including leads with only one contact key", async () => {
    const stub = env.LEADS.get(env.LEADS.idFromName(`similar-${id()}`));
    await runInDurableObject(stub, async instance => {
      for (let i = 0; i < 8; i++) await instance.add(newLead(`phone-${i}`, "similar", { phone: "5555550142" }), i + 1);
      const { leads, duplicates } = await instance.list({ site: "similar", duplicates: true });
      expect(duplicates).toBe(8);
      expect(leads).toHaveLength(8);
      expect(leads[7].similar.map(lead => lead.id)).toEqual(["phone-7", "phone-6", "phone-5", "phone-4", "phone-3"]);
      expect(leads.every(lead => lead.requests.length === 0)).toBe(true);
    });
  });

  it("saves a hand-added lead with just its allowed fields", async () => {
    const stub = env.LEADS.get(env.LEADS.idFromName(`manual-${id()}`));
    await runInDurableObject(stub, async (instance, state) => {
      const lead = await instance.addManual({ site: "manual", name: "Casey", phone: "5555550142", email: "", source: "Referral", note: "Call tomorrow", addedBy: "Alex" }, 100);
      expect(lead).toMatchObject({ manual: true, forward: "none", source: "Referral", fields: { name: "Casey", phone: "5555550142", source: "Referral", message: "Call tomorrow", added_by: "Alex" } });
      expect(lead?.id).toMatch(/^manual-[0-9a-f-]{36}$/);
      expect(Object.keys(lead!.fields).sort()).toEqual(["added_by", "message", "name", "phone", "source"]);
      expect(state.storage.sql.exec("SELECT raw, forward, tries FROM leads").one()).toEqual({ raw: null, forward: "none", tries: 0 });
      instance.maxBytes = 0;
      expect(await instance.addManual({ site: "manual", name: "Other", phone: "1234567", addedBy: "Alex" })).toBeUndefined();
    });
  });

  it("merges whole leads, preserves each request and contact lookup, refuses missing or cross-site leads, and deletes folded requests", async () => {
    const stub = env.LEADS.get(env.LEADS.idFromName(`merge-${id()}`));
    await runInDurableObject(stub, async (instance, state) => {
      await instance.add(newLead("one", "merge", { phone: "5555550142", email: "a@b" }), 100);
      await instance.add(newLead("two", "merge", { phone: "5555550142", email: "a@b" }), 200);
      await instance.add(newLead("three", "merge", { phone: "9135550177", email: "c@d" }), 300);
      await instance.add(newLead("other", "other", { name: "Other" }), 400);
      expect(await instance.merge(["two", "gone"])).toEqual({ error: "Some of these leads no longer exist. Reload and try again." });
      expect(await instance.merge(["two", "other"])).toEqual({ error: "Only leads of the same website can be merged." });
      const before = state.storage.sql.exec("SELECT id, fields, raw, forward, tries, received_at FROM leads ORDER BY id").toArray();
      expect(await instance.merge(["two", "three"])).toEqual({ merged: 3 });
      expect(state.storage.sql.exec("SELECT id, fields, raw, forward, tries, received_at FROM leads ORDER BY id").toArray()).toEqual(before);
      expect((await instance.list({ site: "merge" })).leads[0].requests.map(request => request.id)).toEqual(["two", "one"]);
      // A later form can fold through either contact pair, even after a restart.
      const restarted = new Leads(state, {});
      await restarted.add(newLead("four", "merge", { phone: "5555550142", email: "a@b" }), 500);
      const result = await restarted.list({ site: "merge" });
      expect(result.leads).toHaveLength(1);
      expect(result.leads[0].requests).toHaveLength(3);
      expect(await restarted.delete(["four", "gone"])).toEqual({ deleted: 4 });
      expect((await restarted.list({ site: "merge" })).leads).toEqual([]);
      expect((await restarted.list({ site: "other" })).leads).toHaveLength(1);
      expect(await restarted.delete(["gone"])).toEqual({ deleted: 0 });
    });
  });

  it("does not bring back a form request a person deleted", async () => {
    const stub = env.LEADS.get(env.LEADS.idFromName(`deleted-${id()}`));
    await runInDurableObject(stub, async instance => {
      const lead = newLead("a".repeat(32), "resent", { name: "Casey", phone: "5555550142" });
      expect(await instance.add(lead, 100)).toBe("saved");
      expect(await instance.delete([lead.id])).toEqual({ deleted: 1 });
      // The form sends the same request again (a retry, a second press): it is answered as done, not saved anew.
      expect(await instance.add(lead, 200)).toBe("repeat");
      expect((await instance.list({ site: "resent" })).leads).toEqual([]);
    });
  });

  it.each(["add", "delete", "merge"] as const)("protects the %s route with the same person's site-building approval proof", async action => {
    await approvers({ helper: ["alex"], second: ["jo"] });
    const body = action === "add" ? { site: siteName(), name: "Casey", phone: "1234567", addedBy: "Alex" } : { ids: [id(), id()] };
    for (const [who, approving] of [["alex", ""], ["jo", "jo"], ["casey", "alex"], ["casey", "casey"]]) {
      const response = await change(action, body, who, approving);
      expect(response.status).toBe(403);
      expect(await response.json()).toHaveProperty("error");
    }
  });

  it("validates new write bodies and exposes add, merge, delete and shared filters without losing the old response properties", async () => {
    await approvers({ helper: ["alex"] });
    const site = siteName();
    const manual = { site, name: "Casey", email: "casey@example.com", phone: "5555550142", source: "Referral", note: "Storm damage", addedBy: "Alex" };
    const invalid = [
      null, [], { ...manual, site: "Not A Site" }, { ...manual, name: "" }, { ...manual, name: 4 }, { ...manual, phone: "", email: "" },
      { ...manual, email: "not-an-email" }, { ...manual, addedBy: null }, { ...manual, extra: "not allowed" },
      ...Object.entries({ name: 120, email: 200, phone: 40, source: 80, note: 2000, addedBy: 120 }).map(([field, length]) => ({ ...manual, [field]: "x".repeat(length + 1) })),
    ];
    for (const body of invalid) expect((await change("add", body)).status).toBe(400);
    for (const action of ["delete", "merge"] as const) {
      for (const body of [{ ids: [] }, { ids: ["bad id"] }, { ids: [null] }, { ids: "not-an-array" }, { ids: [id()], extra: true }, { ids: Array.from({ length: action === "merge" ? 21 : 101 }, id) }, { ids: [manual.phone, manual.email] }]) {
        expect((await change(action, body)).status).toBe(400);
      }
      const same = id();
      expect((await change(action, { ids: [same, same] })).status).toBe(400);
    }
    const first = await change("add", manual);
    expect(first.status).toBe(200);
    const added = (await first.json() as { lead: Lead }).lead;
    expect(added).toMatchObject({ site, fields: { added_by: "Alex" }, manual: true, forward: "none", source: "Referral", requests: [], similar: [] });
    // Forms and hand-added leads use exactly the same folding rule.
    await runInDurableObject(env.LEADS.get(env.LEADS.idFromName("acme")), instance => instance.add(newLead(id(), site, { phone: manual.phone, email: manual.email, source: "Search" }), added.receivedAt + 1));
    const page = await list("alex", { site, source: "Referral", since: added.receivedAt, duplicates: true, search: "storm damage" });
    expect(page.sites.find(entry => entry.site === site)?.leads).toBe(1);
    expect(page.sources).toEqual(["Referral", "Search"]);
    expect(page.duplicates).toBe(1);
    expect(page.leads[0].requests[0].id).toBe(added.id);
    for (const field of ["id", "site", "page", "receivedAt", "fields", "forward"]) expect(page.leads[0]).toHaveProperty(field);
    const secret = (await (await share("POST", site, "alex", "alex")).json() as { token: string }).token.split(".")[1];
    // Who added a lead is not searchable: a link's holder could otherwise find the name letter by letter.
    expect((await list("alex", { site, search: "alex" })).leads).toEqual([]);
    expect((await (await shared(secret, { search: "alex" })).json() as { leads: Lead[] }).leads).toEqual([]);
    const view = await (await shared(secret, { source: "Referral", duplicates: true, search: "storm damage", since: added.receivedAt })).json() as { leads: Lead[]; sources: string[]; duplicates: number };
    // The link's holder sees the same leads, without who on the staff added one by hand.
    const unsigned = structuredClone(page.leads);
    delete unsigned[0].requests[0].fields.added_by;
    expect(view.leads).toEqual(unsigned);
    expect(view.sources).toEqual(page.sources);
    expect(view.duplicates).toBe(1);
    expect((await (await shared(secret, { since: added.receivedAt + 1, source: "Referral" })).json() as { leads: Lead[] }).leads).toEqual([]);
    // A custom range: `until` is the first moment left out.
    expect((await (await shared(secret, { until: added.receivedAt })).json() as { leads: Lead[] }).leads).toEqual([]);
    expect((await list("alex", { site, since: added.receivedAt, until: added.receivedAt + 1 })).leads.map(lead => lead.id)).toEqual([page.leads[0].id]);
    const other = (await (await change("add", { ...manual, phone: "9135550177", email: "else@example.com" })).json() as { lead: Lead }).lead;
    const crossSite = (await (await change("add", { ...manual, site: siteName() })).json() as { lead: Lead }).lead;
    const cross = await change("merge", { ids: [page.leads[0].id, crossSite.id] });
    expect(cross.status).toBe(400);
    expect(await cross.json()).toEqual({ error: "Only leads of the same website can be merged." });
    const missing = await change("merge", { ids: [page.leads[0].id, id()] });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "Some of these leads no longer exist. Reload and try again." });
    const merged = await change("merge", { ids: [page.leads[0].id, other.id] });
    expect(merged.status).toBe(200);
    expect(await merged.json()).toEqual({ merged: 3 });
    const newest = (await list("alex", { site })).leads[0];
    const deleted = await change("delete", { ids: [newest.id, id()] });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: 3 });
    expect((await list("alex", { site })).leads).toEqual([]);
  });
});

describe("a share link", () => {
  it("is made and turned off only by a person who may approve for an agent that builds sites, proven by their own approver pass", async () => {
    await approvers({ helper: ["alex"], second: ["jo"] });
    const site = siteName();
    expect((await share("POST", site, "alex")).status).toBe(401); // signed in, no approver pass
    expect((await share("POST", site, "jo", "jo")).status).toBe(403); // approves for Second, who builds no sites
    expect((await share("POST", site, "casey", "alex")).status).toBe(403); // someone else's approver pass
    expect((await share("POST", site, "casey", "casey")).status).toBe(403); // on no list
    expect(await (await share("GET", site, "casey")).json()).toEqual({ site, share: null });

    const made = await share("POST", site, "alex", "alex", 7);
    expect(made.status).toBe(200);
    const link = await made.json() as { site: string; token: string; expiresAt: number };
    expect(link.token).toMatch(/^acme\.[0-9a-f]{64}$/);
    expect(Math.round((link.expiresAt - Date.now()) / 86_400_000)).toBe(7);
    // Anyone signed in can see that a link exists, who made it and until when; never the link itself.
    const state = await (await share("GET", site, "casey")).json() as { share: Record<string, unknown> };
    expect(state.share).toMatchObject({ createdBy: "alex", expiresAt: link.expiresAt });
    expect(JSON.stringify(state)).not.toContain(link.token.split(".")[1]);

    expect((await share("DELETE", site, "jo", "jo")).status).toBe(403);
    expect(await (await share("DELETE", site, "alex", "alex")).json()).toEqual({ removed: true });
    expect(await (await share("GET", site, "casey")).json()).toEqual({ site, share: null });
    expect((await share("POST", site, "alex", "alex", 45)).status).toBe(400); // not one of the lengths offered
    expect((await share("POST", "Not A Site", "alex", "alex")).status).toBe(400);
  });

  it("opens that one site's leads to whoever holds it, until it is replaced, turned off or runs out", async () => {
    await approvers({ helper: ["alex"] });
    const [site, other] = [siteName(), siteName()];
    await send(site, { name: "Casey Rowe", email: "casey@example.com" });
    await send(site, { name: "Marcus Lee", phone: "(913) 555-0177" });
    await send(other, { name: "Someone Else", email: "else@example.com" });

    const first = (await (await share("POST", site, "alex", "alex")).json() as { token: string }).token.split(".")[1];
    const opened = await shared(first);
    expect(opened.status).toBe(200);
    const view = await opened.json() as { site: string; leads: Lead[]; expiresAt: number; sites?: unknown };
    expect(view.site).toBe(site);
    expect(view.leads.map(lead => lead.fields.name).sort()).toEqual(["Casey Rowe", "Marcus Lee"]);
    // No word of the client's other sites.
    expect(view.sites).toBeUndefined();
    // Asking for another site with this link still gives this one.
    const forced = await (await shared(first, { site: other })).json() as { site: string; leads: Lead[] };
    expect(forced.leads).toHaveLength(2);
    expect(forced.leads.every(lead => lead.site === site)).toBe(true);
    expect((await (await shared(first, { search: "marcus" })).json() as { leads: Lead[] }).leads).toHaveLength(1);

    expect((await shared("f".repeat(64))).status).toBe(404);
    expect((await shared("not-a-token")).status).toBe(404);

    // A new link replaces the old one.
    const second = (await (await share("POST", site, "alex", "alex")).json() as { token: string }).token.split(".")[1];
    expect((await shared(first)).status).toBe(404);
    expect((await shared(second)).status).toBe(200);
    await share("DELETE", site, "alex", "alex");
    expect((await shared(second)).status).toBe(404);

    // And one whose days have passed opens nothing.
    const store = env.LEADS.get(env.LEADS.idFromName("acme"));
    const old = await runInDurableObject(store, instance => instance.createShare(site, "alex", 7, Date.now() - 8 * 86_400_000));
    expect((await shared(old.secret)).status).toBe(404);
    expect(await (await share("GET", site, "casey")).json()).toEqual({ site, share: null });
  });

  it("has an allowance of its own: a link hammered by its holder leaves staff their leads and the switch that turns it off", async () => {
    await approvers({ helper: ["alex"] });
    await insideOneMinute();
    const site = siteName();
    const codes: number[] = [];
    for (let i = 0; i < 130; i++) codes.push((await shared("f".repeat(64))).status);
    // 120 a minute for this client's links (the test before used a few): then every further one is refused.
    const refusedFrom = codes.indexOf(429);
    expect(refusedFrom).toBeGreaterThan(100);
    expect(refusedFrom).toBeLessThanOrEqual(120);
    expect(codes.slice(0, refusedFrom).every(code => code === 404)).toBe(true);
    expect(codes.slice(refusedFrom).every(code => code === 429)).toBe(true);
    expect((await list("alex", { site })).leads).toEqual([]);
    expect((await share("DELETE", site, "alex", "alex")).status).toBe(200);
  }, 30_000);

  it("keeps only a hash of the link, so the store itself opens nothing", async () => {
    const stub = env.LEADS.get(env.LEADS.idFromName(`hash-${id()}`));
    const { secret, kept } = await runInDurableObject(stub, async (instance, state) => {
      const made = await instance.createShare("acme", "alex", 30);
      return { secret: made.secret, kept: JSON.stringify(state.storage.sql.exec("SELECT * FROM shares").toArray()) };
    });
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(kept).not.toContain(secret);
  });
});
