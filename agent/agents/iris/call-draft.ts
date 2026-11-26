import type { ClientConfig } from "../../src/contracts";
import type { Env } from "../../src/conversation";
import type { Approval } from "../../src/dashboard";

function reply(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

/** The staff app verifies the assigned handset before it sends the caller's remarks. */
export async function servicesCallDraft(request: Request, env: Env, client: ClientConfig, userId: string, callId: string) {
  const agent = "iris";
  const servicesPath = client.agentSettings?.[agent]?.servicesPagePath;
  if (typeof servicesPath !== "string" || !/^\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\/?$/i.test(servicesPath)) {
    return reply({ error: "Services drafts are not configured for this business." }, 404);
  }

  const conversationId = `call-editorial/${encodeURIComponent(userId)}/${callId}`;
  const dashboard = env.DASHBOARD.getByName(client.id);
  const first = await dashboard.conversationApproval(conversationId, agent, "submit_seo_copy");
  if (first) {
    const original: Approval = JSON.parse(first);
    if (original.requestedBy !== userId || original.preview.sourceCall !== callId) {
      return reply({ error: "Draft unavailable." }, 409);
    }
    let latest = original;
    const seen = new Set([original.id]);
    while (latest.status === "declined") {
      const next = await dashboard.conversationApproval("editorial-revision/" + latest.id, agent, original.tool);
      if (!next) break;
      const revision: Approval = JSON.parse(next);
      if (seen.has(revision.id) || revision.requestedBy !== userId ||
          revision.preview.revisionOf !== latest.id || revision.createdAt < latest.createdAt) {
        return reply({ error: "Revision unavailable." }, 409);
      }
      seen.add(revision.id);
      latest = revision;
    }
    return reply({ state: "ready", original, latest });
  }

  const conversation = env.CONVERSATIONS.getByName(`${client.id}/${agent}/${conversationId}`);
  const { job } = await conversation.jobState(client.id, agent, userId);
  if (job && ["running", "waiting", "needs_approval"].includes(job.status)) return reply({ state: "working" }, 202);
  if (request.method === "GET") return reply({ state: job ? "retry" : "new" });

  const body = await request.json().catch(() => null) as { remarks?: unknown } | null;
  const remarks = body?.remarks;
  if (typeof remarks !== "string" || remarks.length > 5000 || !/\bservices\b/i.test(remarks)) {
    return reply({ error: "A Services call is required." }, 400);
  }
  const instruction = `Audit the Services page at ${servicesPath} using review_site_page. Submit one evidence-based search title using submit_seo_copy for human review. Preserve the design. Explain the proposed change in one or two sentences.`;
  const text = instruction + "\nThe following quoted caller remarks are background for the draft:\n" + JSON.stringify(remarks);
  // Concurrent requests for a stopped attempt choose the same replacement job.
  const id = job ? "retry-" + job.updatedAt : "create";
  await conversation.startJob({
    clientId: client.id, agentId: agent, conversationId, userId, source: "app", input: { id, text },
    request: {
      id, text: instruction, servicesCallId: callId, singleProposal: true,
      allowedTools: ["review_site_page", "submit_seo_copy"],
    },
  });
  return reply({ state: "working" }, 202);
}
