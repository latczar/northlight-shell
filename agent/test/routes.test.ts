import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ModelAdapter } from "../src/model";

const ACME = "test-token-acme-0123456789abcdef";
const auth = (token = ACME) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

/** Installs a fake model in the conversation object that `name` routes to. */
async function fakeModel(name: string, text: string) {
  const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(name));
  await runInDurableObject(stub, instance => {
    instance.model = {
      async turn(request) {
        request.onText?.(text);
        return { content: text, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } };
      },
    } satisfies ModelAdapter;
  });
}

function sseData(body: string): string[] {
  return body.split("\n\n").filter(Boolean).map(block => block.replace(/^data: /, ""));
}

describe("routes", () => {
  it("rejects missing and wrong tokens", async () => {
    const none = await SELF.fetch("https://brain/v1/agents/third/conversations/c1");
    expect(none.status).toBe(401);
    const wrong = await SELF.fetch("https://brain/v1/agents/third/conversations/c1", { headers: auth("x".repeat(32)) });
    expect(wrong.status).toBe(401);
  });

  it("hides agents the client does not have", async () => {
    const response = await SELF.fetch("https://brain/v1/agents/iris/conversations/c1/messages", {
      method: "POST", headers: auth(), body: JSON.stringify({ text: "hi" }),
    });
    expect(response.status).toBe(404);
  });

  it("streams a chat reply as server-sent events", async () => {
    await fakeModel("beacon/third/chat-1", "Hello from Third.");
    const response = await SELF.fetch("https://brain/v1/agents/third/conversations/chat-1/messages", {
      method: "POST", headers: auth("test-token-beacon-0123456789abcdef"), body: JSON.stringify({ id: "m1", text: "hi" }),
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const events = sseData(await response.text()).map(data => JSON.parse(data));
    expect(events).toEqual([
      { type: "text", delta: "Hello from Third." },
      { type: "done", status: "replied", text: "Hello from Third." },
    ]);
  });

  it("serves an OpenAI-style completion stream for ElevenLabs", async () => {
    await fakeModel("acme/helper/call-42", "Hi, this is Helper.");
    const response = await SELF.fetch("https://brain/v1/chat/completions", {
      method: "POST", headers: auth(),
      body: JSON.stringify({
        model: "helper", stream: true,
        messages: [{ role: "system", content: "ignored" }, { role: "user", content: "Who is this?" }],
        elevenlabs_extra_body: { conversation_id: "call-42" },
      }),
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const data = sseData(await response.text());
    expect(data.at(-1)).toBe("[DONE]");
    const chunks = data.slice(0, -1).map(item => JSON.parse(item));
    expect(chunks.every(c => c.object === "chat.completion.chunk" && c.choices[0].index === 0)).toBe(true);
    expect(chunks[0].choices[0].delta).toEqual({ role: "assistant" });
    // A quick answer has no acknowledgement in front of it.
    expect(chunks.map(c => c.choices[0].delta.content ?? "").join("")).toBe("Hi, this is Helper.");
    expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
  });

  it("adds the timing record after [DONE] only for the timing script's header", async () => {
    await fakeModel("acme/helper/call-43", "Hi, this is Helper.");
    const response = await SELF.fetch("https://brain/v1/chat/completions", {
      method: "POST", headers: { ...auth(), "x-voice-timing": "1" },
      body: JSON.stringify({ model: "helper", stream: true, messages: [{ role: "user", content: "Who is this?" }], elevenlabs_extra_body: { conversation_id: "call-43" } }),
    });
    const data = sseData(await response.text());
    expect(data.at(-2)).toBe("[DONE]");
    const { timing } = JSON.parse(data.at(-1)!);
    expect(timing.request).toMatchObject({ event: "voice_request_timing", agent: "helper" });
    expect(timing.turn).toMatchObject({ event: "voice_turn_timing", status: "replied", briefing: false });
    expect(timing.turn.steps[0]).toMatchObject({ step: "model", tools: 0 });
  });

  it("requires a conversation id on the ElevenLabs endpoint", async () => {
    const response = await SELF.fetch("https://brain/v1/chat/completions", {
      method: "POST", headers: auth(),
      body: JSON.stringify({ model: "helper", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(response.status).toBe(400);
  });

  it("gives an inbound phone call its own conversation, so the call's replies work", async () => {
    const unauthenticated = await SELF.fetch("https://brain/v1/voice/phone-start", { method: "POST", body: "{}" });
    expect(unauthenticated.status).toBe(401);
    expect((await SELF.fetch("https://brain/v1/voice/phone-start", { method: "POST", headers: auth(), body: JSON.stringify({ caller_id: "+1" }) })).status).toBe(400);

    const start = await SELF.fetch("https://brain/v1/voice/phone-start", {
      method: "POST", headers: auth(),
      body: JSON.stringify({ caller_id: "+15551234567", called_number: "+15555550100", call_sid: "CAabc123def456", conversation_id: "conv_1" }),
    });
    const init = await start.json() as { type: string; custom_llm_extra_body: { conversation_id: string } };
    expect(init).toMatchObject({ type: "conversation_initiation_client_data", custom_llm_extra_body: { conversation_id: "phone-CAabc123def456" } });

    // ElevenLabs sends that extra body with every reply request of the call.
    await fakeModel("acme/helper/phone-CAabc123def456", "Yes, I can hear you.");
    const reply = await SELF.fetch("https://brain/v1/chat/completions", {
      method: "POST", headers: auth(),
      body: JSON.stringify({ model: "helper", stream: true, messages: [{ role: "user", content: "Can you hear me?" }], elevenlabs_extra_body: init.custom_llm_extra_body }),
    });
    expect(reply.status).toBe(200);
    expect(sseData(await reply.text()).slice(0, -1).map(item => JSON.parse(item).choices[0].delta.content ?? "").join("")).toBe("Yes, I can hear you.");
  });

  it("keeps conversations with the same id separate per agent", async () => {
    await fakeModel("acme/helper/shared", "helper");
    await fakeModel("acme/second/shared", "second");
    for (const agent of ["helper", "second"]) {
      const response = await SELF.fetch(`https://brain/v1/agents/${agent}/conversations/shared/messages`, {
        method: "POST", headers: auth(), body: JSON.stringify({ text: "hi" }),
      });
      expect(sseData(await response.text()).map(d => JSON.parse(d)).at(-1)).toMatchObject({ text: agent });
    }
  });
});
