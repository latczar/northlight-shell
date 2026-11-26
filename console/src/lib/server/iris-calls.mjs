// Iris call history, read from the voice provider (ElevenLabs). The same handset checks as the demo site's staff pilot.
import "server-only";

// The provider's agent, branch and phone line are server settings (README, Iris call history). Unset means no history.
const e164 = /^\+[1-9]\d{7,14}$/;
const validId = /^conv_[A-Za-z0-9_-]{1,120}$/;

/** Iris's phone line for the desk's call link, or null when no line is set. */
export function irisLine() {
  const number = process.env.IRIS_CALL_LINE ?? '';
  return e164.test(number) ? { number, label: process.env.IRIS_CALL_LINE_LABEL || number } : null;
}

function matches(call) {
  const agent = process.env.IRIS_CALL_AGENT_ID, branch = process.env.IRIS_CALL_BRANCH_ID;
  return Boolean(agent && branch) && call?.agent_id === agent && call.branch_id === branch && call.status === 'done';
}

// Only expose calls between the assigned handset and the Iris line. The list API
// lacks handset metadata, so every transcript needs its own provider check.
export async function pilotCalls(key, cursor, caller, send = fetch, day = "") {
  const query = new URLSearchParams({agent_id:process.env.IRIS_CALL_AGENT_ID ?? '',branch_id:process.env.IRIS_CALL_BRANCH_ID ?? '',call_direction:'inbound',page_size:'5'});
  if (cursor) query.set('cursor',cursor);
  if (day) {
    // Include both UK offsets (BST and GMT) at the edges. History checks the precise UK day on each verified call.
    const earliest = Date.parse(day + 'T00:00:00+01:00') / 1000;
    const latest = Date.parse(day + 'T00:00:00+00:00') / 1000 + 86400;
    query.set('call_start_after_unix', String(earliest - 1));
    query.set('call_start_before_unix', String(latest));
  }
  const page = await get(key, send, 'conversations?'+query);
  const ids = new Set(page.conversations.filter(c=>matches(c) && c.direction==='inbound' && validId.test(c.conversation_id)).map(c=>c.conversation_id));
  const details = await Promise.allSettled(Array.from(ids, id => pilotCall(key, id, caller, send)));
  const records = details.flatMap(detail => detail.status === "fulfilled" && detail.value ? [detail.value] : []);
  const next = page.next_cursor;
  const canContinue = page.has_more === true && typeof next === 'string' && next.length > 0
    && next.length <= 2048 && next !== cursor;
  return { records, cursor: canContinue ? next : null, incomplete: details.some(detail => detail.status === "rejected") };
}

async function get(key, send, path, allowMissing = false) {
  const response = await send('https://api.elevenlabs.io/v1/convai/'+path, {
    headers:{'xi-api-key':key}, cache:'no-store', redirect:'error', signal:AbortSignal.timeout(10000),
  });
  if (allowMissing && (response.status === 404 || response.status === 410)) return null;
  if (!response.ok) {
    console.warn('Iris History provider error', {
      operation: path.startsWith('conversations/') ? 'transcript' : 'list',
      status: response.status,
    });
    throw new Error('Call history unavailable');
  }
  return response.json();
}

export async function pilotCall(key, id, caller, send = fetch) {
  if (typeof id !== "string" || !validId.test(id)) return null;
  const detail = await get(key, send, 'conversations/'+id, true);
  if (!detail) return null;
  const phone = detail.metadata?.phone_call;
  if (detail.conversation_id!==id || !matches(detail) || phone?.direction!=='inbound' || phone.agent_number!==irisLine()?.number || phone.external_number!==caller.phone) return null;
  const transcript = Array.isArray(detail.transcript) ? detail.transcript : [];
  const turns = transcript.filter(turn => ['agent', 'user'].includes(turn?.role)
    && typeof turn.message === 'string' && turn.message.trim())
    .map(turn => ({ who: turn.role === 'user' ? 'You' : 'Iris', text: turn.message }));
  const time = detail.metadata.start_time_unix_secs;
  const validTime = typeof time === 'number' && Number.isFinite(new Date(time * 1000).getTime());
  if (caller.since !== null && (!validTime || time < caller.since)) return null;
  const record = {id, time: validTime ? time : null, turns};
  const reason = detail.metadata.termination_reason;
  if (reason === "Call ended by remote party") return {...record, endedBy: "phone"};
  if (reason === "end_call tool was called." && transcript.some(turn => turn?.role === "agent" &&
      Array.isArray(turn.tool_results) && turn.tool_results.some(result =>
        result?.tool_name === "end_call" && result.is_error === false))) {
    return {...record, endedBy: "iris"};
  }
  return record;
}
