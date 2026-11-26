import type { ChatMessage, ClientConfig, JsonObject, ModelConfig, ModelMessage, ModelTool, ToolCall, Usage } from "./contracts";
import { ModelCutOffError, ModelProtocolError } from "./errors";

// Streaming model adapters with plain fetch: Chat Completions, Responses and Anthropic's Messages API.
// All return native tool calls; ProviderAdapter selects the protocol explicitly from ModelConfig.api.

export interface ModelTurnRequest {
  config: ModelConfig;
  apiKey: string;
  messages: ModelMessage[];
  tools: ModelTool[];
  maxOutputTokens: number;
  signal: AbortSignal;
  /** Called with user-facing text as it streams. */
  onText?(delta: string): void;
  /** Called once per tool call, as soon as the stream names it (before its arguments finish). */
  onToolCall?(name: string): void;
}

export interface ModelTurnReply { content: string; toolCalls: ToolCall[]; usage: Usage }

export interface ModelAdapter {
  turn(request: ModelTurnRequest): Promise<ModelTurnReply>;
  /**
   * A ceiling on the input tokens `turn` will send for `messages` beyond what they hold themselves (kept
   * provider reasoning). The cost reservation adds it before the request, at the dearest input price. Absent: nothing more is sent.
   */
  retainedInputEstimate?(messages: ModelMessage[], config: ModelConfig): number;
}

/** A provider's count as money may be settled on it: a whole number, never below zero. */
const counted = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** A fetch failure before the provider sent a response, never a broken response stream. */
export class ModelConnectionError extends Error {
  constructor(readonly original: unknown) {
    super("Model provider could not be reached.");
    this.name = "ModelConnectionError";
  }
}

/** A refusal before any reply; the loop owns the retry and its time and cost allowance. */
export class ModelBusyError extends ModelProtocolError {
  constructor(status: number, readonly retryAfter: string | null) {
    super(`Model provider returned HTTP ${status}.`, status);
  }
}

interface StreamChunk {
  choices?: {
    index: number;
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } | null } | null;
  error?: { message?: string };
}

export class CompatibleChatAdapter implements ModelAdapter {
  async turn(request: ModelTurnRequest): Promise<ModelTurnReply> {
    const { config } = request;
    const body = await send(`${config.baseURL.replace(/\/$/, "")}/chat/completions`, request, { authorization: `Bearer ${request.apiKey}` }, {
      ...config.extraBody,
      model: config.model,
      messages: request.messages,
      ...(request.tools.length
        ? { tools: request.tools.map(tool => ({ type: "function", function: tool })) }
        : {}),
      [config.maxTokensParam ?? "max_tokens"]: request.maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true },
    });

    const calls = new Map<number, ToolCall>();
    let content = "";
    let finish: string | undefined;
    let usage: Usage | undefined;
    const named = new Set<number>();
    for await (const chunk of sseData(body)) {
      if (chunk === "[DONE]") break;
      let parsed: StreamChunk;
      try { parsed = JSON.parse(chunk); } catch { throw new ModelProtocolError("Model provider sent invalid stream data."); }
      if (parsed.error) throw new ModelProtocolError("Model provider reported an error mid-stream.");
      if (parsed.usage) {
        // Counts that cannot be settled on are no usage at all (more read from the cache than was sent would cost less than nothing).
        const { prompt_tokens: inputTokens, completion_tokens: outputTokens } = parsed.usage, cachedTokens = parsed.usage.prompt_tokens_details?.cached_tokens ?? 0;
        usage = counted(inputTokens) && counted(outputTokens) && counted(cachedTokens) && cachedTokens <= inputTokens ? { inputTokens, outputTokens, cachedTokens } : undefined;
      }
      for (const choice of parsed.choices ?? []) {
        if (choice.index !== 0) throw new ModelProtocolError("Multiple model choices are unsupported.");
        if (choice.finish_reason) finish = choice.finish_reason;
        const delta = choice.delta;
        if (delta?.content) {
          content += delta.content;
          request.onText?.(delta.content);
        }
        for (const part of delta?.tool_calls ?? []) {
          const call = calls.get(part.index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
          call.id += part.id ?? "";
          call.function.name += part.function?.name ?? "";
          call.function.arguments += part.function?.arguments ?? "";
          calls.set(part.index, call);
          if (call.function.name && !named.has(part.index)) { named.add(part.index); request.onToolCall?.(call.function.name); }
        }
      }
    }
    if (finish === "length") throw new ModelCutOffError(usage);
    if (finish !== "stop" && finish !== "tool_calls") throw new ModelProtocolError("Model stream ended without a finished reply.");
    // A paid request without usage it can be settled on must not look free; the caller keeps the reservation.
    if (!usage) throw new ModelProtocolError("Model provider did not report usage.");
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    if (toolCalls.some(call => !call.id || !call.function.name)) throw new ModelProtocolError("Model returned an incomplete tool call.");
    return { content, toolCalls, usage };
  }
}

/** Sends one streamed request and hands back its body. Provider error bodies can echo request details; only the status is reported. */
async function send(url: string, request: ModelTurnRequest, auth: Record<string, string>, body: unknown): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(url, {
    method: "POST",
    signal: request.signal,
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify(body),
  }).catch((error: unknown) => {
    if (request.signal.aborted) throw error;
    throw new ModelConnectionError(error);
  });
  if (response.status === 429 || response.status >= 500 && response.status <= 599) {
    const error = new ModelBusyError(response.status, response.headers.get("retry-after"));
    await response.body?.cancel().catch(() => {});
    throw error;
  }
  if (!response.ok || !response.body) throw new ModelProtocolError(`Model provider returned HTTP ${response.status}.`, response.status);
  return response.body;
}

/** Calls use the client's fast model; off calls an agent may have its own. */
export const modelFor = (client: ClientConfig, agentId: string, voice = false): ModelConfig => voice ? client.model : client.agentModels?.[agentId] ?? client.model;

/** What a finished request cost. Cache reads and writes count at their own prices where the config has them. */
export function usageCost(config: ModelConfig, usage: Usage): number {
  const read = usage.cachedTokens ?? 0, written = usage.cacheWriteTokens ?? 0;
  return ((usage.inputTokens - read - written) * config.inputCostPerMillion
    + read * (config.cacheReadCostPerMillion ?? config.inputCostPerMillion)
    + written * (config.cacheWriteCostPerMillion ?? config.inputCostPerMillion)
    + usage.outputTokens * config.outputCostPerMillion) / 1_000_000;
}

/** The price a reservation counts input at before the call: the dearest it can be billed at (a cache write costs more than plain input). */
export const inputReservePrice = (config: ModelConfig): number => Math.max(config.inputCostPerMillion, config.cacheWriteCostPerMillion ?? 0);

const CLAUDE_VERSION = "2026-10-21";

type ClaudeBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };
/** `JsonObject`: a block of Claude's own reply (thinking included), sent back exactly as it came. */
interface ClaudeMessage { role: "user" | "assistant"; content: (ClaudeBlock | JsonObject)[] }
interface ClaudeUsage { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }
interface ClaudeEvent {
  type: string;
  index?: number;
  message?: { usage?: ClaudeUsage };
  content_block?: JsonObject & { type: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string; stop_reason?: string | null };
  usage?: ClaudeUsage;
  error?: { type?: string };
}
/** A reply as Claude wrote it, and a ceiling on the input tokens sending it back adds (ClaudeAdapter.retainedInputEstimate). */
interface OwnReply { blocks: JsonObject[]; tokens: number }
/** Claude's replies by their first tool call's id (ClaudeAdapter.own). */
type OwnReplies = ReadonlyMap<string, OwnReply>;

/** Claude's tool ids hold only these characters; ids saved from another provider's turns may hold more. */
const claudeId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");

function claudeImage(url: string): ClaudeBlock {
  const inline = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  return { type: "image", source: inline ? { type: "base64", media_type: inline[1], data: inline[2] } : { type: "url", url } };
}

/** Saved arguments are the model's own text; Claude takes them back only as an object. */
function toolInput(raw: string): unknown {
  try {
    const value: unknown = JSON.parse(raw || "{}");
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

/** What Claude wrote for this saved turn, if it is still that turn: a call's reply is saved as spoken, which can be less. */
function ownReply(message: Extract<ChatMessage, { role: "assistant" }>, own?: OwnReplies): OwnReply | undefined {
  const reply = own?.get(message.tool_calls?.[0]?.id ?? "");
  if (!reply) return undefined;
  const said = reply.blocks.flatMap(block => block.type === "text" ? [String(block.text)] : []).join("");
  const called = reply.blocks.flatMap(block => block.type === "tool_use" ? [String(block.id)] : []);
  return said === (message.content ?? "") && called.join("\n") === (message.tool_calls ?? []).map(call => call.id).join("\n") ? reply : undefined;
}

/** Where Claude's own replies go back from: the open tool round's unbroken run of them up to the newest (claudeMessages). */
function ownFrom(messages: ModelMessage[], own?: OwnReplies): number {
  let from = messages.findLastIndex(message => message.role === "user" || message.role === "system") + 1;
  messages.forEach((message, i) => { if (i >= from && message.role === "assistant" && !ownReply(message, own)) from = i + 1; });
  return from;
}

/**
 * The conversation as the Messages API takes it: system messages become the one `system` text, a tool's result is a
 * user block, and neighbours of one role are joined (Claude wants the roles to alternate). Empty text is left out:
 * Claude refuses it. With `own`, Claude's replies in the tool round still open (everything after the last thing a
 * person or the runtime said) go back as it wrote them, thinking included, so it works on from its reasoning instead of
 * thinking it all again; only as an unbroken run up to the newest reply (the oldest may be left out, a gap may not).
 * `kept` says whether any did.
 */
export function claudeMessages(messages: ModelMessage[], own?: OwnReplies): { system: string; messages: ClaudeMessage[]; kept: boolean } {
  const system: string[] = [];
  const out: ClaudeMessage[] = [];
  const add = (role: ClaudeMessage["role"], blocks: ClaudeMessage["content"]) => {
    if (!blocks.length) return;
    const last = out.at(-1);
    if (last?.role === role) last.content.push(...blocks); else out.push({ role, content: blocks });
  };
  const text = (value: string | null): ClaudeBlock[] => value?.trim() ? [{ type: "text", text: value }] : [];
  const from = ownFrom(messages, own);
  let kept = false;
  messages.forEach((message, i) => {
    if (message.role === "system") system.push(message.content);
    else if (message.role === "tool") add("user", [{ type: "tool_result", tool_use_id: claudeId(message.tool_call_id), content: message.content }]);
    else if (message.role === "assistant") {
      const written = i >= from ? ownReply(message, own)?.blocks : undefined;
      kept ||= written !== undefined;
      add("assistant", written ?? [
        ...text(message.content),
        ...(message.tool_calls ?? []).map((call): ClaudeBlock => ({ type: "tool_use", id: claudeId(call.id), name: call.function.name, input: toolInput(call.function.arguments) })),
      ]);
    } else add("user", typeof message.content === "string" ? text(message.content)
      : message.content.flatMap(part => part.type === "text" ? text(part.text) : [claudeImage(part.image_url.url)]));
  });
  return { system: system.join("\n\n"), messages: out, kept };
}

/** Replies remembered for sending back: more than one tool round ever needs. */
const OWN_REPLIES = 32;

/**
 * Anthropic's Messages API, streamed, with automatic prompt caching. Claude thinks before every reply and that thinking
 * counts as output; a reply that calls tools is remembered as written and sent back while its tool round is open, or
 * Claude thinks the whole job through again at every step (measured 2026-11-17: 22,000 to 30,000 tokens each time on a
 * site build). Remembered in this object only: after a restart the round goes on without it, which Claude accepts.
 */
export class ClaudeAdapter implements ModelAdapter {
  private readonly own = new Map<string, OwnReply>();

  /** The input tokens the replies `turn` would send back for `messages` can add: the same replies, by the same rule. */
  retainedInputEstimate(messages: ModelMessage[]): number {
    if (!this.own.size) return 0;
    let tokens = 0;
    for (let i = ownFrom(messages, this.own); i < messages.length; i++) {
      const message = messages[i];
      if (message.role === "assistant") tokens += ownReply(message, this.own)?.tokens ?? 0;
    }
    return tokens;
  }

  async turn(request: ModelTurnRequest): Promise<ModelTurnReply> {
    const { config } = request;
    const asking = (own?: OwnReplies) => {
      const { system, messages, kept } = claudeMessages(request.messages, own);
      return { kept, body: {
        ...config.extraBody,
        model: config.model,
        // Covers the reply and the thinking before it.
        max_tokens: request.maxOutputTokens,
        stream: true,
        // Each step of a job sends everything before it again; read back from the cache, that part costs a twentieth.
        cache_control: { type: "ephemeral" },
        // The tools and instructions are cached on their own too, so a request whose messages differ (a call's first words
        // after its practice request, a job's next segment) still reads them back (checked against claude-opus-5-5, 2026-11-17).
        ...(system ? { system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] } : {}),
        ...(request.tools.length
          ? { tools: request.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) }
          : {}),
        messages,
      } };
    };
    const url = `${config.baseURL.replace(/\/$/, "")}/messages`;
    const auth = { "x-api-key": request.apiKey, "anthropic-version": CLAUDE_VERSION };
    const first = asking(this.own);
    const body = await send(url, request, auth, first.body).catch((error: unknown) => {
      // Thinking sent back can be refused once something under it has changed (a picture no longer attached to an earlier
      // message). It is forgotten and the request asked once more without it; a refusal for another reason comes back again.
      if (!first.kept || !(error instanceof ModelProtocolError) || error.status !== 400) throw error;
      this.own.clear();
      return send(url, request, auth, asking().body);
    });

    const calls = new Map<number, ToolCall>();
    const blocks: JsonObject[] = [];
    let content = "";
    let stop: string | undefined;
    let sent: ClaudeUsage | undefined;
    let outputTokens: number | undefined;
    let ended = false;
    for await (const chunk of sseData(body)) {
      let event: ClaudeEvent;
      try { event = JSON.parse(chunk); } catch { throw new ModelProtocolError("Model provider sent invalid stream data."); }
      if (event.type === "error") {
        // Overloaded before a word was written is a busy answer: the loop may ask once more.
        if (event.error?.type === "overloaded_error" && !content && !calls.size) throw new ModelBusyError(529, null);
        throw new ModelProtocolError("Model provider reported an error mid-stream.");
      }
      const index = event.index ?? -1;
      if (event.type === "message_start") sent = event.message?.usage;
      else if (event.type === "content_block_start" && event.content_block) {
        blocks[index] = { ...event.content_block };
        if (event.content_block.type === "tool_use") {
          calls.set(index, { id: event.content_block.id ?? "", type: "function", function: { name: event.content_block.name ?? "", arguments: "" } });
          if (event.content_block.name) request.onToolCall?.(event.content_block.name);
        }
      } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
        content += event.delta.text;
        request.onText?.(event.delta.text);
        if (blocks[index]) blocks[index].text = `${blocks[index].text ?? ""}${event.delta.text}`;
      } else if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
        const call = calls.get(index);
        if (call) call.function.arguments += event.delta.partial_json ?? "";
      } else if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta") {
        if (blocks[index]) blocks[index].thinking = `${blocks[index].thinking ?? ""}${event.delta.thinking ?? ""}`;
      } else if (event.type === "content_block_delta" && event.delta?.type === "signature_delta") {
        if (blocks[index]) blocks[index].signature = `${blocks[index].signature ?? ""}${event.delta.signature ?? ""}`;
      } else if (event.type === "message_delta") {
        stop = event.delta?.stop_reason ?? stop;
        // Counted up as the reply is written; the last one is the total, thinking included. The count the reply started
        // with is not it: a reply that never says where it ended has no usage.
        outputTokens = event.usage?.output_tokens;
      } else if (event.type === "message_stop") ended = true;
    }
    // Settled only on counts the provider gave whole: the input it started with and the output it ended on (the cache's may be absent).
    const input = sent?.input_tokens, cachedTokens = sent?.cache_read_input_tokens ?? 0, cacheWriteTokens = sent?.cache_creation_input_tokens ?? 0;
    const usage: Usage | undefined = counted(input) && counted(outputTokens) && counted(cachedTokens) && counted(cacheWriteTokens)
      ? { inputTokens: input + cachedTokens + cacheWriteTokens, outputTokens, cachedTokens, cacheWriteTokens } : undefined;
    if (stop === "max_tokens") throw new ModelCutOffError(usage);
    if (!ended || stop !== "end_turn" && stop !== "tool_use") throw new ModelProtocolError("Model stream ended without a finished reply.");
    // A paid request without usage it can be settled on must not look free; the caller keeps the reservation.
    if (!usage) throw new ModelProtocolError("Model provider did not report usage.");
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    if (toolCalls.some(call => !call.id || !call.function.name)) throw new ModelProtocolError("Model returned an incomplete tool call.");
    if (toolCalls.length) this.remember(toolCalls[0].id, blocks, calls, usage.outputTokens);
    return { content, toolCalls, usage };
  }

  /** Keeps a reply for its tool round, each call with the arguments Claude wrote. One it could not be given back whole is not kept. */
  private remember(id: string, blocks: JsonObject[], calls: Map<number, ToolCall>, outputTokens: number): void {
    try {
      for (const [index, call] of calls) blocks[index].input = JSON.parse(call.function.arguments || "{}");
    } catch { return; }
    // A block the stream never opened leaves a hole: such a reply cannot go back whole.
    if (Object.keys(blocks).length !== blocks.length) return;
    // Counted as the reservation counts everything else, a token a byte, and never as less than Claude counted writing it
    // (thinking can come back as less text than it was).
    this.own.set(id, { blocks, tokens: Math.max(new TextEncoder().encode(JSON.stringify(blocks)).length, outputTokens) });
    for (const oldest of this.own.keys()) { if (this.own.size <= OWN_REPLIES) break; this.own.delete(oldest); }
  }
}

const responseObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const responseString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const responseBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

/** Both cache counters are required by Responses; absent chargeable usage must keep the reservation. */
function responsesUsage(value: unknown): Usage | undefined {
  if (!responseObject(value) || !responseObject(value.input_tokens_details)) return;
  const input = value.input_tokens, output = value.output_tokens;
  const read = value.input_tokens_details.cached_tokens, written = value.input_tokens_details.cache_write_tokens;
  if (!counted(input) || !counted(output) || !counted(read) || !counted(written)
    || !counted(input + output) || !counted(read + written) || read + written > input) return;
  if (value.total_tokens !== undefined && (!counted(value.total_tokens) || value.total_tokens !== input + output)) return;
  if (value.output_tokens_details !== undefined) {
    if (!responseObject(value.output_tokens_details) || !counted(value.output_tokens_details.reasoning_tokens)
      || value.output_tokens_details.reasoning_tokens > output) return;
  }
  const lifetimes = value.input_tokens_details.cache_write_tokens_details;
  if (lifetimes !== undefined && (!responseObject(lifetimes) || !counted(lifetimes.ttl_30m_tokens)
    || !counted(lifetimes.ttl_12h_tokens) || !counted(lifetimes.ttl_30m_tokens + lifetimes.ttl_12h_tokens)
    || lifetimes.ttl_30m_tokens + lifetimes.ttl_12h_tokens !== written)) return;
  return { inputTokens: input, outputTokens: output, cachedTokens: read, cacheWriteTokens: written };
}

interface ResponsesOwnReply {
  prefix: string;
  content: string;
  calls: string;
  items: JsonObject[];
  tokens: number;
  bytes: number;
}
interface ResponsesStreamItem {
  item: JsonObject;
  arguments: string;
  argumentsDone: boolean;
  done: boolean;
  text: Map<number, string>;
}

/** Stateless Responses: opaque output stays private to this conversation's adapter, never in saved messages. */
class ResponsesAdapter implements ModelAdapter {
  private readonly own = new Map<string, ResponsesOwnReply>();
  private identity = "";
  private apiKey: string | undefined;

  private bind(config: ModelConfig): void {
    const identity = config.api === "responses" ? JSON.stringify([config.baseURL.replace(/\/$/, ""), config.model, config.secretEnv]) : "";
    if (identity !== this.identity) { this.own.clear(); this.apiKey = undefined; this.identity = identity; }
  }

  private kept(messages: ModelMessage[]): Map<number, ResponsesOwnReply> {
    const kept = new Map<number, ResponsesOwnReply>();
    const from = messages.findLastIndex(message => message.role === "user" || message.role === "system") + 1;
    for (let i = from; i < messages.length; i++) {
      const message = messages[i];
      if (message.role !== "assistant") continue;
      const saved = this.own.get(message.tool_calls?.[0]?.id ?? "");
      if (!saved || saved.content !== (message.content ?? "") || saved.calls !== JSON.stringify(message.tool_calls ?? [])
        || saved.prefix !== JSON.stringify(messages.slice(0, i))) { kept.clear(); continue; }
      kept.set(i, saved);
    }
    return kept;
  }

  retainedInputEstimate(messages: ModelMessage[], config: ModelConfig): number {
    this.bind(config);
    let tokens = 0;
    for (const saved of this.kept(messages).values()) tokens += saved.tokens;
    return tokens;
  }

  async turn(request: ModelTurnRequest): Promise<ModelTurnReply> {
    const { config, signal } = request;
    signal.throwIfAborted();
    this.bind(config);
    if (this.apiKey !== request.apiKey) { this.own.clear(); this.apiKey = request.apiKey; }
    const kept = this.kept(request.messages);
    const active = new Set(kept.values());
    for (const [id, saved] of this.own) if (!active.has(saved)) this.own.delete(id);
    const input: JsonObject[] = [];
    request.messages.forEach((message, index) => {
      const saved = kept.get(index);
      if (saved) { input.push(...saved.items); return; }
      if (message.role === "tool") input.push({ type: "function_call_output", call_id: message.tool_call_id, output: message.content });
      else if (message.role === "assistant") {
        if (message.content) input.push({ role: "assistant", content: message.content });
        for (const call of message.tool_calls ?? []) input.push({
          type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments || "{}",
        });
      } else input.push({ role: message.role, content: typeof message.content === "string" ? message.content
        : message.content.map(part => part.type === "text" ? { type: "input_text", text: part.text }
          : { type: "input_image", image_url: part.image_url.url, detail: "auto" }) });
    });
    const extra = { ...config.extraBody };
    // These fields belong to Chat or provider-side state, never a stateless Responses request.
    for (const key of ["messages", "reasoning_effort", "max_tokens", "max_completion_tokens", "stream_options", "previous_response_id", "conversation"]) delete extra[key];
    const body = await send(`${config.baseURL.replace(/\/$/, "")}/responses`, request, { authorization: `Bearer ${request.apiKey}` }, {
      ...extra, model: config.model, input, tools: request.tools.map(tool => ({ type: "function", ...tool, strict: false })),
      max_output_tokens: request.maxOutputTokens, stream: true, store: false, include: ["reasoning.encrypted_content"],
    });
    const items = new Map<number, ResponsesStreamItem>();
    const ids = new Set<string>();
    const openedCalls = new Set<string>();
    let terminal: JsonObject | undefined;
    let responseId: string | undefined;
    const invalid: () => never = () => { throw new ModelProtocolError("Model provider sent invalid Responses stream data."); };
    const at = (event: JsonObject): ResponsesStreamItem => {
      if (!counted(event.output_index)) return invalid();
      const part = items.get(event.output_index);
      if (!part || part.done || event.item_id !== part.item.id) return invalid();
      return part;
    };
    // The shared SSE reader discards an unfinished last frame; Responses must not accept a truncated tail after completion.
    let ending = "";
    let received = 0;
    const framed = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, controller) {
        received += bytes.byteLength;
        if (received > 8 * 1024 * 1024) throw new ModelProtocolError("Model provider Responses stream exceeded the size limit.");
        ending = (ending + String.fromCharCode(...bytes.subarray(Math.max(0, bytes.length - 4)))).slice(-4);
        controller.enqueue(bytes);
      },
      flush() { if (!/\r?\n\r?\n$/.test(ending)) invalid(); },
    }));
    for await (const chunk of sseData(framed)) {
      signal.throwIfAborted();
      let event: unknown;
      try { event = JSON.parse(chunk); } catch { invalid(); }
      if (!responseObject(event) || !responseString(event.type) || terminal) invalid();
      if (event.type === "error" || event.type === "response.failed") throw new ModelProtocolError("Model provider reported an error mid-stream.");
      if (event.response_id !== undefined) {
        if (!responseString(event.response_id) || responseId !== undefined && responseId !== event.response_id) invalid();
        responseId = event.response_id;
      }
      if (event.type === "response.created" || event.type === "response.in_progress") {
        if (!responseObject(event.response) || !responseString(event.response.id)
          || responseId !== undefined && responseId !== event.response.id) invalid();
        responseId = event.response.id;
      } else if (event.type === "response.output_item.added") {
        const item = event.item;
        if (!counted(event.output_index) || items.has(event.output_index) || !responseObject(item)
          || !responseString(item.id) || ids.has(item.id) || !["message", "function_call", "reasoning"].includes(String(item.type))) invalid();
        ids.add(item.id);
        items.set(event.output_index, { item, arguments: typeof item.arguments === "string" ? item.arguments : "", argumentsDone: false, done: false, text: new Map() });
        if (item.type === "function_call") {
          if (!responseString(item.call_id) || openedCalls.has(item.call_id) || !responseString(item.name) || typeof item.arguments !== "string") invalid();
          openedCalls.add(item.call_id);
          request.onToolCall?.(item.name);
        }
      } else if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
        const part = at(event);
        if (part.item.type !== "message" || !counted(event.content_index) || typeof event.delta !== "string") invalid();
        part.text.set(event.content_index, (part.text.get(event.content_index) ?? "") + event.delta);
        request.onText?.(event.delta);
      } else if (event.type === "response.function_call_arguments.delta") {
        const part = at(event);
        if (part.item.type !== "function_call" || part.argumentsDone || typeof event.delta !== "string") invalid();
        part.arguments += event.delta;
      } else if (event.type === "response.function_call_arguments.done") {
        const part = at(event);
        if (part.item.type !== "function_call" || part.argumentsDone || event.arguments !== part.arguments) invalid();
        part.argumentsDone = true;
      } else if (event.type === "response.output_item.done") {
        if (!counted(event.output_index) || !responseObject(event.item)) invalid();
        const part = items.get(event.output_index), item = event.item;
        if (!part || part.done || item.id !== part.item.id || item.type !== part.item.type) invalid();
        if (item.type === "function_call" && (!part.argumentsDone || item.call_id !== part.item.call_id
          || item.name !== part.item.name || item.arguments !== part.arguments)) invalid();
        part.item = item;
        part.done = true;
      } else if (event.type === "response.completed" || event.type === "response.incomplete") {
        if (!responseObject(event.response) || !responseString(event.response.id)
          || responseId !== undefined && responseId !== event.response.id) invalid();
        const final = event.response;
        const usage = responsesUsage(final.usage);
        if (event.type === "response.incomplete") {
          if (final.status === "incomplete" && responseObject(final.incomplete_details) && final.incomplete_details.reason === "max_output_tokens") throw new ModelCutOffError(usage);
          throw new ModelProtocolError("Model stream ended without a finished reply.");
        }
        if (final.status !== "completed" || final.error != null || final.incomplete_details != null) invalid();
        terminal = final;
      }
    }
    signal.throwIfAborted();
    if (!terminal) throw new ModelProtocolError("Model stream ended without a finished reply.");
    const usage = responsesUsage(terminal.usage);
    if (!usage) throw new ModelProtocolError("Model provider did not report usage.");
    if (!Array.isArray(terminal.output) || terminal.output.length !== items.size) invalid();
    const output: JsonObject[] = [];
    const toolCalls: ToolCall[] = [];
    const callIds = new Set<string>();
    let content = "";
    for (let i = 0; i < terminal.output.length; i++) {
      const item: unknown = terminal.output[i], part = items.get(i);
      if (!responseObject(item) || !part?.done || item.id !== part.item.id || item.type !== part.item.type
        || item.status !== undefined && item.status !== "completed") invalid();
      output.push(item);
      if (item.type === "function_call") {
        if (!responseString(item.call_id) || callIds.has(item.call_id) || !responseString(item.name)
          || item.call_id !== part.item.call_id || item.name !== part.item.name || item.arguments !== part.arguments) invalid();
        try { const args: unknown = JSON.parse(part.arguments); if (!responseObject(args)) invalid(); } catch { invalid(); }
        callIds.add(item.call_id);
        toolCalls.push({ id: item.call_id, type: "function", function: { name: item.name, arguments: part.arguments } });
      } else if (item.type === "message") {
        if (item.role !== "assistant" || !Array.isArray(item.content) || !Array.isArray(part.item.content)
          || JSON.stringify(item.content) !== JSON.stringify(part.item.content)) invalid();
        const parts = item.content;
        for (let index = 0; index < parts.length; index++) {
          const text: unknown = parts[index];
          if (!responseObject(text) || text.type !== "output_text" && text.type !== "refusal") invalid();
          const said = text.type === "output_text" ? text.text : text.refusal;
          if (typeof said !== "string" || said !== (part.text.get(index) ?? "")) invalid();
          content += said;
        }
        if ([...part.text.keys()].some(index => index >= parts.length)) invalid();
      } else if (item.type === "reasoning") {
        if (!responseString(item.encrypted_content) || item.encrypted_content !== part.item.encrypted_content) invalid();
      } else invalid();
    }
    if (toolCalls.length) {
      const bytes = responseBytes(output), prefix = JSON.stringify(request.messages);
      const saved: ResponsesOwnReply = { prefix, content, calls: JSON.stringify(toolCalls), items: output,
        tokens: Math.max(bytes, usage.outputTokens), bytes: bytes + responseBytes(prefix) };
      this.own.set(toolCalls[0].id, saved);
      let total = [...this.own.values()].reduce((sum, reply) => sum + reply.bytes, 0);
      // A cold turn remains valid: only opaque continuation is lost if the open round exceeds these bounds.
      for (const [id, reply] of this.own) {
        if (this.own.size <= OWN_REPLIES && total <= 4 * 1024 * 1024) break;
        this.own.delete(id); total -= reply.bytes;
      }
    } else this.own.clear();
    return { content, toolCalls, usage };
  }
}

/** Speaks to each model the way its config says (ModelConfig.api). */
export class ProviderAdapter implements ModelAdapter {
  private readonly chat = new CompatibleChatAdapter();
  private readonly claude = new ClaudeAdapter();
  private readonly responses = new ResponsesAdapter();

  turn(request: ModelTurnRequest): Promise<ModelTurnReply> {
    this.responses.retainedInputEstimate(request.messages, request.config);
    return (request.config.api === "claude" ? this.claude : request.config.api === "responses" ? this.responses : this.chat).turn(request);
  }

  /** Both reasoning APIs may send back opaque items beyond the saved messages. */
  retainedInputEstimate(messages: ModelMessage[], config: ModelConfig): number {
    const retained = this.responses.retainedInputEstimate(messages, config);
    return config.api === "claude" ? this.claude.retainedInputEstimate(messages) : retained;
  }
}

/** Yields the `data:` payloads of a Server-Sent Events stream. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    let end: number;
    while ((end = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
      const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      if (data) yield data;
    }
  }
}
