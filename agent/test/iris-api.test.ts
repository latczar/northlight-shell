import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signUserPass } from "../src/user-auth";
import type { ModelAdapter } from "../src/model";

const headers = { authorization: "Bearer test-token-kestrel-0123456789abcdef", "content-type": "application/json" };
const key = "test-signing-key-kestrel-0123456789abcdef";
const expires = () => Math.floor(Date.now() / 1000) + 3600;

async function installFake(conversationId: string) {
  const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`kestrel/iris/${conversationId}`));
  await runInDurableObject(stub, (instance, state) => {
    instance.model = {
      async turn(request) {
        await state.storage.put("test-model-calls", (await state.storage.get<number>("test-model-calls") ?? 0) + 1);
        request.onText?.("I can review the page title and headings.");
        return { content: "I can review the page title and headings.", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } };
      },
    } satisfies ModelAdapter;
  });
  return stub;
}

describe("Iris staff app API", () => {
  it("authenticates Kestrel's client and hides other clients' agents", async () => {
    const route = "https://brain/v1/agents/iris/conversations/website-auth/messages";
    expect((await SELF.fetch(route, { method: "POST", body: '{}' })).status).toBe(401);
    expect((await SELF.fetch(route, { method: "POST", headers: { ...headers, authorization: "Bearer test-token-acme-0123456789abcdef" }, body: '{}' })).status).toBe(404);
    expect((await SELF.fetch("https://brain/v1/agents/helper/conversations/website-auth", { headers })).status).toBe(404);
    for (const id of ["charlie", "charlie-staff", "second", "helper"]) expect((await SELF.fetch(`https://brain/v1/agents/${id}/setup`, { headers })).status).toBe(404);
    const setup = await (await SELF.fetch("https://brain/v1/agents/iris/setup", { headers })).json() as { items: { id: string; connected: boolean }[] };
    expect(setup.items.find(item => item.id === "website")?.connected).toBe(true);
  });

  it("streams a signed visitor's reply, reuses a retry and refuses a different person", async () => {
    const conversation = `web-${crypto.randomUUID()}`;
    const stub = await installFake(conversation);
    const route = `https://brain/v1/agents/iris/conversations/${conversation}/messages`;
    const body = { id: crypto.randomUUID(), text: "Can you review our homepage?", userAuth: await signUserPass(key, "kestrel", "web:visitor-one", expires()) };
    for (let i = 0; i < 2; i++) {
      const response = await SELF.fetch(route, { method: "POST", headers, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(await response.text()).toContain("I can review the page title and headings.");
    }
    await runInDurableObject(stub, async (_instance, state) => { expect(await state.storage.get("test-model-calls")).toBe(1); });
    const other = { ...body, id: crypto.randomUUID(), userAuth: await signUserPass(key, "kestrel", "web:visitor-two", expires()) };
    expect((await SELF.fetch(route, { method: "POST", headers, body: JSON.stringify(other) })).status).toBe(409);
    expect((await SELF.fetch(route, { method: "POST", headers, body: JSON.stringify({ ...body, userAuth: "forged" }) })).status).toBe(401);
  });

  it("serves a signed Iris voice request as OpenAI-compatible SSE", async () => {
    const conversation = `voice-web:voice-visitor-${crypto.randomUUID()}`;
    await installFake(conversation);
    const response = await SELF.fetch("https://brain/v1/chat/completions", {
      method: "POST", headers,
      body: JSON.stringify({ model: "iris", stream: true, messages: [{ role: "user", content: "Can you review our homepage?" }],
        elevenlabs_extra_body: { conversation_id: conversation, user_auth: await signUserPass(key, "kestrel", "web:voice-visitor", expires()) } }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"object":"chat.completion.chunk"');
    expect(body).toContain("I can review the page title and headings.");
    expect(body).toContain("data: [DONE]");
  });

  it("stays quiet when ElevenLabs sends its silence prompt, without a model call or a saved turn", async () => {
    // ElevenLabs sends "..." as the caller's words after a few seconds of silence (measured 2026-11-26: every ~11 s).
    const conversation = `voice-web:voice-visitor-${crypto.randomUUID()}`;
    const stub = await installFake(conversation);
    const userAuth = await signUserPass(key, "kestrel", "web:voice-visitor", expires());
    for (const [index, said] of ["...", " … ", ". . ."].entries()) {
      const messages = [{ role: "user", content: "Hello" }, { role: "assistant", content: "Hi." }, { role: "user", content: said }];
      const response = await SELF.fetch("https://brain/v1/chat/completions", {
        method: "POST", headers,
        body: JSON.stringify({ model: "iris", stream: true, messages: messages.slice(index ? 2 : 0), elevenlabs_extra_body: { conversation_id: conversation, user_auth: userAuth } }),
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('"finish_reason":"stop"');
      expect(body).toContain("data: [DONE]");
      expect(body).not.toContain('"content"');
    }
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.get<number>("test-model-calls"))).toBeUndefined();
  });
});
