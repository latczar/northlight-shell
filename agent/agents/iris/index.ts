import { decodeHTML, decodeHTMLAttribute } from "entities";
import { servicesPreview } from "./services-preview";
import { requestEditorialRevision } from "./revisions";
import { postReview, reviewCopy } from "./editorial";
import { deployedPull } from "./deployed-pull";
import { buildPreview } from "./build";
import { pageAudit } from "./page-audit";
import type { EditableSetting, AgentTemplate, SetupInput, SetupItem, ToolContext, ToolDefinition } from "../../src/contracts";
import { ToolError } from "../../src/errors";

export const editable: EditableSetting[] = [];
export function setup({ settings, connections, has }: SetupInput): SetupItem[] {
  function credential(setting: string) {
    const auth = connections?.find(connection => connection.id === settings[setting])?.auth;
    const secret = auth?.type === "bearer" ? auth.secret : undefined;
    const connected = Boolean(secret && has(secret));
    return { connected, missing: connected ? [] : [secret ?? setting] };
  }
  return [{ id: "website", label: "Website to review", kind: "setting", connected: Boolean(settings.site),
    missing: settings.site ? [] : ["site"], unlocks: String(settings.site || "Set the website before reviewing pages.") },
    { id: "release_lookup", label: "GitHub release lookup", kind: "secret", optional: true, ...credential("releaseConnection"), unlocks: "Verify the PR for the live website commit." },
    { id: "preview_repo", label: "Homepage preview pull requests", kind: "secret", optional: true, ...credential("previewConnection"), unlocks: "Build homepage heading changes for a signed-in website manager." }];
}

export async function inspectPage(context: Pick<ToolContext, "settings" | "connection">, path = "/") {
  const site = new URL(String(context.settings.site));
  const page = new URL(path, site);
  if (page.origin !== site.origin || page.username || page.password) throw new ToolError("Choose a page on the configured website.", true);
  const response = await context.connection("managed_website").fetch(page.href);
  if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) throw new ToolError("The website did not return an HTML page.", true);
  let title = "";
  let description = "";
  let canonical = "";
  const headings: string[] = [];
  let h1Count = 0;
  let headingTextNode = "";
  const html = new HTMLRewriter()
    .on("title", { text(t) { title = (title + t.text).slice(0, 500); } })
    .on('meta[name="description"]', { element(e) { description = (e.getAttribute("content") ?? "").slice(0, 1000); } })
    .on('link[rel="canonical"]', { element(e) { canonical = (e.getAttribute("href") ?? "").slice(0, 2000); } })
    .on("h1", {
      element() {
        h1Count++;
        if (h1Count <= 12) headings.push("");
      },
      text(t) {
        if (h1Count > 12) return;
        // A text node can arrive in chunks. A character reference cannot span DOM nodes.
        headingTextNode = (headingTextNode + t.text).slice(0, 2000);
        if (t.lastInTextNode) {
          headings[h1Count - 1] = (headings[h1Count - 1] + decodeHTML(headingTextNode)).slice(0, 500);
          headingTextNode = "";
        }
      },
    });
  await html.transform(response).body!.pipeTo(new WritableStream());
  return { data: {
    url: page.href, businessName: context.settings.businessName, location: context.settings.location, copyLocale: context.settings.copyLocale, designNotes: context.settings.designNotes,
    pageTextFormat: "plain", title: decodeHTML(title).trim(),
    description: decodeHTMLAttribute(description), canonical: decodeHTMLAttribute(canonical),
    h1: headings.map(h => h.trim()), h1Count,
  } };
}

export const reviewPage: ToolDefinition = {
  name: "review_site_page", label: "Checking page metadata",
  description: "Read a page on the configured website and return its title, description, canonical URL and main headings.",
  permission: "seo.read", effect: "read", parallelSafe: true, timeoutMs: 15000,
  parameters: { type: "object", properties: { path: { type: "string", maxLength: 500 } }, additionalProperties: false },
  snapshots: [{ kind: "homepage_seo", merge: (_previous, data) => typeof data.url === "string" && new URL(data.url).pathname === "/" && !new URL(data.url).search ? data : undefined }],
  execute(context, args) {
    return inspectPage(context, String(args.path ?? "/"));
  },
};
export const tools = [reviewPage, pageAudit, buildPreview, servicesPreview, deployedPull, reviewCopy, postReview];
export const template: AgentTemplate = {
  reviseApproval: requestEditorialRevision,
  id: "iris", name: "Iris", role: "Website manager and SEO agent",
  tools: ["my_setup", "current_time", "review_site_page", "page_audit", "build_homepage_preview", "propose_services_title_preview", "find_deployed_pull", "submit_seo_copy", "post_seo_report"],
  owns: async (_context, kind, value) => kind === "releaseSha" ? /^[0-9a-f]{40}$/.test(value) : kind === "preview" && /^iris-homepage-[0-9a-f]{24}$/.test(value),
  prompt: `You are Iris, the website manager and SEO agent for the configured business. Speak in a natural British voice. Write website copy in the locale returned by the page inspection. Keep British delivery for speech.
For vague change requests, ask which page, what outcome staff want, and which wording or visual elements must stay. Ask only for information missing from the request or inspection. Check the client designNotes alongside the observed page. Keep approved headings, layout, brand colours, imagery and typography intact during routine SEO work. For a vague request such as “fix the homepage”, ask what needs fixing before suggesting replacements. If a request conflicts with an approved choice, identify the conflict and confirm the exact change before building. For a factual claim that the page cannot verify, ask staff for its source before submitting it.
When a website manager asks for content or SEO review, inspect the actual page and submit a justified title or description change with submit_seo_copy if warranted. If the existing wording is suitable, say so. Editorial approval records wording only. When enrolled staff explicitly request a Services title preview PR, inspect /services/ and use propose_services_title_preview. Explain that approval opens a draft PR and publishing requires a separate merge.
Use find_deployed_pull for questions about a shipped PR. Quote a merged PR only when this lookup verifies it.
Help staff maintain accurate pages and improve local search. Use review_site_page to check titles, descriptions, canonical links and headings. Use page_audit for measured mobile or desktop performance, accessibility and SEO findings. Cite the page and distinguish measurements from recommendations. Never invent rankings, traffic, prices or service claims. For a search title, explain which verified service a customer could recognise in the result. Avoid ranking promises and claims about the relative weight of ranking factors.
For a requested change, give the URL, the current wording or finding, a proposed edit, and how to verify it. Staff review the proposal before publishing. You can inspect pages and draft changes in the conversation. When a signed-in manager asks to build a homepage heading, use build_homepage_preview and share the PR link when the tool returns one. For already_applied, report that the configured base branch contains the change. If mergedPrUrl is present, link it as merged. Otherwise omit PR history. Label sourceUrl as the committed file. Confirm publication by inspecting the live page. Require staff review before publication. Direct customer intake to the business.`,
};
