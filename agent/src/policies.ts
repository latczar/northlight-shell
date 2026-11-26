import type { RequestRule } from "./contracts";

// Desk-side checks on the body of a request, named in a connection's `bodyPolicy` (src/connections.ts runs them before any
// rule, approval or fingerprint, so even an approved request that breaks one is refused). Code, not config: a policy
// must not be something a client file can loosen.

export interface BodyPolicy {
  /** The one request this policy covers (same matching as a connection's rules, `{customer}` checked as owned). */
  rule: RequestRule;
  /** Finishes "the <connection> connection is ..." when a request that is not a read goes anywhere but the covered path. */
  only: string;
  /** Why the body may not be sent, or undefined. */
  check(body: string, method: string, url: URL): string | undefined;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Per operation type: the fields that must point at something created in this same request (a temporary id), never at an existing campaign, ad group or budget. */
const CREATES: Record<string, [field: string, kind: string][]> = {
  campaignBudgetOperation: [],
  campaignOperation: [["campaignBudget", "campaignBudgets"]],
  campaignCriterionOperation: [["campaign", "campaigns"]],
  adGroupOperation: [["campaign", "campaigns"]],
  adGroupCriterionOperation: [["adGroup", "adGroups"]],
  adGroupAdOperation: [["adGroup", "adGroups"]],
};

/**
 * Google Ads `googleAds:mutate` may only create a new campaign that is PAUSED, with its budget, locations, ad groups,
 * keywords and ads, all in this one request. Nothing it sends can enable, edit, pause or remove anything that exists.
 * A body with `validateOnly: true` creates nothing and passes the shape checks only.
 * Google reads JSON keys more liberally than this code (snake_case names, escapes, repeated keys), so the body must be
 * exactly what JSON.stringify writes for what was parsed, with only the camelCase keys below.
 */
function googleAdsCreatePaused(body: string): string | undefined {
  let doc: unknown;
  try { doc = JSON.parse(body); } catch { return "the body is not JSON."; }
  if (!isObject(doc) || JSON.stringify(doc) !== body) return "the body must be one compact JSON object with no repeated or escaped keys.";
  if (Object.keys(doc).some(key => !["mutateOperations", "validateOnly", "partialFailure"].includes(key))) return "the body may only hold mutateOperations, validateOnly and partialFailure.";
  const { mutateOperations, validateOnly, partialFailure } = doc;
  if (validateOnly !== undefined && typeof validateOnly !== "boolean") return "validateOnly must be true or false.";
  if (validateOnly === true) return undefined;
  if (partialFailure !== undefined && partialFailure !== false) return "partialFailure must not be set: the campaign is created all together or not at all.";
  if (!Array.isArray(mutateOperations) || !mutateOperations.length) return "mutateOperations must list what to create.";
  for (const operation of mutateOperations) {
    const [type, ...more] = isObject(operation) ? Object.keys(operation) : [];
    if (!type || more.length || !Object.hasOwn(CREATES, type)) return `only a new campaign, budget, location, ad group, keyword or ad may be created, not ${type ?? "an empty operation"}.`;
    const inner = (operation as Record<string, unknown>)[type];
    if (!isObject(inner) || Object.keys(inner).join() !== "create" || !isObject(inner.create)) return `${type} must be a create: nothing existing may be updated or removed.`;
    if (type === "campaignOperation" && inner.create.status !== "PAUSED") return 'a campaign must be created with status "PAUSED"; a person turns it on in Google Ads.';
    for (const [field, kind] of CREATES[type]) {
      const value = inner.create[field];
      if (typeof value !== "string" || !new RegExp(`^customers/\\d+/${kind}/-\\d+$`).test(value)) return `${type} ${field} must be created in this same request (a temporary id such as customers/<id>/${kind}/-1), not an existing one.`;
    }
  }
  return undefined;
}

/** The Semrush reports an SEO agent may read (keyword rankings, related keywords, backlink matrix) and the most rows one may ask for. */
const SEMRUSH_REPORTS = ["resource_organic", "phrase_related", "backlinks_matrix"];
const SEMRUSH_MAX_ROWS = 100;
/** `export_columns` (which columns phrase_related returns) is the one other parameter the desk checks: only these names, only on that report. */
const SEMRUSH_RELATED_COLUMNS = ["keyword", "volume", "cpc", "competitive_density", "results", "trend", "relevance", "triggered_serp_features", "intent", "keyword_difficulty"];

/**
 * Semrush's MCP (`POST /v2/mcp`) may only be asked for one of the read reports above: a single JSON-RPC `tools/call` of
 * `execute_report`, with a `display_limit` of 1 to 100 rows. Any other method, tool (projects, site audits, position
 * tracking ...), batch or report is refused. Same exact-JSON rule as above, so nothing is read differently by Semrush.
 */
function semrushReadReport(body: string): string | undefined {
  let doc: unknown;
  try { doc = JSON.parse(body); } catch { return "the body is not JSON."; }
  if (!isObject(doc) || JSON.stringify(doc) !== body) return "the body must be one compact JSON-RPC call with no repeated or escaped keys (no batches).";
  if (Object.keys(doc).sort().join() !== "id,jsonrpc,method,params" || doc.jsonrpc !== "2.0" || doc.method !== "tools/call") return "only a JSON-RPC 2.0 tools/call with an id is allowed.";
  if (typeof doc.id !== "string" && typeof doc.id !== "number") return "the call needs a string or number id.";
  const call = doc.params;
  if (!isObject(call) || Object.keys(call).sort().join() !== "arguments,name" || call.name !== "execute_report" || !isObject(call.arguments)) return "only the execute_report tool may be called.";
  const args = call.arguments;
  if (Object.keys(args).sort().join() !== "params,report" || !isObject(args.params)) return "execute_report takes only report and params.";
  if (typeof args.report !== "string" || !SEMRUSH_REPORTS.includes(args.report)) return `only the ${SEMRUSH_REPORTS.join(", ")} reports may be read.`;
  const rows = args.params.display_limit;
  if (typeof rows !== "number" || !Number.isInteger(rows) || rows < 1 || rows > SEMRUSH_MAX_ROWS) return `params.display_limit must be a whole number from 1 to ${SEMRUSH_MAX_ROWS}.`;
  const columns = args.params.export_columns;
  if (columns !== undefined && (args.report !== "phrase_related" || !Array.isArray(columns) || columns.some(name => typeof name !== "string" || !SEMRUSH_RELATED_COLUMNS.includes(name)))) return `params.export_columns is only for phrase_related, a list of: ${SEMRUSH_RELATED_COLUMNS.join(", ")}.`;
  return undefined;
}

/** A guest's email as the calendar tools and the desk both accept it: lowercase letters, digits and `._%+-`, a dotted domain, at most 120 characters (so 20 guests always fit on an approval card). */
export const CALENDAR_EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
export const CALENDAR_EMAIL_MAX = 120;
const validEmail = (value: unknown) => typeof value === "string" && value.length <= CALENDAR_EMAIL_MAX && CALENDAR_EMAIL.test(value);

/** The keys calendar tools put in a new event. Never status, organizer, visibility or transparency. */
const CALENDAR_CREATE_KEYS = ["summary", "description", "location", "start", "end", "attendees", "reminders", "recurrence", "extendedProperties"];
/** The parts of an existing event that may change. `attendees` only ever alone (see below); never status, recurrence, organizer, visibility or transparency. */
const CALENDAR_CHANGE_KEYS = ["start", "end", "reminders", "summary", "location", "description", "attendees"];
/** What Google returns for a guest; an invitation request repeats the guests already on the event, so these (and only these) may be in a PATCH. */
const CALENDAR_GUEST_KEYS = ["email", "id", "displayName", "organizer", "self", "resource", "optional", "responseStatus", "comment", "additionalGuests"];
const CALENDAR_MAX_NEW_GUESTS = 20;
const CALENDAR_MAX_ALL_GUESTS = 250;
const CALENDAR_MAX_REMINDER_MINUTES = 40_320;
const CALENDAR_TEXT_MAX: Record<string, number> = { summary: 1000, location: 1000, description: 10_000 };
/** One repeat: weekly (optionally on named days), monthly or yearly, optionally ending on a date. */
const CALENDAR_RRULE = /^RRULE:FREQ=(?:WEEKLY(?:;BYDAY=(?:MO|TU|WE|TH|FR|SA|SU)(?:,(?:MO|TU|WE|TH|FR|SA|SU))*)?|MONTHLY|YEARLY)(?:;UNTIL=\d{8}(?:T\d{6}Z)?)?$/;
const CALENDAR_EVENTS_PATH = /^\/calendar\/v3\/calendars\/[A-Za-z0-9._%@-]+\/events(?:\/([A-Za-z0-9_-]+))?$/;

function calendarReminders(value: unknown): string | undefined {
  const bad = "reminders must be {useDefault: true}, or {useDefault: false} with up to 5 popup overrides of 0 to 40320 minutes.";
  if (!isObject(value)) return bad;
  if (Object.keys(value).join() === "useDefault") return value.useDefault === true ? undefined : bad;
  if (Object.keys(value).join() !== "useDefault,overrides" || value.useDefault !== false || !Array.isArray(value.overrides) || value.overrides.length > 5) return bad;
  const fine = value.overrides.every(o => isObject(o) && Object.keys(o).sort().join() === "method,minutes" && o.method === "popup"
    && typeof o.minutes === "number" && Number.isInteger(o.minutes) && o.minutes >= 0 && o.minutes <= CALENDAR_MAX_REMINDER_MINUTES);
  return fine ? undefined : bad;
}

/** A new event's guests: 1 to 20 objects holding only an email. An existing event's: the objects Google returned, each with a valid email. */
function calendarGuests(value: unknown, existing: boolean): string | undefined {
  const max = existing ? CALENDAR_MAX_ALL_GUESTS : CALENDAR_MAX_NEW_GUESTS;
  if (!Array.isArray(value) || value.length < 1 || value.length > max) return `attendees must list 1 to ${max} guests.`;
  for (const guest of value) {
    if (!isObject(guest) || !validEmail(guest.email)) return `every guest needs a valid email address (at most ${CALENDAR_EMAIL_MAX} characters).`;
    if (existing ? Object.keys(guest).some(key => !CALENDAR_GUEST_KEYS.includes(key) || (isObject(guest[key]) || Array.isArray(guest[key]))) : Object.keys(guest).join() !== "email") return existing ? `a guest may only hold ${CALENDAR_GUEST_KEYS.join(", ")}.` : "a new guest is only an email address.";
  }
  return undefined;
}

/**
 * The Google Calendar API may only be sent:
 * - POST `.../events` creating an event: keys from CALENDAR_CREATE_KEYS; `attendees` (emails only, up to 20) if and only if the URL is `?sendUpdates=all` (Google then emails the invitations);
 *   `recurrence` exactly one weekly/monthly/yearly RRULE; `reminders` the default or up to 5 popups.
 * - PATCH `.../events/<id>` changing only start, end, reminders, summary, location or description (no query string), or a PATCH whose
 *   whole body is `attendees` (the guest list, a request of its own) and whose URL is `?sendUpdates=all`.
 * Bodies are exactly what JSON.stringify writes for what was parsed. Everything else that is not a read is refused: DELETE, PUT,
 * quickAdd, import, move, watch, instances, any other query, and any change of status, recurrence, organizer, visibility or transparency.
 * The desk sees one request, not the event: it cannot tell whether a guest list PATCH leaves out someone already invited. The tool
 * that builds it (calendar_invite) re-reads the event and keeps every guest, and the approved bytes must match.
 */
function googleCalendarBookMove(body: string, method: string, url: URL): string | undefined {
  const match = CALENDAR_EVENTS_PATH.exec(url.pathname);
  const create = method === "POST" && match && match[1] === undefined;
  const change = method === "PATCH" && match && match[1] !== undefined;
  if (!create && !change) return "only creating an event, or changing an event's time, details, reminders or guests, is allowed: nothing may be deleted, cancelled or moved to another calendar.";
  let doc: unknown;
  try { doc = JSON.parse(body); } catch { return "the body is not JSON."; }
  if (!isObject(doc) || JSON.stringify(doc) !== body) return "the body must be one compact JSON object with no repeated or escaped keys.";
  const keys = Object.keys(doc);
  if (change && !keys.length) return "the change is empty.";
  const allowed = create ? CALENDAR_CREATE_KEYS : CALENDAR_CHANGE_KEYS;
  if (keys.some(key => !allowed.includes(key))) return `${create ? "a new event" : "a change"} may only hold ${allowed.join(", ")}.`;
  const guests = keys.includes("attendees");
  if (change && guests && keys.length > 1) return "a guest list change must be its own request, holding only attendees.";
  if (url.search !== (guests ? "?sendUpdates=all" : "")) return guests ? "guests may only be sent with exactly ?sendUpdates=all, so Google emails them." : "the request may not have query parameters.";
  const problem = guests ? calendarGuests(doc.attendees, Boolean(change)) : undefined;
  if (problem) return problem;
  if (keys.includes("reminders")) { const bad = calendarReminders(doc.reminders); if (bad) return bad; }
  for (const key of ["summary", "location", "description"]) {
    const value = doc[key];
    if (key in doc && (typeof value !== "string" || value.length > CALENDAR_TEXT_MAX[key] || (key === "summary" && !value.trim()))) return `${key} must be text${key === "summary" ? " that is not empty" : ""}, at most ${CALENDAR_TEXT_MAX[key]} characters.`;
  }
  if (keys.includes("recurrence") && (!Array.isArray(doc.recurrence) || doc.recurrence.length !== 1 || typeof doc.recurrence[0] !== "string" || !CALENDAR_RRULE.test(doc.recurrence[0]))) return "recurrence must be one weekly, monthly or yearly RRULE (optionally with BYDAY for weekly and an UNTIL date).";
  return undefined;
}

export const BODY_POLICIES: Record<string, BodyPolicy> = {
  google_ads_create_paused: {
    rule: { method: "POST", path: "/v25/customers/{customer}/googleAds:mutate" },
    only: "read-only except for creating a new paused campaign with googleAds:mutate, on the client's own account.",
    check: googleAdsCreatePaused,
  },
  semrush_read_reports: {
    rule: { method: "POST", path: "/v2/mcp" },
    only: "read-only: Semrush reports through execute_report, nothing else.",
    check: semrushReadReport,
  },
  google_calendar_book_move: {
    rule: { method: "*", path: "/calendar/v3/**" },
    only: "limited to booking new events (guests only with an approved invitation) and changing the time, title, place, notes, reminders or guests of existing ones: nothing can be deleted or cancelled.",
    check: googleCalendarBookMove,
  },
};
