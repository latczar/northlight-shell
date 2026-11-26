// Preloaded only by the Playwright test server. Both users receive the same upstream list.
const originalFetch = globalThis.fetch;
const stories = {
  conv_alpha: ["+441632960101", "Services alpha alignment", 1800000000],
  conv_beta: ["+441632960102", "Services beta brakes", 1800000010],
  conv_before: ["+441632960102", "Services previous handset owner", 1600000000],
};
const recoveryAttempts = new Set();
const summary = id => ({
  conversation_id: id, agent_id: "agent_demo_iris_0001",
  branch_id: "agtbrch_demo_iris_0001", direction: "inbound", status: "done",
});
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname !== "api.elevenlabs.io") return originalFetch(input, init);
  if (url.pathname === "/v1/convai/conversations/conv_hours") {
    return Response.json({ ...summary("conv_hours"), metadata: { start_time_unix_secs: 1800000010, phone_call: {
      direction: "inbound", agent_number: "+441632960001", external_number: "+441632960102",
    } }, transcript: [{ role: "agent", message: "Would you like to review Services?" }, { role: "user", message: "Only the hours, thanks." }] });
  }
  if (url.pathname === "/v1/convai/conversations") {
    const cursor = url.searchParams.get("cursor") ?? "";
    if (cursor === "partial-detail") {
      return Response.json({ conversations: [summary("conv_beta"), summary("conv_unavailable")], has_more: true, next_cursor: "after-partial" });
    }
    if (cursor === "after-partial") {
      return Response.json({ conversations: [summary("conv_resumed"), summary("conv_alpha")], has_more: false });
    }
    if (cursor.startsWith("interrupted-")) {
      return Response.json({ conversations: [summary("conv_beta")], has_more: true, next_cursor: "resume-" + cursor });
    }
    if (cursor.startsWith("resume-interrupted-")) {
      if (!recoveryAttempts.has(cursor)) {
        recoveryAttempts.add(cursor);
        return new Response(null, { status: 503 });
      }
      return Response.json({ conversations: [summary("conv_resumed")], has_more: false });
    }
    return Response.json({ conversations: Object.keys(stories).map(summary), has_more: false });
  }
  const id = url.pathname.split("/").pop();
  if (id === "conv_unavailable") return new Response(null, { status: 503 });
  const recoveringDraft = id === "conv_retry_desktop" || id === "conv_retry_mobile";
  if (recoveringDraft && !recoveryAttempts.has(id)) {
    recoveryAttempts.add(id);
    return new Response(null, { status: 503 });
  }
  if (id === "conv_resumed" || id === "conv_archived_source" || recoveringDraft) {
    return Response.json({ ...summary(id), metadata: { start_time_unix_secs: 1800000011, phone_call: {
      direction: "inbound", agent_number: "+441632960001", external_number: "+441632960102",
    } }, transcript: [{ role: "user", message: "Services after the interruption" }] });
  }
  if (!Object.hasOwn(stories, id)) return new Response(null, { status: 404 });
  const [external_number, message, start_time_unix_secs] = stories[id];
  return Response.json({
    ...summary(id), metadata: { start_time_unix_secs,
      termination_reason: id === "conv_alpha" ? "end_call tool was called." : "Call ended by remote party", phone_call: {
      direction: "inbound", agent_number: "+441632960001", external_number,
    } }, transcript: [
      { role: "user", message },
      { role: "agent", message: "I checked Kestrel Garage's Services page." },
      ...(id === "conv_alpha" ? [{ role: "agent", tool_results: [{ tool_name: "end_call", is_error: false }] }] : []),
    ],
  });
};
