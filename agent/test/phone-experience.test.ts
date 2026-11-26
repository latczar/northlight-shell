import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENTS } from "../agents";
import { CLIENTS } from "../clients";
import { recentBriefings } from "../src/briefing";
import type { ChatMessage, ToolCall, ToolContext, TurnEvent } from "../src/contracts";
import type { Conversation, Env } from "../src/conversation";
import { loadJob, loadQueue } from "../src/jobs";
import { modelFor, type ModelAdapter, type ModelTurnRequest } from "../src/model";
import { phoneStart } from "../src/phone";
import { Store } from "../src/store";
import { ACKNOWLEDGEMENTS, APPROVAL_FILED_SPOKEN, confirmedChange, isCheckIn, isClosingOffer, isYes, MOMENTS, PENDING_TTL_MS, readBackSentence, SPOKEN_AT_ONCE, STARTED_SPOKEN, STILL_CHECKING, STILL_WORKING, wantsLookup } from "../src/voice";
import { TOOLS } from "../tools";
import { answerPractice, withPractice } from "./practice";

const auth = { authorization: "Bearer test-token-acme-0123456789abcdef", "content-type": "application/json" };
const usage = { inputTokens: 5, outputTokens: 2 };
const call = (id: string, name: string, args: object): ToolCall => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const time = () => call("t1", "current_time", { timezone: "America/Chicago" });

interface Step { text?: string; calls?: ToolCall[]; hold?: Promise<void> }

const inside = <T>(cid: string, fn: (instance: Conversation, store: Store) => Promise<T> | T, agent = "helper") =>
  runInDurableObject(env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`acme/${agent}/${cid}`)), (instance, state) => fn(instance, new Store(state.storage)));
const quiet = (cid: string, agent = "helper") => runInDurableObject(env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`acme/${agent}/${cid}`)), (_i, state) => state.storage.deleteAlarm());

/** A model that plays `steps` in order (the last repeats) and records every request. */
async function script(cid: string, steps: Step[], agent = "helper") {
  const requests: ModelTurnRequest[] = [];
  await inside(cid, instance => {
    let i = 0;
    instance.model = withPractice({
      async turn(request) {
        requests.push(request);
        const step = steps[Math.min(i++, steps.length - 1)];
        await step.hold;
        if (step.text) request.onText?.(step.text);
        return { content: step.text ?? "", toolCalls: step.calls ?? [], usage };
      },
    } satisfies ModelAdapter);
  }, agent);
  return requests;
}

const gate = () => { let open!: () => void; const wait = new Promise<void>(resolve => { open = resolve; }); return { wait, open }; };

/** What the caller hears from a request to the voice endpoint, chunk by chunk. */
async function spokenChunks(cid: string, text: string, extra: Record<string, unknown> = {}, agent = "helper") {
  // Model the ongoing call transcript, including turns sent directly through Conversation in interruption tests.
  const messages = await inside(cid, (_instance, store) => store.messages().map(row => row.message)
    .filter(message => message.role === "user" && typeof message.content === "string" && !message.content.startsWith("[Runtime note")), agent);
  messages.push({ role: "user", content: text });
  const response = await SELF.fetch("https://brain/v1/chat/completions", {
    method: "POST", headers: auth,
    body: JSON.stringify({ model: agent, stream: true, messages, elevenlabs_extra_body: { conversation_id: cid, ...extra } }),
  });
  expect(response.status).toBe(200);
  return (await response.text()).split("\n").filter(line => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map(line => JSON.parse(line.slice(6)).choices[0].delta.content as string | undefined).filter((c): c is string => c !== undefined);
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of stream) {
    buffer += decoder.decode(bytes, { stream: true });
    for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
      out.push(JSON.parse(buffer.slice(0, end)) as TurnEvent);
      buffer = buffer.slice(end + 1);
    }
  }
  return out;
}
// The acknowledgement has its own tests; the rest compare the answers.
const said = (events: TurnEvent[]) => ACKNOWLEDGEMENTS.reduce((text, ack) => text.replaceAll(ack, ""), events.flatMap(e => e.type === "text" ? [e.delta] : []).join(""));
const request = (cid: string, id: string, text: string) => ({ clientId: "acme", agentId: "helper", conversationId: cid, input: { id, text }, voice: true });

afterEach(() => { vi.restoreAllMocks(); });

describe("waiting on a call (items 1 and 3)", () => {
  const slowClock = (instance: Conversation, ms: number) => {
    instance.progressAfterMs = 40;
    instance.ackAfterMs = 20;
    instance.catalog = {
      ...TOOLS,
      current_time: { ...TOOLS.current_time, label: "Checking the clock", async execute(context, args) { await new Promise(r => setTimeout(r, ms)); return TOOLS.current_time.execute(context, args); } },
    };
  };
  const LEAD = "Okay, let me pull up your sites and see what is live right now.";

  it("the agent's own line before a lookup is heard while it runs, in place of the fixed one, and never twice", async () => {
    // The answer repeats the line: it is said once.
    await script("wait-2", [{ text: LEAD, calls: [time()] }, { text: `${LEAD} You have one site, live at jrandcousa.com.` }]);
    await inside("wait-2", instance => slowClock(instance, 150));
    const spoken = await spokenChunks("wait-2", "What sites do you have?");
    expect(spoken.filter(chunk => chunk.trim())).toEqual([LEAD, "Checking the clock… ", "You have one site, live at jrandcousa.com."]);
    // The line and the answer do not run together.
    expect(spoken.join("")).toContain(`${LEAD} `);
    await quiet("wait-2");
  });

  it("a question written beside a lookup is not said until the lookup is done", async () => {
    await script("wait-6", [{ text: "Which site do you mean?", calls: [time()] }, { text: "You have one site. Which page do you mean?" }]);
    await inside("wait-6", instance => slowClock(instance, 0));
    const events = await inside("wait-6", async instance => drain(await instance.turn(request("wait-6", "a1", "Change the page"))));
    const finished = events.findIndex(event => event.type === "tool" && event.name === "current_time" && event.status === "succeeded");
    expect(finished).toBeGreaterThanOrEqual(0);
    expect(said(events.slice(0, finished))).not.toContain("?");
    expect(said(events.slice(finished + 1))).toContain("You have one site. Which page do you mean?");
    expect(said(events)).not.toContain("Which site do you mean?");
    await quiet("wait-6");
  });

  it("new words while the caller has heard only the line before a lookup: the answer is not said and is forgotten, the lookup stays", async () => {
    const hold = gate();
    const requests = await script("wait-7", [{ text: LEAD, calls: [time()] }, { text: "You have one site.", hold: hold.wait }, { text: "You have one site, and it is live." }]);
    const heard = await inside("wait-7", async instance => {
      const first = drain(await instance.turn(request("wait-7", "a1", "What sites do you have?")));
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      const second = drain(await instance.turn(request("wait-7", "a2", "And is it live?")));
      hold.open();
      return said([...await first, ...await second]);
    });
    expect(heard.replace(/\s+/g, " ").trim()).toBe(`${LEAD} You have one site, and it is live.`);
    expect(requests[2].messages.filter(m => m.role !== "system").map(m => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    await quiet("wait-7");
  });

  it("acknowledges only questions and requests, with lines long enough for ElevenLabs to speak at once", async () => {
    for (const line of [...ACKNOWLEDGEMENTS, ...STILL_CHECKING]) expect(line.trim().length, line).toBeGreaterThanOrEqual(55);
    for (const text of ["What sites do you have?", "How did the ads do yesterday?", "List sites", "No, change the footer to Serving Milbrook", "Thanks, and can you change the footer to blue?"]) expect(wantsLookup(text), text).toBe(true);
    for (const text of ["Yep.", "Yes, go ahead", "No thanks", "Thank you so much", "Okay, bye bye", "Hello, are you there?", "Hi Helper", "Great, thanks", "Gotcha. Thanks, Helper.", "Okay cool, thanks Helper"]) expect(wantsLookup(text), text).toBe(false);
    // Even when the agent runs a tool for it (seen live: a thanks heard "let me look that up").
    await script("wait-3", [{ calls: [time()] }, { text: "You're welcome." }]);
    expect(await spokenChunks("wait-3", "Thanks, that's all.")).toEqual(["You're welcome."]);
    // Seen live on 2026-11-09: "Gotcha" first hid the thanks.
    await script("wait-3", [{ text: "You're welcome." }]);
    expect(await spokenChunks("wait-3", "Gotcha. Thanks, Helper.")).toEqual(["You're welcome."]);
    await quiet("wait-3");
  });

  it("gives the phone speaking rules, not the old ones", async () => {
    const requests = await script("rules-1", [{ text: "Hi." }]);
    await spokenChunks("rules-1", "hi");
    const prompt = String(requests[0].messages[0].content);
    for (const rule of ["Lead with the answer", "contractions", "I'll put the link in your dashboard", "Never read out web addresses"]) expect(prompt).toContain(rule);
    expect(prompt).not.toContain("one to three short sentences");
    await quiet("rules-1");
  });

  it("calls use the model's faster tier and its prices; typed chat keeps the normal ones", async () => {
    // Second runs on the client's model, which has a tier for calls.
    const asked = (cid: string, voice: boolean) => runInDurableObject(env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`acme/second/${cid}`)), async (instance, state) => {
      const seen: ModelTurnRequest[] = [];
      instance.model = { async turn(req) { seen.push(req); req.onText?.("Hi."); return { content: "Hi.", toolCalls: [], usage }; } };
      await drain(await instance.turn({ clientId: "acme", agentId: "second", conversationId: cid, input: { id: "a1", text: "hi" }, voice }));
      await state.storage.deleteAlarm();
      return seen[0].config;
    });
    const onCall = await asked("tier-1", true);
    expect(onCall.extraBody).toEqual({ reasoning_effort: "none", service_tier: "priority" });
    expect(onCall.outputCostPerMillion).toBe(1);
    const typed = await asked("tier-2", false);
    expect(typed.extraBody).toEqual({ reasoning_effort: "none" });
    expect(typed.outputCostPerMillion).toBe(0.5);
    // Helper's own model is off calls only; spoken turns keep the client's fast tier and prices.
    const helper = await script("tier-3", [{ text: "Hi." }]);
    await spokenChunks("tier-3", "hi");
    expect(helper[0].config).toMatchObject({ model: "test-model", secretEnv: "OPENAI_API_KEY", inputCostPerMillion: 0.2, outputCostPerMillion: 1, extraBody: { service_tier: "priority" } });
    expect(helper[0].config.api).toBeUndefined();
    await quiet("tier-3");
  });
});

describe("check-ins during a running turn (item 2)", () => {
  it("a check-in hears that we are still checking, then the pending answer, and the work runs once", async () => {
    const hold = gate();
    const requests = await script("ci-1", [{ text: "It is noon.", hold: hold.wait }]);
    const [first, heard] = await inside("ci-1", async (instance, store) => {
      const original = await instance.turn(request("ci-1", "a1", "What time is it?"));
      const hello = await instance.turn(request("ci-1", "a2", "Hello?"));
      const listening = drain(hello);
      hold.open();
      const events = await listening;
      return [await drain(original), events, store.messages().filter(m => m.message.role === "user")] as const;
    });
    // The first request was cancelled by the second: it ends without the answer.
    expect(said(first)).toBe("");
    const text = said(heard);
    expect(STILL_CHECKING.some(line => text.startsWith(line))).toBe(true);
    expect(text.endsWith("It is noon.")).toBe(true);
    expect(requests).toHaveLength(1);
    await quiet("ci-1");
  });

  it("checks in with a list of short phrases, case-insensitively, and nothing else", () => {
    for (const phrase of ["hello?", "Hello", "ARE YOU THERE?", "you there", "Still there?", "Hello, are you there?"]) expect(isCheckIn(phrase)).toBe(true);
    for (const phrase of ["hello, what's my spend?", "are you there yet with the numbers for yesterday", "yes"]) expect(isCheckIn(phrase)).toBe(false);
  });

  it("a check-in is not added to the conversation", async () => {
    const hold = gate();
    await script("ci-2", [{ text: "It is noon.", hold: hold.wait }]);
    const users = await inside("ci-2", async (instance, store) => {
      await instance.turn(request("ci-2", "a1", "What time is it?"));
      const listening = drain(await instance.turn(request("ci-2", "a2", "you there")));
      hold.open();
      await listening;
      return store.messages().filter(m => m.message.role === "user").map(m => m.message.content);
    });
    expect(users).toEqual(["What time is it?"]);
    await quiet("ci-2");
  });

  it("a new question before the first answer was heard stops that turn: one reply at once, the first answer is never said, and both questions stand unanswered", async () => {
    const hold = gate();
    const requests = await script("ci-3", [{ text: "It is noon.", hold: hold.wait }, { text: "It is noon on Friday." }]);
    const [heard, spent] = await inside("ci-3", async (instance, store) => {
      await instance.turn(request("ci-3", "a1", "What time is it?"));
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      // The first turn's model call never finishes here: the new question is answered without waiting behind it.
      const answer = said(await drain(await instance.turn(request("ci-3", "a2", "And what day is it?"))));
      return [answer, store.spentUsd()] as const;
    });
    hold.open();
    expect(heard).toBe("It is noon on Friday.");
    // The reply nobody heard was never written, so the model answers both questions at once.
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.filter(m => m.role !== "system")).toEqual([{ role: "user", content: "What time is it?" }, { role: "user", content: "And what day is it?" }]);
    // The stopped call is counted at its input and a small allowance, not as if it had used its whole output reservation.
    const base = modelFor(CLIENTS.find(c => c.id === "acme")!, "helper", true);
    const model = { ...base, ...base.voice };
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBeLessThan(model.maxOutputTokens * model.outputCostPerMillion / 1_000_000);
    await quiet("ci-3");
  });

  it("the same words sent again while the turn runs do not run it twice", async () => {
    const hold = gate();
    const requests = await script("ci-4", [{ text: "It is noon.", hold: hold.wait }]);
    const heard = await inside("ci-4", async instance => {
      await instance.turn(request("ci-4", "a1", "What time is it?"));
      const listening = drain(await instance.turn(request("ci-4", "a1", "What time is it?")));
      hold.open();
      return said(await listening);
    });
    expect(heard).toBe("It is noon.");
    expect(requests).toHaveLength(1);
    await quiet("ci-4");
  });

  it("a check-in that waits too long gives up kindly; a new question then gets one reply, not the old answer first", async () => {
    const hold = gate();
    const requests = await script("ci-5", [{ text: "It is noon.", hold: hold.wait }, { text: "It is Friday." }]);
    const [giveUp, next] = await inside("ci-5", async (instance, store) => {
      instance.checkInWaitMs = 30;
      await instance.turn(request("ci-5", "a1", "What time is it?"));
      const tired = said(await drain(await instance.turn(request("ci-5", "a2", "hello"))));
      hold.open();
      await vi.waitFor(() => expect(store.meta("unheard")).toBe("It is noon."), { timeout: 3_000, interval: 20 });
      return [tired, said(await drain(await instance.turn(request("ci-5", "a3", "What day is it?"))))] as const;
    });
    expect(STILL_CHECKING.some(line => giveUp.startsWith(line))).toBe(true);
    expect(giveUp.endsWith(STILL_WORKING)).toBe(true);
    expect(next).toBe("It is Friday.");
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.some(m => m.role === "assistant")).toBe(false);
    await quiet("ci-5");
  });

  it("an answer nobody heard is not said after new words: its lookup stays, its reply is forgotten", async () => {
    const hold = gate();
    const requests = await script("ci-6", [{ calls: [time()] }, { text: "It is noon.", hold: hold.wait }, { text: "It is noon, and all is quiet." }]);
    const next = await inside("ci-6", async (instance, store) => {
      const cancelled = await instance.turn(request("ci-6", "a1", "What time is it?"));
      await cancelled.cancel();
      hold.open();
      await vi.waitFor(() => expect(store.meta("unheard")).toBe("It is noon."), { timeout: 3_000, interval: 20 });
      return said(await drain(await instance.turn(request("ci-6", "a2", "Anything else?"))));
    });
    expect(next).toBe("It is noon, and all is quiet.");
    expect(requests).toHaveLength(3);
    // Nothing is looked up twice: the model still has the lookup and its result, with both of the caller's lines unanswered.
    expect(requests[2].messages.filter(m => m.role !== "system").map(m => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    await quiet("ci-6");
  });

  it("a check-in after an answer nobody heard gets that answer and no new turn", async () => {
    const hold = gate();
    const requests = await script("ci-7", [{ text: "It is noon.", hold: hold.wait }]);
    const next = await inside("ci-7", async (instance, store) => {
      await (await instance.turn(request("ci-7", "a1", "What time is it?"))).cancel();
      hold.open();
      await vi.waitFor(() => expect(store.meta("unheard")).toBe("It is noon."), { timeout: 3_000, interval: 20 });
      return said(await drain(await instance.turn(request("ci-7", "a2", "Hello?"))));
    });
    expect(next).toBe("It is noon.");
    expect(requests).toHaveLength(1);
    await quiet("ci-7");
  });
});

describe("cut-ins on a call (item E)", () => {
  // A lookup that takes a moment: a stopped turn lets it finish, so the requests behind it wait their turn.
  const slowLookup = (instance: Conversation) => {
    instance.catalog = { ...TOOLS, current_time: { ...TOOLS.current_time, async execute(context, args) { await new Promise(r => setTimeout(r, 150)); return TOOLS.current_time.execute(context, args); } } };
  };

  it("one answer, to everything said: resent longer sentences are dropped, other waiting words are carried into the newest, and a stopped turn finishes its lookup, says nothing and asks the model no more", async () => {
    const requests = await script("cut-1", [{ calls: [time()] }, { text: "It is noon." }]);
    const { drained, users } = await inside("cut-1", async (instance, store) => {
      slowLookup(instance);
      const first = await instance.turn(request("cut-1", "a1", "Change the hero"));
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      const later = [];
      for (const [i, text] of ["Change the hero to", "Change the hero to Built", "Never mind, what time is it"].entries()) later.push(await instance.turn(request("cut-1", `a${i + 2}`, text)));
      const events = await Promise.all([first, ...later].map(stream => drain(stream)));
      return { drained: events.map(said), users: store.messages().filter(row => row.message.role === "user").map(row => row.message.content) };
    });
    // The first request was in its lookup, and the caller heard none of it: it stops after the lookup. The two in between
    // never ran: "Change the hero to" was only resent longer, and "Change the hero to Built" goes in front of the newest words.
    expect(drained).toEqual(["", "", "", "It is noon."]);
    expect(requests).toHaveLength(2);
    expect(users).toEqual(["Change the hero", "Change the hero to Built Never mind, what time is it"]);
    // Nothing is looked up twice: the lookup and its result stay.
    expect(requests[1].messages.filter(m => m.role !== "system").map(m => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    await quiet("cut-1");
  });

  it("three quick fragments reach the model whole: the one still waiting its turn is not lost", async () => {
    const requests = await script("cut-2", [{ calls: [time()] }, { text: "Friday at noon it is." }]);
    const drained = await inside("cut-2", async instance => {
      slowLookup(instance);
      const streams = [await instance.turn(request("cut-2", "a1", "Can you book lunch with Alex?"))];
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      for (const [i, text] of ["Friday.", "At noon."].entries()) streams.push(await instance.turn(request("cut-2", `a${i + 2}`, text)));
      return (await Promise.all(streams.map(stream => drain(stream)))).map(said);
    });
    expect(drained).toEqual(["", "", "Friday at noon it is."]);
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.filter(m => m.role === "user")).toEqual([{ role: "user", content: "Can you book lunch with Alex?" }, { role: "user", content: "Friday. At noon." }]);
    await quiet("cut-2");
  });
});

describe("read-back before changes (item 4)", () => {
  const direction = { business: "JR", concept: "c", mood: "m", signature: "s", pages: ["Home"], brand: {
    mode: "own", source: "https://brand.example/", logo: "https://brand.example/logo.svg",
    colors: [{ role: "primary", hex: "#123456" }, { role: "background", hex: "#ffffff" }],
    fonts: {
      heading: { name: "Inter", stylesheet: "https://fonts.googleapis.com/css2?family=Inter", kind: "free-web-font" },
      body: { name: "Inter", stylesheet: "https://fonts.googleapis.com/css2?family=Inter", kind: "free-web-font" },
    },
  } };
  const propose = (id: string, task: string, extra: object = {}) => call(id, "propose_change", { task, ...extra });
  const start = (id: string) => call(id, "start_in_background", {});
  const sentence = (task: string) => readBackSentence(task);
  const lastResult = (request: ModelTurnRequest, back = 1) => String(request.messages.at(-back)?.content);
  // Jobs started from a call run in their own conversation, `<call>-job-<n>`.
  const jobOf = (cid: string, n = 1) => inside(`${cid}-job-${n}`, (_i, store) => loadJob(store));
  const HERO = "Change the hero headline to Built to Last";

  /** The caller asks, the agent records the change and says the read-back (the next thing the caller says is their answer). */
  async function readBack(cid: string, task: string, extra: object = {}) {
    await script(cid, [{ calls: [propose("p1", task, extra)] }, { text: sentence(task) }]);
    expect(await spokenChunks(cid, task)).toContain(sentence(task));
  }

  it("understands a plain yes, and not a correction", () => {
    for (const yes of ["Yes", "YES", "yeah, go ahead", "Yep.", "Yup", "Sure", "Okay", "Correct", "Confirm", "Confirmed", "I confirm", "go ahead", "do it", "that's right", "Please do", "yep, do it", "Yes please do"]) expect(isYes(yes), yes).toBe(true);
    for (const no of ["No", "Yes but make it blue", "actually change it to Built Strong", "yes and also update the footer and the about page too", "what?"]) expect(isYes(no)).toBe(false);
  });

  it("confirms only the caller's first words after the proposal, when they are a plain yes, and the agent said something", () => {
    const pending = { task: "change it", after: 2, at: 0 };
    const rows = (...messages: ChatMessage[]) => messages.map((message, i) => ({ seq: i + 1, message }));
    const ask = { role: "user", content: "Change it" } as const;
    const said = (text: string) => ({ role: "assistant", content: text }) as const;
    const yes = { role: "user", content: "Yes" } as const;
    // The agent's words are not compared: any line from the proposing reply on counts, even a paraphrase.
    expect(confirmedChange(rows(ask, said("Okay, so I change it, right?"), yes), pending, 0)).toBe(true);
    expect(confirmedChange(rows(ask, said("Just to confirm: change it?"), { role: "user", content: "Yes but not today" }), pending, 0)).toBe(false);
    // Something the caller said in between: the yes answers something else.
    expect(confirmedChange(rows(ask, said("Just to confirm: change it?"), { role: "user", content: "Hold on" }, said("Anything else?"), yes), pending, 0)).toBe(false);
    // Nothing was said after the proposal, or the yes came before it.
    expect(confirmedChange(rows(ask, { role: "assistant", content: null }, yes), pending, 0)).toBe(false);
    // A line said beside the proposal itself is not the question.
    expect(confirmedChange(rows(ask, { role: "assistant", content: "Okay, one second.", tool_calls: [call("p1", "propose_change", { task: "change it" })] }, yes), pending, 0)).toBe(false);
    expect(confirmedChange(rows(ask, said("Just to confirm: change it?"), yes), { ...pending, after: 3 }, 0)).toBe(false);
    expect(confirmedChange(rows(ask, said("Just to confirm: change it?"), yes), pending, PENDING_TTL_MS + 1)).toBe(false);
  });

  it("an unrelated yes starts nothing", async () => {
    await readBack("rb-1", HERO);
    // No: the change is not wanted. The agent moves on, and the caller's next yes answers "anything else?".
    await script("rb-1", [{ text: "Okay. Anything else?" }]);
    await spokenChunks("rb-1", "No");
    const refused = await script("rb-1", [{ calls: [start("b1")] }, { text: "Anything else?" }]);
    await spokenChunks("rb-1", "Yes");
    expect(lastResult(refused[1])).toContain("the caller has not confirmed");
    expect(await jobOf("rb-1")).toBeUndefined();
    await quiet("rb-1");
  });

  it("does not hand off work when the caller's yes only identifies a site", async () => {
    const cid = "site-choice-is-not-consent";
    try {
      await script(cid, [{ text: "Do you mean the cedar-studio site?" }]);
      await spokenChunks(cid, "I'm talking about the studio site.");
      const attempted = await script(cid, [{ calls: [start("premature-start")] }, { text: "What would you like changed there?" }]);
      await spokenChunks(cid, "Yes");
      expect(lastResult(attempted[1])).toContain("the caller has not confirmed");
      expect(await jobOf(cid)).toBeUndefined();
    } finally {
      await quiet(cid);
    }
  });

  it("a plain yes to the read-back starts exactly the stored task, once, without asking the model", async () => {
    await readBack("rb-2", HERO);
    await script("rb-2-job-1", [{ text: "Done." }]);
    const requests = await script("rb-2", [{ calls: [start("b2")] }, { text: "Anything else?" }]);
    expect(await spokenChunks("rb-2", "Yes")).toEqual([STARTED_SPOKEN]);
    expect(requests).toHaveLength(0);
    expect(await jobOf("rb-2")).toMatchObject({ input: { text: HERO } });
    // The same yes cannot start it again: the read-back was used up.
    await spokenChunks("rb-2", "Yep");
    expect(lastResult(requests[1])).toContain("the caller has not confirmed");
    expect(await jobOf("rb-2", 2)).toBeUndefined();
    await Promise.all([quiet("rb-2"), quiet("rb-2-job-1")]);
  });

  it("loops no more: each plain yes after a read-back starts the work (seen live 2026-11-09)", async () => {
    await readBack("rb-12", HERO);
    await script("rb-12-job-1", [{ text: "Done." }]);
    // Live, the model answered three plain yeses by reading the change back again; the yes no longer goes to the model.
    const requests = await script("rb-12", [{ calls: [propose("p2", HERO)] }, { text: `${HERO} — yes?` }]);
    for (const yes of ["Yes, go ahead.", "Yes, I approve that.", "I approve that.", "Approved"]) expect(isYes(yes), yes).toBe(true);
    expect(await spokenChunks("rb-12", "Yes, go ahead.")).toEqual([STARTED_SPOKEN]);
    expect(requests).toHaveLength(0);
    expect(await jobOf("rb-12")).toMatchObject({ input: { text: HERO } });
    await Promise.all([quiet("rb-12"), quiet("rb-12-job-1")]);
  });

  it("takes no task from the model when starting", async () => {
    await readBack("rb-3", HERO);
    // Not a plain yes, so the model answers; the task it tries to slip in is refused.
    const requests = await script("rb-3", [{ calls: [call("b1", "start_in_background", { task: "Delete everything" })] }, { text: "Sorry." }]);
    await spokenChunks("rb-3", "Make it happen");
    expect(lastResult(requests[1])).toContain("Invalid arguments");
    expect(await jobOf("rb-3")).toBeUndefined();
    await quiet("rb-3");
  });

  it("a change proposed after the read-back must be read back again", async () => {
    await readBack("rb-4", HERO);
    const requests = await script("rb-4", [{ calls: [propose("p2", "Delete the whole site")] }, { calls: [start("b1")] }, { text: "Just to confirm: delete the whole site?" }]);
    await spokenChunks("rb-4", "Make it happen");
    expect(lastResult(requests[2])).toContain("the caller has not confirmed");
    expect(await jobOf("rb-4")).toBeUndefined();
    await quiet("rb-4");
  });

  it("a correction replaces the pending change, and only the corrected one starts", async () => {
    await readBack("rb-5", HERO);
    await script("rb-5", [{ calls: [propose("p2", "Change the hero headline to Built Strong")] }, { text: sentence("Change the hero headline to Built Strong") }]);
    await spokenChunks("rb-5", "No, make it Built Strong");
    await script("rb-5-job-1", [{ text: "Done." }]);
    expect(await spokenChunks("rb-5", "Yes")).toEqual([STARTED_SPOKEN]);
    expect(await jobOf("rb-5")).toMatchObject({ input: { text: "Change the hero headline to Built Strong" } });
    await Promise.all([quiet("rb-5"), quiet("rb-5-job-1")]);
  });

  it("a read-back expires after five minutes", async () => {
    await readBack("rb-6", HERO);
    await inside("rb-6", (_i, store) => store.setMeta("pendingChange", JSON.stringify({ ...JSON.parse(store.meta("pendingChange")!), at: Date.now() - PENDING_TTL_MS - 1 })));
    const requests = await script("rb-6", [{ calls: [start("b1")] }, { text: "Sorry." }]);
    await spokenChunks("rb-6", "Yes");
    expect(lastResult(requests[1])).toContain("the caller has not confirmed");
    expect(await jobOf("rb-6")).toBeUndefined();
    await quiet("rb-6");
  });

  it("holds anything a person must approve to the read-back tool and its exact args", async () => {
    // Without a read-back it is refused.
    const direct = await script("rb-7", [{ calls: [call("p1", "approve_record", direction)] }, { text: "Just to confirm: file the JR record?" }]);
    await spokenChunks("rb-7", "File a record for JR");
    expect(lastResult(direct[1])).toContain("the caller has not confirmed");
    expect((await inside("rb-7", (_i, store) => store.actions())).filter(action => action.tool === "approve_record")).toEqual([]);

    // With one, a plain yes files exactly the read-back tool and args, without the model.
    await script("rb-7", [{ calls: [propose("p2", "File the JR record", { tool: "approve_record", args: direction })] }, { text: sentence("File the JR record") }]);
    await spokenChunks("rb-7", "No, file the JR record");
    const requests = await script("rb-7", [{ calls: [call("p3", "approve_record", { ...direction, business: "Other" })] }, { text: "It is waiting for approval." }]);
    expect(await spokenChunks("rb-7", "Yes")).toEqual([APPROVAL_FILED_SPOKEN]);
    expect(requests).toHaveLength(0);
    expect((await inside("rb-7", (_i, store) => store.actions())).filter(action => action.tool === "approve_record").map(action => [action.args.business, action.status])).toEqual([["JR", "awaiting_approval"]]);
    await quiet("rb-7");
  });

  it("never says a sentence twice in one reply, and nothing follows a read-back question", async () => {
    await script("sp-1", [{ text: "Sure thing. Sure thing. Glad to help." }]);
    expect((await spokenChunks("sp-1", "hi")).join("")).toBe("Sure thing. Glad to help.");

    // After a read-back the reply is only the question: nothing after it, and the repeat is gone.
    await script("sp-2", [{ calls: [propose("p1", HERO)] }, { text: `${sentence(HERO)} Anything else? ${sentence(HERO)}` }]);
    expect(said((await spokenChunks("sp-2", HERO)).map(delta => ({ type: "text", delta }) as TurnEvent)).trim()).toBe(sentence(HERO));

    // The same sentence said before the tool and again after it is said once, and the turn still completes; the yes still confirms.
    await script("sp-3", [{ text: sentence(HERO), calls: [propose("p1", HERO)] }, { text: sentence(HERO) }]);
    expect(said((await spokenChunks("sp-3", HERO)).map(delta => ({ type: "text", delta }) as TurnEvent))).toBe(sentence(HERO));
    await script("sp-3-job-1", [{ text: "Done." }]);
    expect(await spokenChunks("sp-3", "Yes")).toEqual([STARTED_SPOKEN]);
    expect(await jobOf("sp-3")).toMatchObject({ input: { text: HERO } });
    await Promise.all([quiet("sp-1"), quiet("sp-2"), quiet("sp-3"), quiet("sp-3-job-1")]);
  });

  it("an interrupted read-back keeps the change: one short question, then a yes confirms", async () => {
    await readBack("ra-1", HERO);
    // The caller talks over it with something that is not an answer; the agent asks again, briefly, for the same change.
    const short = `${HERO} — yes?`;
    const requests = await script("ra-1", [{ calls: [propose("p2", HERO)] }, { text: `${short} Anything else?` }]);
    expect((await spokenChunks("ra-1", "Uh, hold on a second")).join("").trim()).toBe(short);
    expect(lastResult(requests[1])).toContain(short);
    expect(lastResult(requests[1])).not.toContain("Just to confirm");
    await script("ra-1-job-1", [{ text: "Done." }]);
    expect(await spokenChunks("ra-1", "Yep")).toEqual([STARTED_SPOKEN]);
    expect(await jobOf("ra-1")).toMatchObject({ input: { text: HERO } });
    await Promise.all([quiet("ra-1"), quiet("ra-1-job-1")]);
  });

  it("a yes said before the read-back was heard starts nothing: the change is read back in full and needs its own yes", async () => {
    const hold = gate();
    const requests = await script("ra-2", [{ calls: [propose("p1", HERO)] }, { text: sentence(HERO), hold: hold.wait }, { calls: [start("b1")] }, { calls: [propose("p2", HERO)] }, { text: sentence(HERO) }]);
    await script("ra-2-job-1", [{ text: "Done." }]);
    const heard = await inside("ra-2", async instance => {
      // The caller says yes (to the "let me check" line, say) while the read-back is still being worked out.
      const first = await instance.turn(request("ra-2", "a1", HERO));
      await vi.waitFor(() => expect(requests).toHaveLength(2), { timeout: 3_000, interval: 10 });
      const yes = drain(await instance.turn(request("ra-2", "a2", "Yes")));
      hold.open();
      await drain(first);
      return said(await yes);
    });
    expect(heard).toBe(sentence(HERO));
    expect(lastResult(requests[3])).toContain("the caller has not confirmed");
    expect(await jobOf("ra-2")).toBeUndefined();
    // Now they have heard it, their yes starts it.
    expect(await spokenChunks("ra-2", "Yes")).toEqual([STARTED_SPOKEN]);
    expect(await jobOf("ra-2")).toMatchObject({ input: { text: HERO } });
    await Promise.all([quiet("ra-2"), quiet("ra-2-job-1")]);
  });

  it("the caller kept talking: only the longer sentence is answered, with the full read-back, once", async () => {
    const hold = gate();
    const requests = await script("ka-1", [{ calls: [propose("p1", HERO)] }, { text: sentence(HERO), hold: hold.wait }, { calls: [propose("p2", HERO)] }, { text: sentence(HERO) }]);
    const [earlier, later] = await inside("ka-1", async instance => {
      const first = await instance.turn(request("ka-1", "a1", "Change the hero headline to Built to Last"));
      // The earlier words are being worked on (their read-back is waiting to be said) when the longer sentence arrives.
      await vi.waitFor(() => expect(requests).toHaveLength(2), { timeout: 3_000, interval: 10 });
      const second = drain(await instance.turn(request("ka-1", "a2", "Change the hero headline to Built to Last, and tell me when it's done")));
      hold.open();
      return [said(await drain(first)), said(await second)] as const;
    });
    expect(earlier).toBe("");
    expect(later.trim()).toBe(sentence(HERO));
    // The first read-back was never heard, so the second is the full question, not the short "— yes?".
    expect(JSON.parse(lastResult(requests[3])).result.readBack).toBe(sentence(HERO));
    await quiet("ka-1");
  });

  it("a detail added before the read-back was heard gets one read-back, with the detail (seen live 2026-11-10)", async () => {
    // On the call: "Can you book lunch with Alex?", a pause, "Friday." The caller heard two read-backs in a row.
    const [vague, exact] = ["Book lunch with Alex at a time you choose", "Book lunch with Alex on Friday"];
    const hold = gate();
    const requests = await script("bn-1", [{ calls: [propose("p1", vague)] }, { text: sentence(vague), hold: hold.wait }, { calls: [propose("p2", exact)] }, { text: sentence(exact) }]);
    const [earlier, later] = await inside("bn-1", async instance => {
      const first = await instance.turn(request("bn-1", "a1", "Can you book lunch with Alex?"));
      await vi.waitFor(() => expect(requests).toHaveLength(2), { timeout: 3_000, interval: 10 });
      const second = drain(await instance.turn(request("bn-1", "a2", "Friday.")));
      hold.open();
      return [said(await drain(first)), said(await second)] as const;
    });
    expect(earlier).toBe("");
    expect(later).toBe(sentence(exact));
    // The first read-back is forgotten (its proposal and result stay), so "Friday." joins the request it belongs to.
    const seen = requests[2].messages.filter(m => m.role !== "system");
    expect(seen.map(m => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(seen.map(m => m.content).filter(Boolean)).toEqual(["Can you book lunch with Alex?", expect.stringContaining(sentence(vague)), "Friday."]);
    await quiet("bn-1");
  });

  it("work that was started is always told, even when newer words arrive before the caller hears it", async () => {
    await readBack("oc-1", HERO);
    await script("oc-1-job-1", [{ text: "Done." }]);
    await script("oc-1", [{ text: "It is noon." }]);
    const next = await inside("oc-1", async (instance, store) => {
      await (await instance.turn(request("oc-1", "a2", "Yep"))).cancel();
      await vi.waitFor(() => expect(store.meta("unheard")).toBe(STARTED_SPOKEN), { timeout: 3_000, interval: 20 });
      return said(await drain(await instance.turn(request("oc-1", "a3", "What time is it?"))));
    });
    expect(next).toBe(`${STARTED_SPOKEN} It is noon.`);
    expect(await jobOf("oc-1")).toMatchObject({ input: { text: HERO } });
    await Promise.all([quiet("oc-1"), quiet("oc-1-job-1")]);
  });

  it("a job started from a call puts its final reply on the dashboard, one card per call even for the same words", async () => {
    for (const [cid, reply] of [["cj-1", "What is the business called?"], ["cj-2", "Done."]]) {
      await readBack(cid, HERO);
      await script(`${cid}-job-1`, [{ text: reply }]);
      expect(await spokenChunks(cid, "Yes")).toEqual([STARTED_SPOKEN]);
      await vi.waitFor(async () => expect(await jobOf(cid)).toMatchObject({ status: "done" }), { timeout: 3_000, interval: 20 });
    }
    expect((await jobOf("cj-1"))?.id).toBe((await jobOf("cj-2"))?.id);
    const { cards } = JSON.parse(await env.DASHBOARD.get(env.DASHBOARD.idFromName("acme")).list(100)) as { cards: { kind: string; title: string; summary: string; conversationId: string }[] };
    const card = (cid: string) => cards.filter(c => c.conversationId === `${cid}-job-1`);
    // A question says how to answer it, since this chat cannot be opened.
    expect(card("cj-1")).toEqual([expect.objectContaining({ kind: "status", title: `From a call: ${HERO}`, summary: "What is the business called?\n\nTo answer, call or message Helper again." })]);
    expect(card("cj-2")).toEqual([expect.objectContaining({ kind: "status", title: `From a call: ${HERO}`, summary: "Done." })]);
    await Promise.all(["cj-1", "cj-2", "cj-1-job-1", "cj-2-job-1"].map(cid => quiet(cid)));
  });
});

describe("call briefing (item 7)", () => {
  beforeEach(() => recentBriefings.clear());
  const site = { name: "jr-and-co", stage: "live", domain: "jrandcousa.com", liveUrl: "https://jrandcousa.com", previewState: "READY", updatedAt: 2 };

  it("tells the agent to answer yesterday and last-7-days questions from the briefing, without any tool", async () => {
    const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName("acme/second/bf-q"));
    const seen: ModelTurnRequest[] = [];
    const { text, actions } = await runInDurableObject(stub, async (instance, state) => {
      instance.model = { async turn(req) { seen.push(req); req.onText?.("Yesterday you spent about two hundred dollars."); return { content: "Yesterday you spent about two hundred dollars.", toolCalls: [], usage }; } };
      await instance.setBriefing("acme", "second", "Google Ads yesterday: spend $212, 40 clicks");
      const answer = said(await drain(await instance.turn({ clientId: "acme", agentId: "second", conversationId: "bf-q", input: { id: "a1", text: "How did ads do yesterday?" }, voice: true })));
      await state.storage.deleteAlarm();
      return { text: answer, actions: new Store(state.storage).actions() };
    });
    const system = String(seen[0].messages[0].content);
    expect(system).toContain("yesterday and the last 7 days");
    expect(system).toContain("do NOT call any tool");
    expect(system).toContain("Google Ads yesterday: spend $212");
    expect(text).toContain("two hundred dollars");
    expect(seen).toHaveLength(1);
    expect(actions).toEqual([]);
  });

  it("never delays phone-start: the answer is out before the warm-up finishes", async () => {
    const slow = gate();
    const second = AGENTS.second;
    const original = second.briefing;
    second.briefing = async () => { await slow.wait; return "- Google Ads, yesterday: spend 40 USD, 20 clicks, 2 conversions"; };
    try {
      const waiting: Promise<unknown>[] = [];
      await answerPractice("acme/second/phone-CAbriefsecond1");
      const response = await phoneStart(
        new Request("https://brain/v1/voice/phone-start?agent=second", { method: "POST", body: JSON.stringify({ call_sid: "CAbriefsecond1" }) }),
        env as unknown as Env, CLIENTS.find(c => c.id === "acme")!, { waitUntil: p => { waiting.push(p); } },
      );
      expect(response.status).toBe(200);
      const store = () => runInDurableObject(env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName("acme/second/phone-CAbriefsecond1")), (_i, state) => new Store(state.storage).meta("briefing"));
      expect(await store()).toBeUndefined();
      slow.open();
      await Promise.all(waiting);
      expect(await store()).toContain("Google Ads, yesterday");
    } finally {
      second.briefing = original;
    }
  });

  it("reads the accounts once for calls within 15 minutes of each other", async () => {
    const second = AGENTS.second;
    const original = second.briefing;
    const read = vi.fn(async () => "- Meta, yesterday: spend 10 USD, 5 clicks, 1 conversions");
    second.briefing = read;
    try {
      for (const sid of ["CAreuse000001", "CAreuse000002"]) {
        const waiting: Promise<unknown>[] = [];
        await answerPractice(`acme/second/phone-${sid}`);
        await phoneStart(new Request("https://brain/v1/voice/phone-start?agent=second", { method: "POST", body: JSON.stringify({ call_sid: sid }) }), env as unknown as Env, CLIENTS.find(c => c.id === "acme")!, { waitUntil: p => { waiting.push(p); } });
        await Promise.all(waiting);
        expect(await runInDurableObject(env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`acme/second/phone-${sid}`)), (_i, state) => new Store(state.storage).meta("briefing"))).toContain("Meta, yesterday");
      }
      expect(read).toHaveBeenCalledOnce();
    } finally {
      second.briefing = original;
    }
  });

  it("passes the saved site's status to the call without requiring a site lookup", async () => {
    await inside("brief-use", instance => instance.setBriefing("acme", "helper", "- jr-and-co: stage live; live domain jrandcousa.com; latest preview ready"));
    const requests = await script("brief-use", [{ text: "Your site is live on jrandcousa.com." }]);
    expect(await spokenChunks("brief-use", "Is my site live?")).toEqual(["Your site is live on jrandcousa.com."]);
    expect(requests).toHaveLength(1);
    expect(String(requests[0].messages[0].content)).toContain("jr-and-co: stage live; live domain jrandcousa.com");
    expect((await inside("brief-use", (_i, store) => store.actions()))).toEqual([]);
    await quiet("brief-use");
  });

  it("is not used after 15 minutes, nor on typed chat", async () => {
    await inside("brief-old", async (instance, store) => {
      await instance.setBriefing("acme", "helper", "- stale line");
      store.setMeta("briefingAt", String(Date.now() - 16 * 60_000));
    });
    const requests = await script("brief-old", [{ text: "Hi." }]);
    await spokenChunks("brief-old", "hi");
    expect(String(requests[0].messages[0].content)).not.toContain("stale line");

    await inside("brief-typed", instance => instance.setBriefing("acme", "helper", "- fresh line"));
    const typed = await script("brief-typed", [{ text: "Hi." }]);
    await SELF.fetch("https://brain/v1/agents/helper/conversations/brief-typed/messages", { method: "POST", headers: auth, body: JSON.stringify({ id: "m1", text: "hi" }) }).then(r => r.text());
    expect(String(typed[0].messages[0].content)).not.toContain("fresh line");
    await Promise.all([quiet("brief-old"), quiet("brief-typed")]);
  });

});

describe("phone-start webhook", () => {
  it("still answers with the call's own conversation, whatever the agent query", async () => {
    await answerPractice("acme/helper/phone-CAstillsame001");
    const start = await SELF.fetch("https://brain/v1/voice/phone-start?agent=helper", { method: "POST", headers: auth, body: JSON.stringify({ call_sid: "CAstillsame001" }) });
    expect(await start.json()).toEqual({ type: "conversation_initiation_client_data", custom_llm_extra_body: { conversation_id: "phone-CAstillsame001" }, dynamic_variables: {} });
  });
});

describe("the closing offer on a call (\"Anything else?\")", () => {
  /** What the caller hears for their words (the spacing between spoken chunks evened out), without the endpoint's request allowance. */
  const hears = (cid: string, id: string, text: string) => inside(cid, async instance => said(await drain(await instance.turn(request(cid, id, text)))).replace(/\s+/g, " ").trim());

  it("tells the bare offer from a question about the work", () => {
    const offers = [
      "Anything else?", "Is there anything else?", "Okay, anything else?", "Great—anything else?", "Is there anything else I can help you with today?",
      "Anything else I can do for you?", "Do you need anything else?", "Do you want anything else?", "Is there anything else you'd like?",
      "Is there anything more I can help with?", "What else can I help you with?", "How else can I help?",
    ];
    for (const offer of offers) expect(isClosingOffer(offer), offer).toBe(true);
    const others = [
      "Anything else you want on the home page?", "Is there anything else you'd like to change on the hero?", "Anything else I should know?",
      "Anything else, or should I publish it now?", "Did anything else break after the update?", "Something else?", "Anything else.", "What else should the footer say?",
    ];
    for (const other of others) expect(isClosingOffer(other), other).toBe(false);
  });

  it("is left out of a call's first reply, said once after that, and left out again for the rest of the call", async () => {
    await script("co-1", [{ text: "Doing well, thanks. Anything else?" }, { text: "Your site is live. Anything else?" }, { text: "The form works too. Is there anything else I can help you with?" }]);
    expect(await hears("co-1", "a1", "Hi Helper, how are you doing?")).toBe("Doing well, thanks.");
    expect(await hears("co-1", "a2", "Is my site live right now?")).toBe("Your site is live. Anything else?");
    expect(await hears("co-1", "a3", "And does the contact form work?")).toBe("The form works too.");
    await quiet("co-1");
  });

  it("ends the reply: an answer the model starts over after it is not said", async () => {
    await script("co-2", [{ text: "Hi there." }, { text: "Understood. I'll leave everything unchanged. Anything else? Understood. Nothing changed." }, { text: "Got it. Anything else? Got it, nothing more from me." }]);
    await hears("co-2", "a1", "Hi Helper, this is a quick test.");
    expect(await hears("co-2", "a2", "Just testing the line, change nothing please.")).toBe("Understood. I'll leave everything unchanged. Anything else?");
    // The call has had its one: the offer goes, and so does what follows it.
    expect(await hears("co-2", "a3", "Okay, that was the whole test.")).toBe("Got it.");
    await quiet("co-2");
  });

  it("is kept when it is all the reply says, or all it says after a lookup, so the caller is never left with nothing", async () => {
    await script("co-3", [{ text: "Anything else?" }]);
    expect(await hears("co-3", "a1", "Ah, never mind that then.")).toBe("Anything else?");
    const lead = "Okay, let me check what time it is in Milbrook for you right now.";
    await script("co-3b", [{ text: lead, calls: [time()] }, { text: "Anything else?" }]);
    expect(await hears("co-3b", "a1", "What time is it in Milbrook?")).toBe(`${lead} Anything else?`);
    await Promise.all([quiet("co-3"), quiet("co-3b")]);
  });

  it("leaves a question about the work alone, however often it is asked", async () => {
    await script("co-4", [{ text: "Hi." }, { text: "The hero is updated. Anything else?" }, { text: "Noted. Anything else you want on the home page?" }]);
    await hears("co-4", "a1", "Hi Helper, this is a quick test.");
    await hears("co-4", "a2", "Please tell me the hero is updated.");
    expect(await hears("co-4", "a3", "Add the phone number to the page.")).toBe("Noted. Anything else you want on the home page?");
    await quiet("co-4");
  });

  // The line before each lookup below is long enough to be spoken at once (SPOKEN_AT_ONCE), so no filler joins it.
  const LEAD = "Okay, let me check what time it is in Milbrook for you right now.";

  it("written beside a lookup it is not heard, does not end the reply, and does not use up the call's one", async () => {
    await script("co-5", [{ text: "Hi." }, { text: `${LEAD} Anything else?`, calls: [time()] }, { text: "It is noon." }, { text: "Done. Anything else?" }]);
    await hears("co-5", "a1", "Hi Helper, this is a quick test.");
    expect(await hears("co-5", "a2", "What time is it in Milbrook?")).toBe(`${LEAD} It is noon.`);
    expect(await hears("co-5", "a3", "Please confirm the first thing.")).toBe("Done. Anything else?");
    await quiet("co-5");
  });

  it("left out beside a lookup, it still lets the answer after the lookup be heard", async () => {
    // A call's first reply: the offer is not allowed, so it is dropped, not held.
    await script("co-7", [{ text: `${LEAD} Anything else?`, calls: [time()] }, { text: "It is noon." }]);
    expect(await hears("co-7", "a1", "What time is it in Milbrook?")).toBe(`${LEAD} It is noon.`);
    await quiet("co-7");
  });

  it("may be said again half an hour after the last one", async () => {
    await script("co-6", [{ text: "Hi." }, { text: "Done. Anything else?" }]);
    await hears("co-6", "a1", "Hi Helper, this is a quick test.");
    expect(await hears("co-6", "a2", "Please confirm the first thing.")).toBe("Done. Anything else?");
    expect(await hears("co-6", "a3", "Please confirm the second thing.")).toBe("Done.");
    // The same conversation, still going or talked in again much later (in-app Talk keeps one conversation).
    await inside("co-6", (_instance, store) => store.setMeta("closingOfferAt", String(Date.now() - 31 * 60_000)));
    expect(await hears("co-6", "a4", "Please confirm the third thing.")).toBe("Done. Anything else?");
    await quiet("co-6");
  });
});
