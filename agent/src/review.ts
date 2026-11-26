import type { AgentTemplate, Bindings, ChatMessage, ClientConfig, ModelTool } from "./contracts";
import { LESSON_KINDS, type Learning, type LessonKind } from "./learning";
import { inputReservePrice, usageCost, type ModelAdapter } from "./model";
import { REVIEW_PROMPT } from "./prompts";
import { utcDay } from "./usage";

// The background reviewer: one bounded model run over a finished stretch of a conversation.
// It can only search and propose lessons; it cannot run business tools, see secrets or change anything a person did not
// approve. Code checks every proposal: the evidence must be the person's own words from this stretch.

export interface ReviewInput {
  client: ClientConfig;
  agent: AgentTemplate;
  conversationId: string;
  /** What the person and the agent said since the last review, oldest first. */
  lines: { seq: number; role: "user" | "assistant"; text: string }[];
  /** People declined some of the agent's proposals, with these reasons. */
  declines?: { title: string; reason: string }[];
  bindings: Bindings & { LEARNING: DurableObjectNamespace<Learning> };
  model: ModelAdapter;
  modelKey(name: string): string;
  now?(): number;
}

/** `complete` is false when the review could not run to the end (no allowance or budget left): try the same stretch later. */
export interface ReviewResult { proposed: string[]; refused: string[]; calls: number; complete: boolean }

/** Model calls per review, output tokens per call, transcript characters and time per call. */
const MAX_CALLS = 4;
const MAX_OUTPUT_TOKENS = 800;
export const MAX_TRANSCRIPT_CHARS = 20_000;
const CALL_TIMEOUT_MS = 30_000;
const DEFAULT_DAILY_CAP_USD = 5;

const TOOLS: ModelTool[] = [
  { name: "lesson_search", description: "Find this client's existing lessons (proposed or active) that share words with the query.",
    parameters: { type: "object", properties: { query: { type: "string", minLength: 2, maxLength: 200 } }, required: ["query"], additionalProperties: false } },
  { name: "lesson_propose", description: "Propose one lesson for a person to approve.",
    parameters: { type: "object", properties: {
      text: { type: "string", minLength: 10, maxLength: 300 },
      kind: { type: "string", enum: [...LESSON_KINDS] },
      scope: { type: "string", enum: ["this_agent", "all_agents"] },
      evidence: { type: "string", minLength: 3, maxLength: 300 },
      replaces: { type: "string", maxLength: 128 },
    }, required: ["text", "kind", "scope", "evidence"], additionalProperties: false } },
  { name: "review_done", description: "End the review (also when there is nothing to learn).",
    parameters: { type: "object", properties: {}, additionalProperties: false } },
];

const squash = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** The person's words (PERSON lines and decline reasons) contain the evidence, ignoring spacing and case. */
export function quotesPerson(evidence: string, input: Pick<ReviewInput, "lines" | "declines">): boolean {
  const quote = squash(evidence);
  if (quote.length < 3) return false;
  const sources = [...input.lines.filter(l => l.role === "user").map(l => l.text), ...(input.declines ?? []).map(d => d.reason)];
  return sources.some(text => squash(text).includes(quote));
}

function transcript(input: ReviewInput): string {
  const lines: string[] = [];
  let chars = 0;
  // Newest first until the budget is used, then back in order.
  for (const line of [...input.lines].reverse()) {
    const text = `${line.role === "user" ? "PERSON" : "AGENT"}: ${line.text}`;
    if (chars + text.length > MAX_TRANSCRIPT_CHARS) break;
    lines.unshift(text);
    chars += text.length;
  }
  const declines = (input.declines ?? []).map(d => `\n\nThe person declined the agent's proposal "${d.title}" with this reason: ${d.reason}`).join("");
  return `Agent: ${input.agent.name} (${input.agent.id}). Client: ${input.client.name}.\n\nTranscript:\n${lines.join("\n")}${declines}`;
}

/** One model call, reserved against the client's daily model cap first (same ledger as conversations and jobs). */
async function call(input: ReviewInput, messages: ChatMessage[]) {
  const config = input.client.model;
  const inputEstimate = new TextEncoder().encode(JSON.stringify({ messages, TOOLS })).length + 256 + (input.model.retainedInputEstimate?.(messages, config) ?? 0);
  const estimate = (inputEstimate * inputReservePrice(config) + MAX_OUTPUT_TOKENS * config.outputCostPerMillion) / 1_000_000;
  const usage = input.bindings.USAGE.get(input.bindings.USAGE.idFromName(input.client.id));
  const id = crypto.randomUUID();
  const now = input.now ?? Date.now;
  if (!await usage.reserve(id, utcDay(now()), estimate, input.client.dailyCostCapUsd ?? DEFAULT_DAILY_CAP_USD)) return undefined;
  const reply = await input.model.turn({
    config, apiKey: input.modelKey(config.secretEnv), messages, tools: TOOLS, maxOutputTokens: Math.min(MAX_OUTPUT_TOKENS, config.maxOutputTokens),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const cost = usageCost(config, reply.usage);
  await usage.settle(id, cost).catch(() => {});
  return reply;
}

/** Runs one review. Errors are the caller's to log; nothing here can fail a conversation. */
export async function reviewConversation(input: ReviewInput): Promise<ReviewResult> {
  const result: ReviewResult = { proposed: [], refused: [], calls: 0, complete: true };
  if (!input.lines.some(l => l.role === "user") && !input.declines?.length) return result;
  const learning = input.bindings.LEARNING.get(input.bindings.LEARNING.idFromName(input.client.id));
  const now = input.now ?? Date.now;
  if (!await learning.admitReview(utcDay(now()))) return { ...result, complete: false };

  const messages: ChatMessage[] = [{ role: "system", content: REVIEW_PROMPT }, { role: "user", content: transcript(input) }];
  const lastSeq = input.lines.at(-1)?.seq ?? 0;
  while (result.calls < MAX_CALLS) {
    const reply = await call(input, messages);
    if (!reply) return { ...result, complete: false };
    result.calls++;
    if (!reply.toolCalls.length) break;
    messages.push({ role: "assistant", content: reply.content || null, tool_calls: reply.toolCalls });
    let done = false;
    for (const toolCall of reply.toolCalls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(toolCall.function.arguments || "{}"); } catch { /* answered below */ }
      let content: unknown;
      if (toolCall.function.name === "review_done") {
        done = true;
        content = { ok: true };
      } else if (toolCall.function.name === "lesson_search") {
        const found = await learning.search(String(args.query ?? ""));
        content = { lessons: found.map(l => ({ id: l.id, text: l.text, kind: l.kind, status: l.status, agent: l.agent ?? "all agents" })) };
      } else if (toolCall.function.name === "lesson_propose") {
        const text = String(args.text ?? ""), evidence = String(args.evidence ?? "");
        if (!quotesPerson(evidence, input)) {
          result.refused.push(text);
          content = { ok: false, error: "evidence must be the person's exact words from a PERSON line or the decline reason" };
        } else {
          // Same transcript stretch + same text → same id, so a repeated review cannot file it twice.
          const id = `lesson-${input.conversationId}-${lastSeq}-${result.proposed.length + result.refused.length}`.slice(0, 120);
          const filed = await learning.propose(id, {
            agent: args.scope === "all_agents" ? null : input.agent.id, kind: String(args.kind) as LessonKind, text, evidence,
            conversationId: input.conversationId, ...(typeof args.replaces === "string" && args.replaces ? { replaces: args.replaces } : {}),
          });
          if (filed.ok) {
            result.proposed.push(filed.lesson.id);
            await input.bindings.DASHBOARD.get(input.bindings.DASHBOARD.idFromName(input.client.id)).post({
              id: `lesson-card-${filed.lesson.id}`.slice(0, 128), agent: filed.lesson.agent ?? input.agent.id, kind: "status",
              title: `New lesson to review: ${filed.lesson.text}`.slice(0, 120),
              summary: `${input.agent.name} learned this from a conversation. It is used only after a person approves it on the dashboard.`,
              dataJson: "{}", conversationId: input.conversationId, clientId: input.client.id,
            }).catch(() => {});
            content = { ok: true, id: filed.lesson.id };
          } else {
            result.refused.push(text);
            content = { ok: false, error: filed.reason };
          }
        }
      } else {
        content = { ok: false, error: "Unknown tool." };
      }
      messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(content) });
    }
    if (done) break;
  }
  return result;
}
