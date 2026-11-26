import type { ClientConfig } from "../../src/contracts";
import type { Env } from "../../src/conversation";
import type { Approval } from "../../src/dashboard";
import type { DecisionReply } from "../../src/approvals";

/** Called after reviewer authorization. A decline remains final even if the model is unavailable. */
export async function requestEditorialRevision(env: Pick<Env, "DASHBOARD" | "CONVERSATIONS">, client: ClientConfig, parent: Approval): Promise<DecisionReply> {
  if (!client.agents.includes("iris") || parent.agent !== "iris" || parent.tool !== "submit_seo_copy" ||
      parent.status !== "declined" || !parent.reason?.trim()) {
    return { status: 409, body: JSON.stringify({ error: "Decline an editorial draft with feedback before requesting a revision." }) };
  }
  const conversationId = "editorial-revision/" + parent.id;
  const dashboard = env.DASHBOARD.get(env.DASHBOARD.idFromName(client.id));
  const existing = await dashboard.conversationApproval(conversationId, parent.agent, parent.tool);
  if (existing) return { status: 200, body: existing };
  const { url, field, proposed } = parent.preview;
  if (typeof url !== "string" || typeof proposed !== "string" || (field !== "title" && field !== "description")) {
    return { status: 409, body: JSON.stringify({ error: "The original draft is incomplete." }) };
  }
  const sourceCall = typeof parent.preview.sourceCall === "string" ? parent.preview.sourceCall : undefined;
  const revision = { id: parent.id, url, field, proposed, feedback: parent.reason };
  const text = "Read the original page again using review_site_page. Revise the same field based on the editorial feedback in this JSON. If the requested opening already names the location, use that as its only mention. Submit one new draft for human approval using submit_seo_copy. Explain the change in one or two sentences. " + JSON.stringify(revision);
  const conversation = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(client.id + "/" + parent.agent + "/" + conversationId));
  const id = crypto.randomUUID();
  try {
    const stream = await conversation.turn({ clientId: client.id, agentId: parent.agent, conversationId, userId: parent.requestedBy ?? undefined, source: parent.source, input: { id, text }, request: { id, text, singleProposal: true, allowedTools: ["review_site_page", "submit_seo_copy"], editorialRevision: revision, ...(sourceCall ? { servicesCallId: sourceCall } : {}) } });
    await new Response(stream).arrayBuffer();
  } catch { /* A completed proposal can survive a lost stream. Read the canonical record below. */ }
  const child = await dashboard.conversationApproval(conversationId, parent.agent, parent.tool);
  return child ? { status: 200, body: child } : { status: 503, body: JSON.stringify({ error: "The revision is unavailable. The decline and feedback are saved. Retry the revision." }) };
}
