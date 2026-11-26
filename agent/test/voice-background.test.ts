import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Conversation } from "../src/conversation";
import type { ToolCall } from "../src/contracts";
import { loadJob, MAX_QUEUED } from "../src/jobs";
import type { ModelAdapter, ModelTurnRequest } from "../src/model";
import { readBackSentence, STARTED_SPOKEN } from "../src/voice";
import { Store } from "../src/store";
import { TOOLS } from "../tools";

const auth = { authorization: "Bearer test-token-acme-0123456789abcdef", "content-type": "application/json" };
const usage = { inputTokens: 5, outputTokens: 2 };
const call = (id: string, name: string, args: object): ToolCall => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const time = () => call("t1", "current_time", { timezone: "America/Chicago" });

interface Step { text?: string; calls?: ToolCall[]; /** Reports the first call while streaming, like the real adapter. */ streamCalls?: boolean; before?(instance: Conversation): unknown; /** Waits for this before answering. */ hold?: Promise<void> }

const inside = <T>(cid: string, fn: (instance: Conversation, store: Store, state: DurableObjectState) => Promise<T> | T) =>
  runInDurableObject(env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`acme/helper/${cid}`)), (instance, state) => fn(instance, new Store(state.storage), state));
/** Nothing waits for the real alarm in a finished test. */
const quiet = (cid: string) => inside(cid, (_i, _s, state) => state.storage.deleteAlarm());

/** A model that plays `steps` in order (the last repeats) and records every request. */
async function script(cid: string, steps: Step[]) {
  const requests: ModelTurnRequest[] = [];
  await inside(cid, instance => {
    let i = 0;
    instance.model = {
      async turn(request) {
        requests.push(request);
        const n = i++;
        const step = steps[Math.min(n, steps.length - 1)];
        await step.hold;
        await step.before?.(instance);
        if (step.text) request.onText?.(step.text);
        if (step.streamCalls && step.calls?.length) request.onToolCall?.(step.calls[0].function.name);
        return { content: step.text ?? "", toolCalls: step.calls ?? [], usage };
      },
    } satisfies ModelAdapter;
  });
  return requests;
}

/** What the caller hears, chunk by chunk, from a voice turn. */
async function call_(cid: string, text = "Please do it") {
  const messages = await inside(cid, (_instance, store) => store.messages().map(row => row.message)
    .filter(message => typeof message.content === "string"
      && (message.role === "assistant" && !message.tool_calls || message.role === "user" && !message.content.startsWith("[Runtime note"))));
  messages.push({ role: "user", content: text });
  const response = await SELF.fetch("https://brain/v1/chat/completions", {
    method: "POST", headers: auth,
    body: JSON.stringify({ model: "helper", stream: true, messages, elevenlabs_extra_body: { conversation_id: cid } }),
  });
  expect(response.status).toBe(200);
  return (await response.text()).split("\n").filter(line => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map(line => JSON.parse(line.slice(6)).choices[0].delta.content as string | undefined).filter((c): c is string => c !== undefined);
}

const toolNames = (request: ModelTurnRequest) => request.tools.map(tool => tool.name);

/** The call so far: the caller asked for a change, the agent recorded it with propose_change and read it back as a question (the caller's yes is the next message). */
async function readBack(cid: string, task = "Change it") {
  await script(cid, [
    { calls: [call(crypto.randomUUID(), "propose_change", { task })] },
    { text: readBackSentence(task) },
  ]);
  await call_(cid, task);
}

describe("start_in_background", () => {
  it("returns the voice reply while the job is still running", async () => {
    let release!: () => void;
    await readBack("bg-2", "Publish the page");
    await script("bg-2-job-1", [{ text: "Published.", hold: new Promise<void>(r => { release = r; }) }]);
    expect(await call_("bg-2", "Yes")).toEqual([STARTED_SPOKEN]);
    expect(await inside("bg-2-job-1", (_i, store) => loadJob(store))).toMatchObject({ status: "running", input: { text: "Publish the page" } });
    release();
    await vi.waitFor(async () => expect((await inside("bg-2-job-1", (_i, store) => loadJob(store)))?.status).toBe("done"), { timeout: 8_000, interval: 50 });
    await Promise.all([quiet("bg-2"), quiet("bg-2-job-1")]);
  });

  it("keeps the call free while the job runs: later turns are answered, and a second job gets its own conversation", async () => {
    let release!: () => void;
    await readBack("bg-3", "Second request");
    await script("bg-3-job-1", [{ text: "First done.", hold: new Promise<void>(r => { release = r; }) }]);
    await script("bg-3", [{ text: "Sure, here you go." }]);
    expect(await call_("bg-3", "Yes")).toEqual([STARTED_SPOKEN]);
    expect(await inside("bg-3-job-1", (_i, store) => loadJob(store))).toMatchObject({ status: "running", input: { text: "Second request" } });
    // The call's own conversation has no job, so the caller is not told to wait.
    expect(await inside("bg-3", (_i, store) => loadJob(store))).toBeUndefined();
    expect((await call_("bg-3", "What is the weather like?")).join("")).not.toContain("still working on your last request");
    await readBack("bg-3", "Third request");
    await script("bg-3-job-2", [{ text: "Second done." }]);
    expect(await call_("bg-3", "Yes, do it")).toEqual([STARTED_SPOKEN]);
    expect(await inside("bg-3-job-2", (_i, store) => loadJob(store))).toMatchObject({ input: { text: "Third request" } });
    release();
    await Promise.all([quiet("bg-3"), quiet("bg-3-job-1"), quiet("bg-3-job-2")]);
  });

  it("refuses after too many jobs on one call, and the agent says so", async () => {
    await readBack("bg-4", "One too many");
    await inside("bg-4", (_i, store) => store.setMeta("callJobs", String(MAX_QUEUED)));
    // The yes tries to start it; the refusal goes to the model, which tells the caller.
    const requests = await script("bg-4", [{ text: "Sorry, too many are running." }]);
    expect(await call_("bg-4", "Yes")).toEqual(["Sorry, too many are running."]);
    expect(String(requests[0].messages.at(-1)?.content)).toContain("Too many jobs were started");
    expect(await inside("bg-4-job-11", (_i, store) => loadJob(store))).toBeUndefined();
    await quiet("bg-4");
  });

  it("is offered, and explained in the prompt, on voice turns only", async () => {
    const voice = await script("bg-5", [{ text: "Hi." }]);
    await call_("bg-5");
    const typed = await script("bg-6", [{ text: "Hi." }]);
    await SELF.fetch("https://brain/v1/agents/helper/conversations/bg-6/messages", { method: "POST", headers: auth, body: JSON.stringify({ id: "m1", text: "hi" }) }).then(r => r.text());
    expect(toolNames(voice[0])).toEqual(expect.arrayContaining(["start_in_background", "propose_change"]));
    expect(JSON.stringify(voice[0].messages[0])).toContain("start_in_background");
    expect(toolNames(typed[0])).not.toContain("start_in_background");
    expect(toolNames(typed[0])).not.toContain("propose_change");
    expect(JSON.stringify(typed[0].messages[0])).not.toContain("start_in_background");
    // Job-only tools cost a model step each on a call and do nothing there.
    expect(toolNames(voice[0])).not.toContain("update_progress");
    expect(toolNames(voice[0])).not.toContain("check_back_in");
    expect(toolNames(typed[0])).toEqual(expect.arrayContaining(["update_progress", "check_back_in"]));
    await expect(TOOLS.start_in_background.execute({} as never, { task: "x" })).rejects.toMatchObject({ definite: true });
    await expect(TOOLS.propose_change.execute({} as never, { task: "x" })).rejects.toMatchObject({ definite: true });
    await Promise.all([quiet("bg-5"), quiet("bg-6")]);
  });
});
