// Times phone-call answers the way a real call runs: phone-start warms the call briefing, then the same questions are asked
// in that call's conversation. Prints what the caller would wait for; the brain's Workers Logs hold the per-step split
// (events voice_request_timing and voice_turn_timing, matched by input id).
// Usage: BRAIN_URL=https://… CLIENT_TOKEN_KESTREL=… node scripts/voice-timing.mjs
const BRAIN = process.env.BRAIN_URL ?? "https://northlight-agent.change-me.workers.dev";
const TOKEN = process.env.CLIENT_TOKEN_KESTREL;
if (!TOKEN) throw new Error("Set CLIENT_TOKEN_KESTREL.");
const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

const QUESTIONS = {
  iris: ["What's on the home page headline?", "What is the Services page title?", "What time is it?"],
};

async function ask(agent, conversationId, text) {
  const start = performance.now();
  const response = await fetch(`${BRAIN}/v1/chat/completions`, {
    method: "POST", headers: { ...auth, "x-voice-timing": "1" },
    body: JSON.stringify({ model: agent, stream: true, messages: [{ role: "user", content: text }], elevenlabs_extra_body: { conversation_id: conversationId } }),
  });
  if (!response.ok || !response.body) return { text, status: response.status };
  // Every spoken chunk with its time: the acknowledgement, a progress line or the answer are told apart by reading them,
  // not guessed from their order. After [DONE] the brain adds its own record (header x-voice-timing): request and turn
  // timings, including whether the call briefing was there.
  const chunks = [];
  let brain = null, buffer = "";
  const decoder = new TextDecoder();
  for await (const bytes of response.body) {
    buffer += decoder.decode(bytes, { stream: true });
    for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
      const data = JSON.parse(line.slice(6));
      if (data.timing) { brain = data.timing; continue; }
      const content = data.choices[0].delta.content;
      if (content) chunks.push([Math.round(performance.now() - start), content.slice(0, 60)]);
    }
  }
  return { text, totalMs: Math.round(performance.now() - start), chunks, brain };
}

for (const agent of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(QUESTIONS)) {
  const sid = `timing-${agent}-${Date.now()}`;
  const started = await fetch(`${BRAIN}/v1/voice/phone-start?agent=${agent}`, { method: "POST", headers: auth, body: JSON.stringify({ call_sid: sid }) });
  if (!started.ok) throw new Error(`phone-start for ${agent} returned ${started.status}`);
  const { custom_llm_extra_body: { conversation_id: conversationId } } = await started.json();
  // The briefing is read in the background after phone-start answers; a caller's first question comes a few seconds later.
  await new Promise(resolve => setTimeout(resolve, 6000));
  for (const question of QUESTIONS[agent]) console.log(JSON.stringify({ agent, conversationId, ...await ask(agent, conversationId, question) }));
}
