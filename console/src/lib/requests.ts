import { canApproveAgent, type Access } from "./access";
import type { Approval, Card } from "./brain-types";
import { httpUrl } from "./preview";

// Who sees and decides which request. Pure functions, tested without a server.
//
// A request is private to the person who asked and to Northlight admins; one with no person behind it (a scheduled job, a phone
// call) is admin-only (agent docs, "Approvals"). The brain checks the same again when a decision arrives.

export interface Who {
  userId: string;
  admin: boolean;
  access: Access;
}

export const canSeeRequest = (request: { requestedBy?: string | null }, who: Who): boolean =>
  who.admin || (!!request.requestedBy && request.requestedBy === who.userId);

/**
 * Lessons quote a person's own words from their private chat (`web-<person id>`). The quote, and a lesson still waiting
 * for approval, are for that person, the people who approve for the employee, and Northlight admins; an approved lesson's text is
 * for everyone who uses the employee.
 */
export const canSeeLessonSource = (conversationId: string, who: Who, clientId: string, agentId: string): boolean =>
  who.admin || conversationId === `web-${who.userId}` || canApproveAgent(who.access, clientId, agentId);

/**
 * A request's card (`approval-<id>`) stays as private as the request after it is decided; a new lesson's card
 * (`lesson-card-<id>`) as private as the lesson's source. Other cards are shared.
 */
export function canSeeCard(card: Card, who: Who, clientId: string): boolean {
  if (card.id.startsWith("approval-") || card.kind === "needs_approval") return canSeeRequest(card, who);
  if (card.id.startsWith("lesson-card-")) return canSeeLessonSource(card.conversationId, who, clientId, card.agent);
  return true;
}

/**
 * `decide`: show Approve and Decline. `waiting`: the person asked but may not approve, so it waits for an admin.
 * `none`: decided already, or not theirs to decide.
 */
export function decisionRight(request: Approval, clientId: string, who: Who): "decide" | "waiting" | "none" {
  if (request.status !== "pending") return "none";
  if (who.admin) return "decide";
  if (request.requestedBy !== who.userId) return "none";
  return canApproveAgent(who.access, clientId, request.agent) ? "decide" : "waiting";
}

/** A copy draft from Iris's editorial review (submit_seo_copy): the page's current wording and the proposed one. */
export interface CopyDraft {
  url: string;
  field: "title" | "description";
  current: string;
  proposed: string;
  reason: string;
  /** The declined draft this one replaces, with the reviewer's feedback. */
  previous?: { proposed: string; feedback: string };
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

export function copyDraft(request: Approval): CopyDraft | null {
  const p = request.preview ?? {};
  if (request.tool !== "submit_seo_copy" || (p.field !== "title" && p.field !== "description")) return null;
  if (!text(p.current) && !text(p.proposed)) return null;
  const previous = text(p.previousProposed) ? { proposed: text(p.previousProposed), feedback: text(p.reviewerFeedback) } : undefined;
  // the employee chose this address; only http(s) becomes a link
  return { url: httpUrl(text(p.url)) ?? "", field: p.field, current: text(p.current), proposed: text(p.proposed), reason: text(p.reason), ...(previous ? { previous } : {}) };
}

/** A declined copy draft with feedback can go back for a new draft, by whoever could decide it. */
export function canAskForRevision(request: Approval, clientId: string, who: Who): boolean {
  if (request.status !== "declined" || !copyDraft(request) || !request.reason?.trim()) return false;
  return who.admin || (request.requestedBy === who.userId && canApproveAgent(who.access, clientId, request.agent));
}

/** "Asked by you", "Asked by Alex Morgan", or where it came from when nobody asked in the app. */
export function askedBy(request: Pick<Approval, "requestedBy" | "source">, who: Who, names: Record<string, string>): string {
  if (request.requestedBy && request.requestedBy === who.userId) return "Asked by you";
  if (request.requestedBy) return `Asked by ${names[request.requestedBy] ?? "someone in the app"}`;
  return { phone: "From a phone call", slack: "From Slack", scheduled: "From a scheduled check", app: "From the app", other: "From a test chat" }[request.source];
}
