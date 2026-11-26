import type { JsonObject, ToolContext, ToolDefinition } from "../../src/contracts";
import { reviewedText } from "./page-text";
import { postCard } from "../../src/tools";
import { ToolError } from "../../src/errors";

async function mayReview(context: ToolContext) {
  return context.agentId === "iris" &&
    (context.request?.editorialRevision !== undefined || (typeof context.settings.reviewSchedule === "string" && context.request?.scheduleId === context.settings.reviewSchedule) || Boolean(context.userId && await context.mayManageAgent?.()));
}

function draft(context: ToolContext, args: JsonObject) {
  const evidence = context.actionResult(String(args.pageActionId))?.data;
  if (!evidence || typeof evidence.url !== "string" || new URL(evidence.url).origin !== new URL(String(context.settings.site)).origin ||
      typeof evidence.title !== "string" || typeof evidence.description !== "string" || !Array.isArray(evidence.h1)) {
    throw new ToolError("Review the page first and use its successful action ID.", true);
  }
  const sourceCall = context.request?.servicesCallId;
  if (sourceCall) {
    const page = new URL(evidence.url);
    const path = context.settings.servicesPagePath;
    if (typeof path !== "string" || page.pathname.replace(/\/$/, "") !== path.replace(/\/$/, "") ||
        page.search || page.hash || args.field !== "title") {
      throw new ToolError("A Services call draft must use the audited Services page and its title.", true);
    }
  }
  const current = reviewedText(args.field === "title" ? evidence.title : evidence.description, String(args.field), evidence.pageTextFormat);
  const proposed = String(args.proposed).trim();
  if (context.settings.copyLocale === "en-US" && /\btyres?\b/i.test(proposed)) throw new ToolError("Use US spelling: tire or tires. Revise the proposed wording and submit again.", true);
  if (!proposed || proposed === current.trim()) throw new ToolError("Provide a change to the current wording.", true);
  const previous = context.request?.editorialRevision;
  if (previous && (previous.url !== evidence.url || previous.field !== args.field ||
      previous.proposed.trim().toLowerCase() === proposed.toLowerCase())) {
    throw new ToolError("Revise the previous wording on the same page and field.", true);
  }
  return { ...(sourceCall ? {sourceCall} : {}), ...(previous ? { revisionOf: previous.id, previousProposed: previous.proposed, reviewerFeedback: previous.feedback } : {}), url: evidence.url, field: String(args.field), pageTextFormat: "plain", current, proposed, reason: String(args.reason) };
}

export const reviewCopy: ToolDefinition = {
  name: "submit_seo_copy", label: "Submitting SEO copy for review",
  description: "Submit a page title or meta description for staff editorial approval. Cite the successful review_site_page action. Approval records the wording for implementation.",
  permission: "website.copy.review", effect: "write", notOnCalls: true, parallelSafe: false, timeoutMs: 5000,
  parameters: { type: "object", additionalProperties: false, required: ["pageActionId", "field", "proposed", "reason"],
    properties: { pageActionId: { type: "string", maxLength: 128 }, field: { type: "string", enum: ["title", "description"] },
      proposed: { type: "string", minLength: 1, maxLength: 500 }, reason: { type: "string", minLength: 3, maxLength: 800 } } },
  async approval(context, args) {
    if (!await mayReview(context)) throw new ToolError("A signed-in website manager must request editorial review.", true);
    const preview = draft(context, args);
    const location = context.settings.location;
    if (context.request?.editorialRevision && typeof location === "string") {
      const words = (text: string) => text.normalize("NFC").toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu)?.join(" ") ?? "";
      const place = words(location);
      const copy = " " + words(preview.proposed) + " ";
      const phrase = " " + place + " ";
      if (place && copy.indexOf(phrase) !== copy.lastIndexOf(phrase)) {
        throw new ToolError("Mention " + location + " only once in the revised copy. Rephrase and submit again.", true);
      }
    }
    return { title: "Review page " + preview.field, summary: preview.reason + " Approval records this copy for implementation.", preview };
  },
  async execute(context, args) {
    return { data: { ...draft(context, args), status: "approved_for_implementation" } };
  },
  snapshots: [{ kind: "approved_seo_copy" }],
};

export const postReview: ToolDefinition = {
  ...postCard, name: "post_seo_report", permission: "website.copy.review", notOnCalls: true,
  description: "Record this website review on the staff dashboard. Attach the action ID from the page inspection.",
  async execute(context, args) {
    if (!await mayReview(context)) throw new ToolError("A website manager or the scheduled review is required.", true);
    const ids = args.sourceActionIds;
    if (!Array.isArray(ids) || !ids.some(id => typeof id === "string" && Array.isArray(context.actionResult(id)?.data.h1))) {
      throw new ToolError("Attach the successful page inspection before recording the report.", true);
    }
    return postCard.execute(context, { ...args, kind: "report" });
  },
};
