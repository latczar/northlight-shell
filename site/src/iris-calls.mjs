const validId = /^conv_[A-Za-z0-9_-]{1,120}$/;

// line: {agent, branch, number, handset} from the Worker's environment. The voice agent and branch IDs come
// from the voice provider; number is Iris's phone line and handset is the one staff phone allowed to call it.
function matches(call, line) {
  return call.agent_id === line.agent && call.branch_id === line.branch && call.status === 'done';
}

// Only expose calls between the staff handset and Iris's line. The list API
// lacks handset metadata, so every transcript needs its own provider check.
export async function pilotCalls(key, cursor, send = fetch, line) {
  if (!line?.agent || !line.branch || !line.number || !line.handset) throw new Error('Call history is not configured');
  async function get(path, allowMissing = false) {
    const response = await send('https://api.elevenlabs.io/v1/convai/'+path, {
      headers:{'xi-api-key':key}, redirect:'error', signal:AbortSignal.timeout(10000),
    });
    if (allowMissing && (response.status === 404 || response.status === 410)) return null;
    if (!response.ok) throw new Error('Call history unavailable');
    return response.json();
  }
  const query = new URLSearchParams({agent_id:line.agent,branch_id:line.branch,call_direction:'inbound',page_size:'5'});
  if (cursor) query.set('cursor',cursor);
  const page = await get('conversations?'+query);
  const ids = new Set(page.conversations.filter(c=>matches(c, line) && c.direction==='inbound' && validId.test(c.conversation_id)).map(c=>c.conversation_id));
  const records = await Promise.all(Array.from(ids, async id=>{
    const detail = await get('conversations/'+id, true);
    if (!detail) return null;
    const phone = detail.metadata?.phone_call;
    if (detail.conversation_id!==id || !matches(detail, line) || phone?.direction!=='inbound' || phone.agent_number!==line.number || phone.external_number!==line.handset) return null;
    const turns = detail.transcript.filter(t=>['agent','user'].includes(t.role) && typeof t.message==='string' && t.message.trim()).map(t=>({who:t.role==='user'?'You':'Iris',text:t.message}));
    return {time:detail.metadata.start_time_unix_secs,turns};
  }));
  return {records:records.filter(Boolean),cursor:page.has_more?page.next_cursor:null};
}
