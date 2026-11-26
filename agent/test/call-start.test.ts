import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENTS } from "../agents";
import { CLIENTS } from "../clients";
import type { ClientConfig, TurnEvent } from "../src/contracts";
import type { Conversation, Env } from "../src/conversation";
import { ModelCutOffError } from "../src/errors";
import { PRACTICE_NOTE } from "../src/loop";
import { memoryName } from "../src/memory";
import type { ModelAdapter, ModelTurnRequest } from "../src/model";
import { phoneStart } from "../src/phone";
import { Store } from "../src/store";
import { utcDay } from "../src/usage";
import { isPractice } from "./practice";

// What phone-start leaves running once it has answered (src/phone.ts): the call's notes are read and the model gets one
// practice request, so the caller's first words wait for neither.

const brain = env as unknown as Env;
const BEACON = CLIENTS.find(c => c.id === "beacon") as ClientConfig;
const ACME = CLIENTS.find(c => c.id === "acme") as ClientConfig;
const usage = { inputTokens: 1000, outputTokens: 2 };
/** What one such request costs on a call (the client's call prices). */
const cost = (client: ClientConfig) => (usage.inputTokens * (client.model.voice?.inputCostPerMillion ?? client.model.inputCostPerMillion)
  + usage.outputTokens * (client.model.voice?.outputCostPerMillion ?? client.model.outputCostPerMillion)) / 1_000_000;

afterEach(() => { vi.restoreAllMocks(); });

const inside = <T>(name: string, fn: (instance: Conversation, store: Store, state: DurableObjectState) => Promise<T> | T) =>
  runInDurableObject(env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(name)), (instance, state) => fn(instance, new Store(state.storage), state));
const gate = () => { let open!: () => void; const wait = new Promise<void>(resolve => { open = resolve; }); return { wait, open }; };

/** A model that records what it is asked: a practice request gets its one word (after `hold`, or fails), the caller gets "Sure." */
async function record(name: string, options: { hold?: Promise<void>; fail?: boolean } = {}): Promise<ModelTurnRequest[]> {
  const asked: ModelTurnRequest[] = [];
  await inside(name, instance => {
    instance.model = {
      async turn(request) {
        asked.push(request);
        if (isPractice(request)) {
          await options.hold;
          if (options.fail) throw new Error("provider down");
          return { content: "ready", toolCalls: [], usage };
        }
        request.onText?.("Sure. ");
        return { content: "Sure. ", toolCalls: [], usage };
      },
    } satisfies ModelAdapter;
  });
  return asked;
}

/** A call picked up the way ElevenLabs reports it. `settled()` waits for everything phone-start left running. */
async function pickUp(client: ClientConfig, agent: string, sid: string, callerId?: string) {
  const running: Promise<unknown>[] = [];
  const response = await phoneStart(new Request(`https://brain/v1/voice/phone-start?agent=${agent}`, {
    method: "POST", body: JSON.stringify({ call_sid: sid, ...(callerId ? { caller_id: callerId } : {}) }),
  }), brain, client, { waitUntil: promise => { running.push(promise); } });
  expect(response.status).toBe(200);
  return { settled: () => Promise.all(running) };
}

/** The caller's words, handed over as completions() does; returns what they hear. */
const say = (name: string, id: string, text: string) => inside(name, async (instance, _store, state) => {
  const [clientId, agentId, conversationId] = name.split("/");
  const caller = await instance.callCaller();
  const stream = await instance.turn({ clientId, agentId, conversationId, voice: true, input: { id, text }, ...(caller ? { userId: "team", caller } : {}) });
  let raw = "";
  const decoder = new TextDecoder();
  for await (const bytes of stream) raw += decoder.decode(bytes, { stream: true });
  await state.storage.deleteAlarm();
  return raw.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as TurnEvent).flatMap(event => event.type === "text" ? [event.delta] : []).join("");
});

const saved = (name: string) => inside(name, (_instance, store) => store.messages());
const spent = (name: string) => inside(name, (_instance, store) => store.spentUsd());

describe("a phone call's start", () => {
  it("asks the model once before the caller speaks, with the first reply's own instructions and tools, and keeps none of it", async () => {
    const name = "beacon/helper/phone-CAstarthelper01";
    const asked = await record(name);
    await (await pickUp(BEACON, "helper", "CAstarthelper01", "+15550001111")).settled();
    expect(asked).toHaveLength(1);
    expect(asked[0].messages.map(message => message.role)).toEqual(["system", "user"]);
    expect(asked[0].messages[1].content).toBe(PRACTICE_NOTE);
    expect(await saved(name)).toEqual([]);
    // Nor is the conversation anyone's yet: its first real message decides that.
    expect(await inside(name, (_instance, store) => [store.meta("owner"), store.meta("user")])).toEqual([undefined, undefined]);

    expect(await say(name, "u1-hello", "[Phone call from Jess, Fri, Nov 13, 2026, 9:00 AM CST]\nHi Helper")).toBe("Sure. ");
    expect(asked).toHaveLength(2);
    expect(asked[1].messages[0]).toEqual(asked[0].messages[0]);
    expect(asked[1].tools).toEqual(asked[0].tools);
    expect(asked[1].config).toEqual(asked[0].config);
    // Its answer is one word: it may not write a reply's worth.
    expect(asked[0].maxOutputTokens).toBeLessThan(asked[1].maxOutputTokens);
    expect((await saved(name)).map(row => row.message.role)).toEqual(["user", "assistant"]);
  });

  it("sends one practice request for a call, however often its start is reported", async () => {
    const name = "beacon/helper/phone-CAstarttwice0001";
    const asked = await record(name);
    await (await pickUp(BEACON, "helper", "CAstarttwice0001", "+15550001111")).settled();
    await (await pickUp(BEACON, "helper", "CAstarttwice0001", "+15550001111")).settled();
    expect(asked.filter(isPractice)).toHaveLength(1);
  });

  it("has the call's notes ready for the first reply, and reads them again for the one after", async () => {
    const name = "beacon/helper/phone-CAstartnotes0001";
    const asked = await record(name);
    await (await pickUp(BEACON, "helper", "CAstartnotes0001", "+15550001111")).settled();
    // Learned elsewhere after the call was picked up: the first reply goes out on the notes read at pickup.
    await env.MEMORY.get(env.MEMORY.idFromName(memoryName("beacon", "team"))).add("f-level", "Jess parks on level two.");
    await say(name, "u1-hello", "Hi Helper");
    await say(name, "u2-order", "What should I order for the team?");
    const replies = asked.filter(request => !isPractice(request)).map(request => String(request.messages[0].content));
    expect(replies[0]).not.toContain("level two");
    expect(replies[1]).toContain("level two");
  });

  it("counts the practice request against the client's day and the call", async () => {
    const name = "beacon/helper/phone-CAstartcost00001";
    const day = () => env.USAGE.get(env.USAGE.idFromName("beacon")).spent(utcDay(Date.now()));
    // The day's ledger is the client's, shared by every call: only what this call adds is its own.
    const before = await day();
    await record(name);
    await (await pickUp(BEACON, "helper", "CAstartcost00001", "+15550001111")).settled();
    expect(await day() - before).toBeCloseTo(cost(BEACON), 9);
    expect(await spent(name)).toBeCloseTo(cost(BEACON), 9);
  });

  it("sends none for a client already at its daily cap", async () => {
    const name = "beacon/helper/phone-CAstartcap000001";
    const ledger = env.USAGE.get(env.USAGE.idFromName("beacon"));
    const day = utcDay(Date.now());
    const cap = BEACON.dailyCostCapUsd ?? 5;
    // Whatever is left of the day is taken (less a sliver, so rounding cannot refuse it), and given back afterwards: the ledger outlives this test.
    const fill = `rest-of-the-day-${crypto.randomUUID()}`;
    expect(await ledger.reserve(fill, day, cap - await ledger.spent(day) - 1e-9, cap)).toBe(true);
    try {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const asked = await record(name);
      await (await pickUp(BEACON, "helper", "CAstartcap000001", "+15550001111")).settled();
      expect(asked).toEqual([]);
      expect(await spent(name)).toBe(0);
      expect(errors).toHaveBeenCalledWith("call practice failed", expect.any(String));
    } finally {
      await ledger.settle(fill, 0);
    }
  });

  it("sends none once the caller has spoken", async () => {
    const name = "beacon/helper/phone-CAstartspoken001";
    const helper = AGENTS.helper;
    const original = helper.briefing;
    // The week's calendar is still being read when the caller's first words arrive.
    const reading = gate();
    helper.briefing = async () => { await reading.wait; return undefined; };
    try {
      const asked = await record(name);
      const call = await pickUp(BEACON, "helper", "CAstartspoken001", "+15550001111");
      expect(await say(name, "u1-hello", "Hi Helper")).toBe("Sure. ");
      reading.open();
      await call.settled();
      expect(asked.filter(isPractice)).toEqual([]);
    } finally {
      helper.briefing = original;
    }
  });

  it("changes nothing when its answer arrives after the first reply", async () => {
    const name = "beacon/helper/phone-CAstartlate00001";
    const answer = gate();
    const asked = await record(name, { hold: answer.wait });
    const call = await pickUp(BEACON, "helper", "CAstartlate00001", "+15550001111");
    await vi.waitFor(() => { expect(asked.some(isPractice)).toBe(true); });
    expect(await say(name, "u1-hello", "Hi Helper")).toBe("Sure. ");
    const before = await saved(name);
    answer.open();
    await call.settled();
    expect(await saved(name)).toEqual(before);
    expect(before.map(row => row.message.role)).toEqual(["user", "assistant"]);
    // Both requests were sent, so both are paid for.
    expect(await spent(name)).toBeCloseTo(2 * cost(BEACON), 9);
  });

  it("does nothing for a number that is turned away", async () => {
    const name = "beacon/helper/phone-CAstartstranger1";
    const asked = await record(name);
    await (await pickUp(BEACON, "helper", "CAstartstranger1", "+15559990000")).settled();
    expect(asked).toEqual([]);
  });

  it("leaves the call working when the practice request fails", async () => {
    const name = "beacon/helper/phone-CAstartfails0001";
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const asked = await record(name, { fail: true });
    await (await pickUp(BEACON, "helper", "CAstartfails0001", "+15550001111")).settled();
    expect(errors).toHaveBeenCalledWith("call practice failed", expect.any(String));
    expect(await say(name, "u1-hello", "Hi Helper")).toBe("Sure. ");
    expect(asked.filter(request => !isPractice(request))).toHaveLength(1);
  });

  it("a practice request cut off before its word is no failure and counts what it used", async () => {
    const name = "acme/helper/phone-CAstartcutoff001";
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const asked: ModelTurnRequest[] = [];
    await inside(name, instance => {
      instance.model = { async turn(request) { asked.push(request); throw new ModelCutOffError({ inputTokens: 15_000, outputTokens: 64 }); } };
    });
    await (await pickUp(ACME, "helper", "CAstartcutoff001")).settled();
    expect(errors).not.toHaveBeenCalledWith("call practice failed", expect.any(String));
    expect(asked[0].config).toMatchObject({ model: "test-model", secretEnv: "OPENAI_API_KEY", inputCostPerMillion: 0.2, outputCostPerMillion: 1 });
    // The practice call is billed at OpenAI's call prices, not Helper's off-call Claude prices.
    expect(await spent(name)).toBeCloseTo(0.003064, 9);
  });

  it("prepares a line that takes any caller too, for nobody in particular", async () => {
    const name = "acme/helper/phone-CAstarthelper02";
    const asked = await record(name);
    await (await pickUp(ACME, "helper", "CAstarthelper02")).settled();
    expect(asked.map(isPractice)).toEqual([true]);
    expect(asked[0].config).toMatchObject({ model: "test-model", secretEnv: "OPENAI_API_KEY", extraBody: { service_tier: "priority" } });
    // The caller is anonymous: the conversation takes its first words with no person attached.
    expect(await say(name, "u1-hello", "Hi Helper, are you there with me today?")).toBe("Sure. ");
    expect(asked[1].messages[0]).toEqual(asked[0].messages[0]);
    expect(asked[1].tools).toEqual(asked[0].tools);
  });
});

// One test call may be tied to another model when it starts (src/phone.ts `test_model`), so models can be compared on the
// same line. What must hold: the whole call runs on that model at its own prices; only a name the client lists is taken,
// only under a test call's id and only as the call's first start; and no call that started any other way ever changes model.
describe("a test call tied to another model", () => {
  const ACME_TOKEN = "test-token-acme-0123456789abcdef";

  /** A call start as the Call Lab sends it: the usual body plus the model it asks for. */
  async function startWith(client: ClientConfig, agent: string, sid: string, testModel: unknown, callerId?: string) {
    const running: Promise<unknown>[] = [];
    const response = await phoneStart(new Request(`https://brain/v1/voice/phone-start?agent=${agent}`, {
      method: "POST", body: JSON.stringify({ call_sid: sid, test_model: testModel, ...(callerId ? { caller_id: callerId } : {}) }),
    }), brain, client, { waitUntil: promise => { running.push(promise); } });
    return { response, settled: () => Promise.all(running) };
  }
  const models = (asked: ModelTurnRequest[]) => asked.map(request => request.config.model);

  it("runs the practice request and every reply on that model, at its own prices, and names it", async () => {
    const name = "acme/helper/phone-lab-helper-model01";
    const asked = await record(name);
    const call = await startWith(ACME, "helper", "lab-helper-model01", "gpt-4.1");
    expect(call.response.status).toBe(200);
    expect(await call.response.json()).toMatchObject({ custom_llm_extra_body: { conversation_id: "phone-lab-helper-model01" }, test_model: "gpt-4.1" });
    await call.settled();
    expect(await say(name, "u1-hello", "Hi Helper, are you there with me today?")).toBe("Sure. ");
    expect(await say(name, "u2-sites", "Which sites do you look after for us?")).toBe("Sure. ");
    expect(asked.map(isPractice)).toEqual([true, false, false]);
    for (const request of asked) {
      expect(request.config).toMatchObject({ model: "gpt-4.1", secretEnv: "OPENAI_API_KEY", inputCostPerMillion: 2, outputCostPerMillion: 8 });
      // A whole model of its own: the client's Fast mode and reasoning fields are not sent to a model that was not given them.
      expect(request.config.extraBody).toBeUndefined();
    }
    expect(await spent(name)).toBeCloseTo(3 * (usage.inputTokens * 2 + usage.outputTokens * 8) / 1_000_000, 9);
    expect(await inside(name, instance => instance.state("acme", "helper"))).toMatchObject({ testModel: "gpt-4.1" });
  });

  it("takes the model from the call's start alone: words that arrive naming a model change nothing", async () => {
    const name = "acme/helper/phone-lab-helper-model02";
    const asked = await record(name);
    const reply = await SELF.fetch("https://brain/v1/chat/completions", {
      method: "POST", headers: { authorization: `Bearer ${ACME_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "helper", stream: true, messages: [{ role: "user", content: "Hi Helper, are you there with me today?" }],
        elevenlabs_extra_body: { conversation_id: "phone-lab-helper-model02", test_model: "gpt-4.1" }, test_model: "gpt-4.1",
      }),
    });
    expect(reply.status).toBe(200);
    await reply.text();
    await inside(name, (_instance, _store, state) => state.storage.deleteAlarm());
    expect(models(asked)).toEqual(["test-model"]);
  });

  it("refuses a name the client does not list or a call id that is not a test call's, and starts nothing", async () => {
    const cases: [client: ClientConfig, agent: string, sid: string, testModel: unknown, callerId?: string][] = [
      [ACME, "helper", "lab-helper-model03", "gpt-9"],
      [ACME, "helper", "lab-helper-model04", 41],
      // Acme Test Co lists gpt-4.1; Beacon does not, and Helper's approved caller changes nothing about that.
      [BEACON, "helper", "lab-helper-model05", "gpt-4.1", "+15550001111"],
      // No agent named: there is no call to save the model with.
      [ACME, "", "lab-helper-model06", "gpt-4.1"],
      // A Twilio call id does not have a test call's form: the start is refused, whenever it arrives.
      [ACME, "helper", "CA0123456789abcdef0123456789abcdef", "gpt-4.1"],
    ];
    for (const [client, agent, sid, testModel, callerId] of cases) {
      const name = `${client.id}/${agent || "helper"}/phone-${sid}`;
      const asked = await record(name);
      const call = await startWith(client, agent, sid, testModel, callerId);
      expect(call.response.status).toBe(400);
      await call.settled();
      expect(asked).toEqual([]);
      expect(await inside(name, async (instance, store) => [store.meta("testModel"), store.meta("callStarted"), await instance.callCaller()])).toEqual([undefined, undefined, undefined]);
    }
  });

  it("fixes the model at the call's first start: the same start again is fine, any other choice changes nothing", async () => {
    const name = "acme/helper/phone-lab-helper-model07";
    const asked = await record(name);
    await (await startWith(ACME, "helper", "lab-helper-model07", "gpt-4.1")).settled();
    // A retry of the same start: accepted, and no second practice request.
    const again = await startWith(ACME, "helper", "lab-helper-model07", "gpt-4.1");
    expect(again.response.status).toBe(200);
    expect(await again.response.json()).toMatchObject({ test_model: "gpt-4.1" });
    await again.settled();
    // Another listed model is refused; an ordinary start for the same call is answered as always and changes nothing.
    const other = await startWith(ACME, "helper", "lab-helper-model07", "gpt-4.1-mini");
    expect(other.response.status).toBe(409);
    await other.settled();
    await (await pickUp(ACME, "helper", "lab-helper-model07")).settled();
    expect(await say(name, "u1-hello", "Hi Helper, are you there with me today?")).toBe("Sure. ");
    expect(asked.map(isPractice)).toEqual([true, false]);
    expect(models(asked)).toEqual(["gpt-4.1", "gpt-4.1"]);
  });

  it("never moves a call that started as an ordinary call onto a test model", async () => {
    // Picked up the ordinary way; the test start arrives before the practice request has even gone.
    const picked = "acme/helper/phone-lab-helper-model08";
    const first = await record(picked);
    const call = await pickUp(ACME, "helper", "lab-helper-model08");
    const late = await startWith(ACME, "helper", "lab-helper-model08", "gpt-4.1");
    expect(late.response.status).toBe(409);
    await Promise.all([call.settled(), late.settled()]);
    await say(picked, "u1-hello", "Hi Helper, are you there with me today?");
    expect(first.map(isPractice)).toEqual([true, false]);
    expect(models(first)).toEqual(["test-model", "test-model"]);

    // Words that arrived with no start at all, the way the Talk button calls.
    const spoken = "acme/helper/phone-lab-helper-model09";
    const second = await record(spoken);
    await say(spoken, "u1-hello", "Hi Helper, are you there with me today?");
    const after = await startWith(ACME, "helper", "lab-helper-model09", "gpt-4.1");
    expect(after.response.status).toBe(409);
    await after.settled();
    await say(spoken, "u2-sites", "Which sites do you look after for us?");
    expect(second.map(isPractice)).toEqual([false, false]);
    expect(models(second)).toEqual(["test-model", "test-model"]);
    expect(await inside(spoken, (_instance, store) => store.meta("testModel"))).toBeUndefined();
  });

  it("gives starts that race for one call a single model, the first to arrive, and refuses the other test start", async () => {
    // Two test models at once.
    const pair = "acme/helper/phone-lab-helper-model10";
    const first = await record(pair);
    const [a, b] = await Promise.all([startWith(ACME, "helper", "lab-helper-model10", "gpt-4.1"), startWith(ACME, "helper", "lab-helper-model10", "gpt-4.1-mini")]);
    await Promise.all([a.settled(), b.settled()]);
    expect([a.response.status, b.response.status].sort()).toEqual([200, 409]);
    const winner = a.response.status === 200 ? "gpt-4.1" : "gpt-4.1-mini";
    await say(pair, "u1-hello", "Hi Helper, are you there with me today?");
    expect(first.map(isPractice)).toEqual([true, false]);
    expect(models(first)).toEqual([winner, winner]);

    // An ordinary start and a test start at once: whichever arrived first, the whole call runs on one model.
    const mixed = "acme/helper/phone-lab-helper-model11";
    const second = await record(mixed);
    const [ordinary, test] = await Promise.all([pickUp(ACME, "helper", "lab-helper-model11"), startWith(ACME, "helper", "lab-helper-model11", "gpt-4.1")]);
    await Promise.all([ordinary.settled(), test.settled()]);
    expect([200, 409]).toContain(test.response.status);
    const model = test.response.status === 200 ? "gpt-4.1" : "test-model";
    await say(mixed, "u1-hello", "Hi Helper, are you there with me today?");
    expect(second.map(isPractice)).toEqual([true, false]);
    expect(models(second)).toEqual([model, model]);
  });
});
