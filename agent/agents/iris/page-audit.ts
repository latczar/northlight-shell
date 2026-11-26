import type { ToolDefinition } from "../../src/contracts";
import { ToolError } from "../../src/errors";

const PAGESPEED = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

/** The configured site's host when it is a plain https address with a dotted name. */
function siteHost(site: unknown): string | undefined {
  try {
    const url = new URL(String(site));
    return url.protocol === "https:" && !url.username && !url.password && url.hostname.includes(".") ? url.hostname.toLowerCase() : undefined;
  } catch { return undefined; }
}

/** A full https address on the configured site (or one of its subdomains), never anywhere else. */
function ownUrl(site: unknown, raw: unknown): URL {
  const host = siteHost(site);
  let url: URL;
  try { url = new URL(String(raw)); } catch { throw new ToolError("url must be a full https:// address.", true); }
  const root = host?.replace(/^www\./, "");
  const hostname = url.hostname.toLowerCase();
  if (!root || url.protocol !== "https:" || url.username || url.password || !(hostname === root || hostname.endsWith(`.${root}`))) {
    throw new ToolError(`url must be on the client's site (${String(site || "not configured")}).`, true);
  }
  return url;
}

export const pageAudit: ToolDefinition = {
  name: "page_audit", label: "Running a page audit",
  description: "Google PageSpeed audit of one page on the configured website (default: the homepage): performance, SEO, accessibility and best-practice scores (0-100), Core Web Vitals and the failing SEO checks.",
  parameters: {
    type: "object",
    properties: { url: { type: "string", maxLength: 2000 }, strategy: { type: "string", enum: ["mobile", "desktop"] } },
    additionalProperties: false,
  },
  permission: "seo.read",
  effect: "read",
  parallelSafe: false,
  timeoutMs: 90_000,
  snapshots: [{ kind: "audit" }],
  async execute(context, args) {
    const site = context.settings.site;
    if (!siteHost(site)) return { data: { connected: false, missing: ["settings.site"] } };
    const page = ownUrl(site, args.url ?? new URL("/", String(site)).href);
    const url = new URL(PAGESPEED);
    url.searchParams.set("url", page.href);
    url.searchParams.set("strategy", String(args.strategy ?? "mobile"));
    for (const category of ["PERFORMANCE", "SEO", "ACCESSIBILITY", "BEST_PRACTICES"]) url.searchParams.append("category", category);
    // PageSpeed works without a key at a low shared quota; with PAGESPEED_API_KEY set, the desk adds it.
    const keyed = context.connection("pagespeed_key");
    const response = await (keyed.missing.length ? context.connection("pagespeed") : keyed).fetch(url.href);
    if (!response.ok) throw new ToolError(`PageSpeed failed (HTTP ${response.status}).`, true);
    const body = await response.json() as { lighthouseResult?: {
      categories?: Record<string, { score?: number | null; auditRefs?: { id: string }[] }>;
      audits?: Record<string, { title?: string; score?: number | null; displayValue?: string }>;
    } };
    const lighthouse = body.lighthouseResult ?? {};
    const audits = lighthouse.audits ?? {};
    const scores = Object.fromEntries(Object.entries(lighthouse.categories ?? {}).map(([id, c]) => [id, typeof c.score === "number" ? Math.round(c.score * 100) : null]));
    const vitals = Object.fromEntries(["largest-contentful-paint", "cumulative-layout-shift", "total-blocking-time", "first-contentful-paint", "speed-index"]
      .map(id => [id, audits[id]?.displayValue ?? null]));
    const failingSeo = (lighthouse.categories?.seo?.auditRefs ?? []).map(ref => audits[ref.id])
      .filter(audit => audit && typeof audit.score === "number" && audit.score < 1).map(audit => audit!.title).slice(0, 10);
    return { data: { connected: true, url: page.href, strategy: url.searchParams.get("strategy"), scores, vitals, failingSeo } };
  },
};
