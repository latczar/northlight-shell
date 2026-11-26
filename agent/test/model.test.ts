import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelConfig } from "../src/contracts";
import { CompatibleChatAdapter, ModelBusyError, ModelConnectionError } from "../src/model";

const config: ModelConfig = {
  baseURL: "https://model.invalid/v1", model: "m", secretEnv: "KEY", inputCostPerMillion: 1, outputCostPerMillion: 1,
  maxOutputTokens: 4000, contextWindowTokens: 128000,
};

/** Sends one turn and returns the JSON body the adapter posted. */
async function sentBody(cfg: ModelConfig): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"Hi."},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  });
  await new CompatibleChatAdapter().turn({ config: cfg, apiKey: "k", messages: [{ role: "user", content: "hi" }], tools: [], maxOutputTokens: 4000, signal: new AbortController().signal });
  return body;
}

afterEach(() => vi.restoreAllMocks());

describe("model adapter", () => {
  it("sends max_tokens by default and the configured field for models that reject it", async () => {
    const plain = await sentBody(config);
    expect(plain.max_tokens).toBe(4000);
    expect(plain).not.toHaveProperty("max_completion_tokens");

    const openai = await sentBody({ ...config, maxTokensParam: "max_completion_tokens", extraBody: { reasoning_effort: "none" } });
    expect(openai.max_completion_tokens).toBe(4000);
    expect(openai).not.toHaveProperty("max_tokens");
    expect(openai.reasoning_effort).toBe("none");
  });

  it("reports a refused request by its status only, so the loop can tell a refused image from an outage", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: { code: "invalid_image_url", message: "secret-looking detail" } }), { status: 400 }));
    const failed = await new CompatibleChatAdapter().turn({ config, apiKey: "k", messages: [{ role: "user", content: "hi" }], tools: [], maxOutputTokens: 4000, signal: new AbortController().signal })
      .catch((error: unknown) => error);
    expect(failed).toMatchObject({ name: "ModelProtocolError", status: 400, message: "Model provider returned HTTP 400." });
  });

  it("keeps Retry-After on busy refusals without exposing the provider's error body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("secret-looking detail", { status: 429, headers: { "retry-after": "2" } }));
    const failed = await new CompatibleChatAdapter().turn({ config, apiKey: "k", messages: [], tools: [], maxOutputTokens: 10, signal: new AbortController().signal }).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(ModelBusyError);
    expect(failed).toMatchObject({ status: 429, retryAfter: "2", message: "Model provider returned HTTP 429." });
  });

  it("identifies a network failure before a response, preserving the original failure", async () => {
    const original = new TypeError("network unavailable");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(original);
    const failed = await new CompatibleChatAdapter().turn({ config, apiKey: "k", messages: [], tools: [], maxOutputTokens: 10, signal: new AbortController().signal }).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(ModelConnectionError);
    expect(failed).toMatchObject({ original });
  });

  it("does not label our own abort a retryable network failure", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(controller.signal.reason);
    const failed = await new CompatibleChatAdapter().turn({ config, apiKey: "k", messages: [], tools: [], maxOutputTokens: 10, signal: controller.signal }).catch((error: unknown) => error);
    expect(failed).toBe(controller.signal.reason);
  });

  it("does not label a broken response stream a retryable network failure, even before any text", async () => {
    const original = new TypeError("stream disconnected");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(original); },
    })));
    const failed = await new CompatibleChatAdapter().turn({ config, apiKey: "k", messages: [], tools: [], maxOutputTokens: 10, signal: new AbortController().signal }).catch((error: unknown) => error);
    expect(failed).toBe(original);
  });
});
