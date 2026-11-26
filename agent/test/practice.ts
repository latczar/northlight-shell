import { env, runInDurableObject } from "cloudflare:test";
import { PRACTICE_NOTE } from "../src/loop";
import type { ModelAdapter, ModelTurnRequest } from "../src/model";

// A phone call's practice request (src/loop.ts rehearseTurn) goes out in the background as soon as phone-start has answered.
// A test that starts a call must answer it itself: left alone it would go to the real provider, or land on a scripted model
// as a step the test never meant.

export const isPractice = (request: ModelTurnRequest): boolean => request.messages.at(-1)?.content === PRACTICE_NOTE;

/** `model`, with every practice request answered before it gets there (at no cost, so spend totals stay the test's own). */
export const withPractice = (model: ModelAdapter): ModelAdapter => ({
  turn: async request => isPractice(request) ? { content: "ready", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } } : model.turn(request),
});

/** Answers the practice request of the call whose conversation `name` routes to (`<client>/<agent>/phone-<sid>`). Anything else it is asked fails: the test scripts that itself. */
export async function answerPractice(name: string): Promise<void> {
  await runInDurableObject(env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(name)), instance => {
    instance.model = withPractice({ async turn() { throw new Error(`No model was scripted for ${name}.`); } });
  });
}
