// Server only. The caller must resolve the transcript in the signed-in staff member's client.
export async function servicesDraftFromCall({ transcript, clientId, agentId, staffUserId, conversations, dashboard }) {
  if (!staffUserId) throw new Error("A signed-in staff identity is required.");
  if (!transcript || !["call", "phone"].includes(transcript.kind) || !transcript.id ||
      !Array.isArray(transcript.turns) || !transcript.turns.some(turn => turn.who === "You" && typeof turn.text === "string" && turn.text.trim())) {
    throw new Error("A saved call with a staff request is required.");
  }
  const conversationId = "services-editorial/" + transcript.id;
  const find = () => dashboard.conversationApproval(conversationId, agentId, "submit_seo_copy");
  const existing = await find();
  if (existing) return JSON.parse(existing);

  const text = "Review the Services page using review_site_page. Submit one search title based on page evidence using submit_seo_copy. Retain the shop name and existing design. Use the call as context. Call transcript: " + JSON.stringify(transcript.turns);
  const conversation = conversations.getByName([clientId, agentId, conversationId].join("/"));
  const stream = await conversation.turn({
    clientId, agentId, conversationId, userId: staffUserId, source: "app", input: { id: transcript.id, text },
    request: { id: transcript.id, text, singleProposal: true, allowedTools: ["review_site_page", "submit_seo_copy"] },
  });
  await new Response(stream).arrayBuffer();
  const saved = await find();
  if (!saved) throw new Error("The Services draft could not be confirmed. Check the call before retrying.");
  return JSON.parse(saved);
}
