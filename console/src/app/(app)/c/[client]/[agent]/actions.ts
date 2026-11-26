"use server";

import { canApproveAgent, canSeeClient, canUseAgent } from "@/lib/access";
import { canAskForRevision, canSeeRequest, decisionRight } from "@/lib/requests";
import { BrainError, changeSiteCopy, clearBrainCache, decideApproval, decideLesson, getApproval, listLessons, type Decision } from "@/lib/server/brain";
import { brainHasAccess, PeopleError } from "@/lib/server/people";
import { actionViewer } from "@/lib/server/session";

export type ActionResult = { ok: true } | { ok: false; error: string };

const GONE = "This request no longer exists. Refresh to see the current list.";

/**
 * Decides a request on an employee's desk. The request is read fresh from the brain and checked here (theirs, or an Northlight
 * admin; still waiting; on this employee) before any pass is signed; the brain checks the person and the right again.
 */
export async function decideRequest(clientId: string, agentId: string, requestId: string, decision: Decision, reasonRaw: string): Promise<ActionResult> {
  const viewer = await actionViewer();
  if ("error" in viewer) return { ok: false, error: viewer.error };
  if (!canSeeClient(viewer.access, viewer.clients, clientId) || !canUseAgent(viewer.access, clientId, agentId)) return { ok: false, error: GONE };
  if (decision !== "approve" && decision !== "decline" && decision !== "revise") return { ok: false, error: "That decision is not one this app knows." };
  const reason = String(reasonRaw ?? "").trim().slice(0, 500);
  try {
    const request = await getApproval(clientId, requestId);
    if (!request || request.agent !== agentId || !canSeeRequest(request, viewer)) return { ok: false, error: GONE };
    if (decision === "revise") {
      if (!canAskForRevision(request, clientId, viewer)) return { ok: false, error: "A new draft can be asked for once this one is declined with feedback, by the person who asked for it or an Northlight admin." };
    } else {
      const right = decisionRight(request, clientId, viewer);
      if (right === "waiting") return { ok: false, error: "An Northlight admin decides this request: you asked for it, but you do not approve for this employee." };
      if (right !== "decide") return { ok: false, error: request.status === "pending" ? GONE : "This request was already decided. Refresh to see the decision." };
    }
    // A decision resumes the asker's job, which runs on the brain's copy of their access: not while that copy is older.
    if (request.requestedBy && !(await brainHasAccess(request.requestedBy, clientId))) {
      return {
        ok: false,
        error: request.requestedBy === viewer.userId
          ? "Your access was just changed and Northlight's service has not taken the change yet. Try again in a minute."
          : "The access of the person who asked for this was just changed, and Northlight's service has not taken the change yet. Try again in a minute.",
      };
    }
    const result = await decideApproval(clientId, requestId, decision, reason, viewer.userId, viewer.admin);
    return result.ok ? { ok: true } : { ok: false, error: result.message };
  } catch (error) {
    if (error instanceof PeopleError) return { ok: false, error: error.message };
    return { ok: false, error: error instanceof BrainError ? error.message : "Northlight's service failed. Try again." };
  }
}

/** Approves or removes something an employee learned. Only people who approve for this employee may. */
export async function decideLessonAction(clientId: string, agentId: string, lessonId: string, decision: "approve" | "remove"): Promise<ActionResult> {
  const viewer = await actionViewer();
  if ("error" in viewer) return { ok: false, error: viewer.error };
  if (!canSeeClient(viewer.access, viewer.clients, clientId) || !canUseAgent(viewer.access, clientId, agentId)) return { ok: false, error: "This lesson no longer exists." };
  if (!canApproveAgent(viewer.access, clientId, agentId)) return { ok: false, error: "Only people who approve for this employee decide what it keeps learned." };
  if (decision !== "approve" && decision !== "remove") return { ok: false, error: "That decision is not one this app knows." };
  try {
    const lesson = (await listLessons(clientId, agentId)).find(l => l.id === lessonId);
    if (!lesson || (lesson.agent !== null && lesson.agent !== agentId)) return { ok: false, error: "This lesson no longer exists. Refresh to see the current list." };
    const result = await decideLesson(clientId, lessonId, decision, viewer.userId);
    return result.ok ? { ok: true } : { ok: false, error: result.message };
  } catch (error) {
    return { ok: false, error: error instanceof BrainError ? error.message : "Northlight's service failed. Try again." };
  }
}

/** Publishes the website's approved changes from Preview to Live, or discards them. Admins and approvers of the employee only. */
export async function siteCopyAction(clientId: string, agentId: string, action: "publish" | "discard"): Promise<ActionResult> {
  const viewer = await actionViewer();
  if ("error" in viewer) return { ok: false, error: viewer.error };
  if (agentId !== "iris" || !canSeeClient(viewer.access, viewer.clients, clientId) || !canUseAgent(viewer.access, clientId, agentId)) return { ok: false, error: "This employee does not look after a website here." };
  if (!viewer.admin && !canApproveAgent(viewer.access, clientId, agentId)) return { ok: false, error: "Only people who approve this employee's requests can publish or discard website changes." };
  if (action !== "publish" && action !== "discard") return { ok: false, error: "That is not something this app can do to the website." };
  try {
    const result = await changeSiteCopy(clientId, action, viewer.userId, viewer.admin);
    return result.ok ? { ok: true } : { ok: false, error: result.message };
  } catch (error) {
    return { ok: false, error: error instanceof BrainError ? error.message : "Northlight's service failed. Try again." };
  }
}

/**
 * The person's own job asked for a decision or ended: drop the business's cached lists, so the refresh that follows shows
 * the new request and the work (cached reads are kept for up to a minute otherwise).
 */
export async function freshenDesk(clientId: string, agentId: string): Promise<void> {
  const viewer = await actionViewer();
  if ("error" in viewer || !canSeeClient(viewer.access, viewer.clients, clientId) || !canUseAgent(viewer.access, clientId, agentId)) return;
  clearBrainCache(clientId);
}
