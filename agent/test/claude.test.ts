import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIENTS } from "../clients";
import type { ModelConfig, ModelMessage } from "../src/contracts";
import { ModelCutOffError } from "../src/errors";
import { ClaudeAdapter, ModelBusyError, modelFor, ProviderAdapter, usageCost, type ModelTurnRequest } from "../src/model";

const config: ModelConfig = {
  api: "claude", baseURL: "https://claude.invalid/v1/", model: "claude-test", secretEnv: "ANTHROPIC_API_KEY",
  inputCostPerMillion: 4, outputCostPerMillion: 20, cacheReadCostPerMillion: 0.2, cacheWriteCostPerMillion: 5,
  maxOutputTokens: 1000, contextWindowTokens: 100_000, extraBody: { output_config: { effort: "medium" } },
};
const chat: ModelConfig = { baseURL: "https://chat.invalid/v1", model: "chat-test", secretEnv: "OPENAI_API_KEY", inputCostPerMillion: 1, outputCostPerMillion: 1, maxOutputTokens: 1000, contextWindowTokens: 100_000 };

/** A Messages API stream of these events. */
const stream = (...events: { type: string; [field: string]: unknown }[]) => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const started = { type: "message_start", message: { usage: { input_tokens: 4, cache_creation_input_tokens: 60, cache_read_input_tokens: 5000, output_tokens: 1 } } };
const words = (index: number, ...pieces: string[]) => [
  { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  ...pieces.map(text => ({ type: "content_block_delta", index, delta: { type: "text_delta", text } })),
  { type: "content_block_stop", index },
];
const ended = (stop_reason: string, output_tokens = 9) => [{ type: "message_delta", delta: { stop_reason }, usage: { output_tokens } }, { type: "message_stop" }];
const request = (messages: ModelMessage[], more: Partial<ModelTurnRequest> = {}): ModelTurnRequest =>
  ({ config, apiKey: "test-claude-key", messages, tools: [], maxOutputTokens: 900, signal: new AbortController().signal, ...more });
const hi: ModelMessage[] = [{ role: "user", content: "hi" }];
const answers = (...responses: Response[]) => {
  const fetch = vi.spyOn(globalThis, "fetch");
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  return fetch;
};
/** A reply as Claude streams it while it works: its thinking, perhaps some words, and one tool call. */
const working = (id: string, said = "", signature = `sig-${id}`) => {
  const at = said ? 2 : 1;
  return stream(
    started,
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature } },
    { type: "content_block_stop", index: 0 },
    ...(said ? words(1, said) : []),
    { type: "content_block_start", index: at, content_block: { type: "tool_use", id, name: "read_file", input: {}, caller: { type: "direct" } } },
    { type: "content_block_delta", index: at, delta: { type: "input_json_delta", partial_json: "{\"path\":\"a.ts\"}" } },
    { type: "content_block_stop", index: at },
    ...ended("tool_use", 180),
  );
};
const done = () => stream(started, ...words(0, "Done."), ...ended("end_turn"));
const build: ModelMessage = { role: "user", content: "Build it." };
/** One finished step as the loop saves it: the call (with what was said beside it) and the tool's result. */
const step = (id: string, said: string | null = null): ModelMessage[] => [
  { role: "assistant", content: said, tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } }] },
  { role: "tool", tool_call_id: id, content: "{}" },
];
/** The assistant turns of request `n`, as sent. */
const turnsSent = (fetch: ReturnType<typeof answers>, n: number) =>
  (JSON.parse(String(fetch.mock.calls[n][1]?.body)).messages as { role: string; content: unknown }[]).filter(message => message.role === "assistant").map(message => message.content);
const written = (id: string, signature = `sig-${id}`) => [{ type: "thinking", thinking: "", signature }, { type: "tool_use", id, name: "read_file", input: { path: "a.ts" }, caller: { type: "direct" } }];
const rebuilt = (id: string) => [{ type: "tool_use", id, name: "read_file", input: { path: "a.ts" } }];

afterEach(() => { vi.restoreAllMocks(); });

describe("Claude adapter", () => {
  it("sends the conversation as the Messages API takes it", async () => {
    const fetch = answers(stream(started, ...words(0, "Done."), ...ended("end_turn")));
    await new ClaudeAdapter().turn(request([
      { role: "system", content: "You are Helper." },
      { role: "user", content: "Build the page." },
      { role: "assistant", content: null, tool_calls: [
        { id: "call:1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } },
        { id: "call_2", type: "function", function: { name: "list_sites", arguments: "" } },
      ] },
      { role: "tool", tool_call_id: "call:1", content: "{\"text\":\"x\"}" },
      { role: "tool", tool_call_id: "call_2", content: "{\"sites\":[]}" },
      { role: "user", content: [
        { type: "text", text: "Two screenshots." },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } },
        { type: "image_url", image_url: { url: "https://media.example/a.png" } },
      ] },
      // A reply with nothing in it: Claude refuses empty text, so it is left out and its neighbours are joined.
      { role: "assistant", content: "   " },
      { role: "user", content: "And the footer?" },
    ], { tools: [{ name: "read_file", description: "Reads a file.", parameters: { type: "object", properties: { path: { type: "string" } } } }] }));

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://claude.invalid/v1/messages");
    expect(init?.headers).toMatchObject({ "x-api-key": "test-claude-key", "anthropic-version": "2026-10-21" });
    expect(JSON.parse(String(init?.body))).toEqual({
      output_config: { effort: "medium" }, model: "claude-test", max_tokens: 900, stream: true, cache_control: { type: "ephemeral" },
      system: [{ type: "text", text: "You are Helper.", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "read_file", description: "Reads a file.", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "Build the page." }] },
        { role: "assistant", content: [
          // An id from another provider's turn, cut to the characters Claude allows, the same in the call and its result.
          { type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.ts" } },
          { type: "tool_use", id: "call_2", name: "list_sites", input: {} },
        ] },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "call_1", content: "{\"text\":\"x\"}" },
          { type: "tool_result", tool_use_id: "call_2", content: "{\"sites\":[]}" },
          { type: "text", text: "Two screenshots." },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
          { type: "image", source: { type: "url", url: "https://media.example/a.png" } },
          { type: "text", text: "And the footer?" },
        ] },
      ],
    });
  });

  it("reads words, tool calls and usage from the stream and keeps the thinking out of the reply", async () => {
    answers(stream(
      started,
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
      { type: "content_block_stop", index: 0 },
      ...words(1, "Let me ", "check."),
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"pa" } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "th\":\"a.ts\"}" } },
      { type: "content_block_stop", index: 2 },
      ...ended("tool_use", 180),
    ));
    const heard: string[] = [], named: string[] = [];
    const reply = await new ClaudeAdapter().turn(request(hi, { onText: delta => heard.push(delta), onToolCall: name => named.push(name) }));
    expect(reply.content).toBe("Let me check.");
    expect(heard).toEqual(["Let me ", "check."]);
    expect(named).toEqual(["read_file"]);
    expect(reply.toolCalls).toEqual([{ id: "toolu_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } }]);
    // Input is everything sent, cached or not; output is the last count, thinking included.
    expect(reply.usage).toEqual({ inputTokens: 5064, outputTokens: 180, cachedTokens: 5000, cacheWriteTokens: 60 });
    // 4 plain at $4, 5,000 read at $0.20, 60 written at $5, 180 out at $20, per million.
    expect(usageCost(config, reply.usage)).toBeCloseTo(0.004916, 9);
  });

  it("sends its own thinking back while the tool round is open, and never once someone has spoken again", async () => {
    const fetch = answers(working("toolu_1"), working("toolu_2"), done(), done());
    const adapter = new ClaudeAdapter();
    await adapter.turn(request([build]));
    await adapter.turn(request([build, ...step("toolu_1")]));
    await adapter.turn(request([build, ...step("toolu_1"), ...step("toolu_2")]));
    await adapter.turn(request([build, ...step("toolu_1"), ...step("toolu_2"), { role: "assistant", content: "Done." }, { role: "user", content: "Thanks. Now the footer." }]));
    // As Claude wrote them, in order, with fields this code knows nothing about.
    expect(turnsSent(fetch, 1)).toEqual([written("toolu_1")]);
    expect(turnsSent(fetch, 2)).toEqual([written("toolu_1"), written("toolu_2")]);
    expect(turnsSent(fetch, 3)).toEqual([rebuilt("toolu_1"), rebuilt("toolu_2"), [{ type: "text", text: "Done." }]]);
  });

  it("after a restart the round goes on without a gap: the oldest thinking may be missing, never one in the middle or at the end", async () => {
    const fetch = answers(working("toolu_1"), working("toolu_2"), done(), done());
    const before = new ClaudeAdapter(), after = new ClaudeAdapter();
    await before.turn(request([build]));
    await after.turn(request([build, ...step("toolu_1")]));
    const both = [build, ...step("toolu_1"), ...step("toolu_2")];
    // Only the newest step is remembered: it goes back as written, the one before as saved.
    await after.turn(request(both));
    expect(turnsSent(fetch, 2)).toEqual([rebuilt("toolu_1"), written("toolu_2")]);
    // The newest step is not remembered: sending the older thinking alone would leave a gap after it.
    await before.turn(request(both));
    expect(turnsSent(fetch, 3)).toEqual([rebuilt("toolu_1"), rebuilt("toolu_2")]);
  });

  it("a turn saved as something else than Claude wrote goes back as saved", async () => {
    const fetch = answers(working("toolu_1", "Let me check that for you."), done());
    const adapter = new ClaudeAdapter();
    await adapter.turn(request([build]));
    // On a call the caller heard only part of it, and only that part was saved.
    await adapter.turn(request([build, ...step("toolu_1", "Let me check.")]));
    expect(turnsSent(fetch, 1)).toEqual([[{ type: "text", text: "Let me check." }, ...rebuilt("toolu_1")]]);
  });

  it("a request refused while it carried thinking is asked once more without it; any other refusal comes straight back", async () => {
    const fetch = answers(working("toolu_1"), new Response(null, { status: 400 }), done(), new Response(null, { status: 400 }));
    const adapter = new ClaudeAdapter();
    await adapter.turn(request([build]));
    expect((await adapter.turn(request([build, ...step("toolu_1")]))).content).toBe("Done.");
    expect(turnsSent(fetch, 1)).toEqual([written("toolu_1")]);
    expect(turnsSent(fetch, 2)).toEqual([rebuilt("toolu_1")]);
    // The thinking was forgotten with the refusal, so this one has nothing to leave out.
    await expect(adapter.turn(request([build, ...step("toolu_1")]))).rejects.toMatchObject({ status: 400 });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(adapter.retainedInputEstimate([build, ...step("toolu_1")])).toBe(0);
  });

  it.each([
    ["max_tokens", "cut off by its output limit"],
    ["refusal", "ended without a finished reply"],
  ])("a reply that stopped for %s is an error, never a short answer", async (reason, message) => {
    answers(stream(started, ...words(0, "Half an ans"), ...ended(reason)));
    await expect(new ClaudeAdapter().turn(request(hi))).rejects.toThrow(message);
  });

  it("a stream that breaks off before its end is an error", async () => {
    answers(stream(started, ...words(0, "Half an ans"), { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }));
    await expect(new ClaudeAdapter().turn(request(hi))).rejects.toThrow("ended without a finished reply");
  });

  it("overloaded before a word is a busy answer the loop may retry; once words are out it is not", async () => {
    const overloaded = { type: "error", error: { type: "overloaded_error", message: "Overloaded" } };
    answers(stream(started, overloaded), stream(started, ...words(0, "Half"), overloaded), new Response(null, { status: 529, headers: { "retry-after": "1" } }));
    await expect(new ClaudeAdapter().turn(request(hi))).rejects.toMatchObject({ name: "ModelProtocolError", status: 529 });
    const late = await new ClaudeAdapter().turn(request(hi)).catch((error: unknown) => error);
    expect(late).toMatchObject({ message: "Model provider reported an error mid-stream.", status: undefined });
    const refused = await new ClaudeAdapter().turn(request(hi)).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ModelBusyError);
    expect(refused).toMatchObject({ status: 529, retryAfter: "1" });
  });

  it("counts what it will send back before it is asked: a token a byte of the replies it kept, never less than Claude counted writing them", async () => {
    const long = "s".repeat(5_000);
    const fetch = answers(working("toolu_1", "", long), working("toolu_2"), done());
    const adapter = new ClaudeAdapter();
    const one = [build, ...step("toolu_1")], two = [...one, ...step("toolu_2")];
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
    expect(adapter.retainedInputEstimate(one)).toBe(0);
    await adapter.turn(request([build]));
    const kept = bytes(written("toolu_1", long));
    expect(kept).toBeGreaterThan(5_000);
    expect(adapter.retainedInputEstimate(one)).toBe(kept);
    // Another conversation's round, a turn saved as something else than Claude wrote, a gap after it and a round that has closed send nothing back.
    expect(adapter.retainedInputEstimate([build, ...step("toolu_9")])).toBe(0);
    expect(adapter.retainedInputEstimate([build, ...step("toolu_1", "Let me check.")])).toBe(0);
    expect(adapter.retainedInputEstimate([...one, ...step("toolu_9")])).toBe(0);
    expect(adapter.retainedInputEstimate([...one, { role: "assistant", content: "Done." }, { role: "user", content: "Thanks. Now the footer." }])).toBe(0);
    await adapter.turn(request(one));
    // What was counted is what went back.
    expect(bytes(turnsSent(fetch, 1)[0])).toBe(kept);
    // The second reply is short: Claude counted 180 output tokens writing it, more than its bytes.
    expect(bytes(written("toolu_2"))).toBeLessThan(180);
    expect(adapter.retainedInputEstimate(two)).toBe(kept + 180);
    await adapter.turn(request(two));
    expect(turnsSent(fetch, 2)).toEqual([written("toolu_1", long), written("toolu_2")]);
  });

  /** A reply whose usage is `start` when it begins and `end` when it stops (`undefined`: none said). */
  const counting = (start: unknown, end: unknown, stop = "end_turn") => stream(
    { type: "message_start", message: { usage: start } }, ...words(0, "Done."),
    { type: "message_delta", delta: { stop_reason: stop }, ...(end === undefined ? {} : { usage: end }) }, { type: "message_stop" },
  );
  const begun = { input_tokens: 4, output_tokens: 1 };
  const malformed: [string, unknown, unknown][] = [
    ["nothing in the count it starts with", {}, { output_tokens: 9 }],
    ["no input count", { output_tokens: 1, cache_read_input_tokens: 5000 }, { output_tokens: 9 }],
    ["an input count of null", { input_tokens: null }, { output_tokens: 9 }],
    ["a negative input count", { input_tokens: -4 }, { output_tokens: 9 }],
    ["a fractional input count", { input_tokens: 4.5 }, { output_tokens: 9 }],
    ["an input count written as text", { input_tokens: "4" }, { output_tokens: 9 }],
    ["a negative cache read count", { input_tokens: 4, cache_read_input_tokens: -5000 }, { output_tokens: 9 }],
    ["a fractional cache write count", { input_tokens: 4, cache_creation_input_tokens: 0.5 }, { output_tokens: 9 }],
    // The count a reply starts with (one output token) is not where it ended.
    ["no final count", begun, undefined],
    ["nothing in its final count", begun, {}],
    ["a negative final output count", begun, { output_tokens: -9 }],
    ["a fractional final output count", begun, { output_tokens: 9.5 }],
  ];

  it.each(malformed)("a finished reply with %s has no usage to settle on: it fails, never free", async (_what, start, end) => {
    answers(counting(start, end));
    await expect(new ClaudeAdapter().turn(request(hi))).rejects.toThrow("did not report usage");
  });

  it.each(["1e999", "-1e999", "9007199254740993"])("a final output count of %s on the wire is no usage either", async literal => {
    // JSON carries no infinity, but a number too large to read becomes one.
    const text = await counting(begun, { output_tokens: "COUNT" }).text();
    answers(new Response(text.replace("\"COUNT\"", literal)));
    await expect(new ClaudeAdapter().turn(request(hi))).rejects.toThrow("did not report usage");
  });

  it.each(malformed)("a reply cut off with %s carries no usage, so its reservation stays", async (_what, start, end) => {
    answers(counting(start, end, "max_tokens"));
    const cut = await new ClaudeAdapter().turn(request(hi)).catch((error: unknown) => error);
    expect(cut).toBeInstanceOf(ModelCutOffError);
    expect((cut as ModelCutOffError).usage).toBeUndefined();
  });

  it("a cut-off reply with whole counts carries them; the cache's may be absent or null, and zero is a count", async () => {
    answers(counting(begun, { output_tokens: 900 }, "max_tokens"), counting({ input_tokens: 0, cache_read_input_tokens: null }, { output_tokens: 0 }));
    const cut = await new ClaudeAdapter().turn(request(hi)).catch((error: unknown) => error);
    expect(cut).toBeInstanceOf(ModelCutOffError);
    expect((cut as ModelCutOffError).usage).toEqual({ inputTokens: 4, outputTokens: 900, cachedTokens: 0, cacheWriteTokens: 0 });
    expect((await new ClaudeAdapter().turn(request(hi))).usage).toEqual({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 });
  });
});

describe("models per agent", () => {
  it("a model without cache prices still counts cached input at the input price", () => {
    expect(usageCost(chat, { inputTokens: 100, outputTokens: 10, cachedTokens: 80 })).toBeCloseTo(0.00011, 9);
  });

  it("asks each model in its own protocol", async () => {
    const fetch = answers(
      stream(started, ...words(0, "Claude here."), ...ended("end_turn")),
      new Response("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Chat here.\"},\"finish_reason\":\"stop\"}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n"),
    );
    const adapter = new ProviderAdapter();
    expect((await adapter.turn(request(hi))).content).toBe("Claude here.");
    expect((await adapter.turn(request(hi, { config: chat }))).content).toBe("Chat here.");
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://claude.invalid/v1/messages", "https://chat.invalid/v1/chat/completions"]);
  });

  it("counts kept thinking for the model that keeps it, and nothing for any other", async () => {
    answers(working("toolu_1"));
    const adapter = new ProviderAdapter();
    await adapter.turn(request([build]));
    const round = [build, ...step("toolu_1")];
    expect(adapter.retainedInputEstimate(round, config)).toBe(180);
    expect(adapter.retainedInputEstimate(round, chat)).toBe(0);
  });

  it.each([
    ["no counts", "{}"],
    ["no output count", "{\"prompt_tokens\":3}"],
    ["a negative input count", "{\"prompt_tokens\":-3,\"completion_tokens\":2}"],
    ["a fractional output count", "{\"prompt_tokens\":3,\"completion_tokens\":2.5}"],
    ["an output count too large to read", "{\"prompt_tokens\":3,\"completion_tokens\":1e999}"],
    ["more read from the cache than was sent", "{\"prompt_tokens\":3,\"completion_tokens\":2,\"prompt_tokens_details\":{\"cached_tokens\":300}}"],
  ])("a Chat Completions reply with %s has no usage to settle on", async (_what, usage) => {
    const reply = (finish: string) => new Response(`data: {"choices":[{"index":0,"delta":{"content":"Chat here."},"finish_reason":"${finish}"}]}\n\ndata: {"choices":[],"usage":${usage}}\n\ndata: [DONE]\n\n`);
    answers(reply("stop"), reply("length"));
    const adapter = new ProviderAdapter();
    await expect(adapter.turn(request(hi, { config: chat }))).rejects.toThrow("did not report usage");
    const cut = await adapter.turn(request(hi, { config: chat })).catch((error: unknown) => error);
    expect(cut).toBeInstanceOf(ModelCutOffError);
    expect((cut as ModelCutOffError).usage).toBeUndefined();
  });

  it("uses the configured Claude connection for Helper's staff work, and the client's own model for Iris and for calls", () => {
    const acme = CLIENTS.find(client => client.id === "acme")!;
    expect(modelFor(acme, "helper")).toMatchObject({ api: "claude", model: "claude-opus-5-5", secretEnv: "ANTHROPIC_API_KEY" });
    expect(modelFor(acme, "helper", true)).toBe(acme.model);
    const kestrel = CLIENTS.find(client => client.id === "kestrel")!;
    expect(modelFor(kestrel, "iris")).toBe(kestrel.model);
    expect(modelFor(kestrel, "iris")).toMatchObject({ model: "gpt-5.4-mini", secretEnv: "OPENAI_API_KEY" });
    expect(modelFor(kestrel, "iris", true)).toBe(kestrel.model);
    const others = CLIENTS.flatMap(client => client.agents.filter(agent => !(client === acme && agent === "helper")).map(agent => [client, agent] as const));
    expect(others.length).toBeGreaterThan(0);
    for (const [client, agent] of others) expect(modelFor(client, agent), `${client.id}/${agent}`).toBe(client.model);
  });
});
