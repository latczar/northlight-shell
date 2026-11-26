function successfulResults(turns, name) {
  const results = [];
  for (const turn of turns) {
    for (const tool of turn.tool_results ?? []) {
      if (tool?.tool_name !== name || tool.is_error) continue;
      try {
        results.push(JSON.parse(tool.result_value));
      } catch {
        return [];
      }
    }
  }
  return results;
}

// Match the completed provider call before handing a recorded proposal to editorial review.
export function readServicesProposal(call, expected) {
  const phone = call?.metadata?.phone_call;
  if (!phone || call.conversation_id !== expected.id || call.agent_id !== expected.agent ||
      call.branch_id !== expected.branch || call.status !== 'done' || phone.direction !== 'inbound' ||
      phone.external_number !== expected.from || phone.agent_number !== expected.to) return null;

  if (!Array.isArray(call.transcript) || call.transcript.some(turn =>
    !turn || (turn.tool_results != null && !Array.isArray(turn.tool_results)))) return null;
  const turns = call.transcript.filter(turn =>
    ['user', 'agent'].includes(turn.role) && typeof turn.message === 'string' && turn.message.trim()
  ).map(turn => ({role: turn.role, text: turn.message}));
  if (!turns.some(turn => turn.role === 'user' && /\bservices\b/i.test(turn.text))) return null;

  const audits = successfulResults(call.transcript, 'review_services');
  if (!audits.some(audit => audit?.url === expected.url && audit.currentTitle && audit.heading)) return null;
  const proposals = successfulResults(call.transcript, 'queue_services_title');
  const first = proposals[0];
  if (!first || typeof first.proposed !== 'string' || !first.proposed.trim() ||
      typeof first.draftId !== 'string' || !first.draftId.trim()) return null;
  if (!proposals.every(proposal => proposal?.published === false && proposal.status === 'pending' &&
      proposal.proposed === first.proposed && proposal.draftId === first.draftId)) return null;
  return {title: first.proposed, draftId: first.draftId, turns};
}


export function rememberCallSource(storage, id, title, draftId) {
  const key = 'services-source:' + id;
  return storage.transaction(async tx => {
    const prior = await tx.get(key);
    if (prior) return prior.title === title && prior.draftId === draftId;
    await tx.put(key, {title, draftId});
    return true;
  });
}

export function matchesRecordedTitle(original, source, url) {
  return Boolean(source && original?.preview?.proposed === source.title &&
    original.preview.url === url && original.preview.field === 'title');
}
