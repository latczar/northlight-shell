import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENTS } from "../agents";
import { CLIENTS } from "../clients";
import type { AgentTemplate, ClientConfig, ToolCall, ToolDefinition, TurnEvent } from "../src/contracts";
import { decideAction, runTurn, type TurnDeps } from "../src/loop";
import { CompatibleChatAdapter, ProviderAdapter, type ModelAdapter, type ModelTurnReply, type ModelTurnRequest } from "../src/model";
import { ModelProtocolError } from "../src/errors";
import { DEFAULT_LIMITS, limitsFor } from "../src/limits";
import { COMPACT_PROMPT } from "../src/prompts";
import { Store } from "../src/store";
import { MEDIA_PUBLIC_BASE } from "../src/media";
import { requestInputEstimate } from "../src/vision";
import { noDesk } from "./desk";

/** A nested draft schema (ad groups, ads, description lengths) for checking that schema errors name the exact field. */
const CAMPAIGN_SCHEMA = { type: "object", required: ["adGroups"], properties: { adGroups: { type: "array", items: { type: "object", properties: {
  ads: { type: "array", items: { type: "object", properties: { descriptions: { type: "array", items: { type: "string", maxLength: 90 } }, finalUrl: { type: "string" } } } },
} } } } };

const client: ClientConfig = {
  id: "test", name: "Test Co", tokenEnv: "CLIENT_TOKEN_TEST", agents: ["helper"],
  permissions: ["records.read", "records.write"],
  model: {
    baseURL: "https://model.invalid", model: "fake", secretEnv: "DEEPSEEK_API_KEY",
    inputCostPerMillion: 1, outputCostPerMillion: 1, maxOutputTokens: 1000, contextWindowTokens: 100_000,
  },
};
const agent: AgentTemplate = { id: "helper", name: "Helper", role: "test", prompt: "You help.", tools: ["lookup", "lookup_b", "save", "secret_tool"] };

function call(id: string, name: string, args: object = {}): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}
const reply = (content: string, toolCalls: ToolCall[] = [], inputTokens = 100): ModelTurnReply =>
  ({ content, toolCalls, usage: { inputTokens, outputTokens: 10 } });

/** Model that streams scripted replies and records every request. */
function scripted(...replies: (ModelTurnReply | ((request: ModelTurnRequest) => ModelTurnReply))[]) {
  const requests: ModelTurnRequest[] = [];
  const model: ModelAdapter = {
    async turn(request) {
      requests.push(request);
      const next = replies.shift();
      if (!next) throw new Error("Model called more times than scripted");
      const response = typeof next === "function" ? next(request) : next;
      request.onText?.(response.content);
      return response;
    },
  };
  return { model, requests };
}

function tool(name: string, overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name, description: name, parameters: { type: "object", properties: {}, additionalProperties: false },
    permission: "records.read", effect: "read", parallelSafe: false, timeoutMs: 5_000,
    async execute() { return { data: { ok: name } }; },
    ...overrides,
  };
}

/** Runs `fn` against a fresh conversation's real Durable Object storage. */
async function withStore<T>(fn: (store: Store) => Promise<T>): Promise<T> {
  const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.newUniqueId());
  return runInDurableObject(stub, async (_instance, state) => fn(new Store(state.storage)));
}

function deps(store: Store, model: ModelAdapter, catalog: Record<string, ToolDefinition>, overrides: Partial<TurnDeps> = {}) {
  const events: TurnEvent[] = [];
  const d: TurnDeps = {
    store, model, client, agent, catalog, conversationId: "c1", bindings: env,
    desk: noDesk, modelKey: () => "key", emit: event => events.push(event), ...overrides,
  };
  return { deps: d, events };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("agent loop", () => {
  it.each([
    { voice: false, content: "" },
    { voice: true, content: "" },
    { voice: false, content: " \n " },
    { voice: true, content: " \n " },
  ])("does not save an empty model reply and accepts the next turn (voice=$voice, content=$content)", async ({ voice, content }) => {
    await withStore(async store => {
      const { model, requests } = scripted(reply(content), request => {
        expect(request.messages.some(message => message.role === "assistant" && !message.content?.trim() && !message.tool_calls?.length)).toBe(false);
        expect(request.messages.at(-1)).toEqual({ role: "user", content: "Are you still there?" });
        return reply("Yes, I'm here.");
      });
      const d = deps(store, model, {}, { voice }).deps;
      const fallback = "Sorry, I couldn't come up with a reply. Could you say that again?";
      expect(await runTurn(d, { id: "empty", text: "Hello" })).toMatchObject({ status: "stopped", text: fallback });
      expect(store.messages().filter(row => row.message.role === "assistant").map(row => row.message.content)).toEqual([fallback]);
      expect(store.input("empty")?.reply).toBe(fallback);
      expect(await runTurn(d, { id: "next", text: "Are you still there?" })).toMatchObject({ status: "replied", text: "Yes, I'm here." });
      expect(requests).toHaveLength(2);
    });
  });

  it.each([false, true])("repairs legacy empty assistant history while preserving a valid tool exchange (voice=%s)", async voice => {
    await withStore(async store => {
      const lookup = call("earlier", "lookup");
      store.append({ role: "user", content: "Look that up." });
      store.append({ role: "assistant", content: null, tool_calls: [lookup] });
      store.append({ role: "assistant", content: null });
      store.append({ role: "assistant", content: "" });
      store.append({ role: "assistant", content: " \n " });
      store.append({ role: "assistant", content: null, tool_calls: [] });
      store.append({ role: "tool", tool_call_id: lookup.id, content: '{"ok":true}' });
      store.append({ role: "assistant", content: "I found it." });
      const { model, requests } = scripted(request => {
        expect(request.messages.filter(message => message.role !== "system")).toEqual([
          { role: "user", content: "Look that up." },
          { role: "assistant", content: null, tool_calls: [lookup] },
          { role: "tool", tool_call_id: lookup.id, content: '{"ok":true}' },
          { role: "assistant", content: "I found it." },
          { role: "user", content: "Can we continue?" },
        ]);
        return reply("Yes, we can continue.");
      });
      const result = await runTurn(deps(store, model, { lookup: tool("lookup") }, { voice }).deps, { id: "next", text: "Can we continue?" });
      expect(result).toMatchObject({ status: "replied", text: "Yes, we can continue." });
      expect(requests).toHaveLength(1);
      expect(store.messages().filter(row => row.message.role === "assistant" && !row.message.content?.trim() && !row.message.tool_calls?.length)).toHaveLength(4);
    });
  });

  it("answers, then stops at the per-message step limit when the model keeps calling tools", async () => {
    await withStore(async store => {
      const loopForever = scripted(...Array.from({ length: 3 }, (_, i) => reply("", [call(`c${i}`, "lookup")])));
      const { deps: d } = deps(store, loopForever.model, { lookup: tool("lookup") },
        { client: { ...client, limits: { maxTurnSteps: 3 } } });
      const result = await runTurn(d, { id: "m1", text: "go" });
      expect(result.status).toBe("stopped");
      expect(loopForever.requests).toHaveLength(3);
      expect(store.actions().map(a => a.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    });
  });

  it("saves every action from a reply before running any of them", async () => {
    await withStore(async store => {
      const seen: string[][] = [];
      const recording = tool("lookup", {
        async execute() {
          seen.push(store.actions().map(a => `${a.id}:${a.status}`));
          return { data: {} };
        },
      });
      const { model } = scripted(reply("", [call("a", "lookup"), call("b", "lookup")]), reply("done"));
      await runTurn(deps(store, model, { lookup: recording }).deps, { id: "m1", text: "go" });
      expect(seen[0]).toEqual(["a:running", "b:intent"]);
    });
  });

  it("runs parallel-safe calls together and other calls one at a time", async () => {
    await withStore(async store => {
      let active = 0, peak = 0;
      const slow = (name: string, parallelSafe: boolean) => tool(name, {
        parallelSafe,
        async execute() {
          peak = Math.max(peak, ++active);
          // Yield so a sibling started in the same batch can begin before this one ends.
          for (let i = 0; i < 10; i++) await Promise.resolve();
          active--;
          return { data: {} };
        },
      });
      const safe = scripted(reply("", [call("a", "lookup"), call("b", "lookup_b")]), reply("ok"));
      await runTurn(deps(store, safe.model, { lookup: slow("lookup", true), lookup_b: slow("lookup_b", true) }).deps, { id: "m1", text: "go" });
      expect(peak).toBe(2);

      peak = 0;
      const unsafe = scripted(reply("", [call("c", "lookup"), call("d", "lookup_b")]), reply("ok"));
      await runTurn(deps(store, unsafe.model, { lookup: slow("lookup", true), lookup_b: slow("lookup_b", false) }).deps, { id: "m2", text: "go" });
      expect(peak).toBe(1);
    });
  });

  it("returns tool results to the model in call order, with errors as results", async () => {
    await withStore(async store => {
      const { model, requests } = scripted(
        reply("", [call("a", "lookup"), call("b", "missing_tool"), call("c", "lookup", { extra: 1 })]),
        reply("done"),
      );
      await runTurn(deps(store, model, { lookup: tool("lookup") }).deps, { id: "m1", text: "go" });
      const results = requests[1].messages.filter(m => m.role === "tool");
      expect(results.map(m => m.role === "tool" && m.tool_call_id)).toEqual(["a", "b", "c"]);
      expect(results[1]).toMatchObject({ content: expect.stringContaining("Unknown or unavailable tool") });
      expect(results[2]).toMatchObject({ content: expect.stringContaining("Invalid arguments") });
    });
  });

  it("names nested draft failures so the next model step can correct them before any tool runs", async () => {
    await withStore(async store => {
      const execute = vi.fn<ToolDefinition["execute"]>(async () => ({ data: { checked: true } }));
      const draft = {
        name: "Commercial roofing", dailyBudget: 30, currency: "USD",
        locations: [{ id: "123", name: "Example city" }],
        adGroups: [{
          name: "Roofing", keywords: [{ text: "commercial roofing", matchType: "PHRASE" }],
          ads: [{ headlines: ["Commercial Roofing", "Roof Repair", "Request an Inspection"],
            descriptions: ["a".repeat(91), "b".repeat(76), "c".repeat(91)], finalUrl: "https://roofing.example/" }],
        }],
      };
      const corrected = structuredClone(draft);
      corrected.adGroups[0].ads[0].descriptions = ["a".repeat(90), "b".repeat(76), "c".repeat(90)];
      const { model } = scripted(
        reply("", [call("invalid", "lookup", draft)]),
        request => {
          const failure = request.messages.find(m => m.role === "tool" && m.tool_call_id === "invalid");
          expect(failure).toMatchObject({ content: expect.stringContaining("#/adGroups/0/ads/0/descriptions/0: String is too long (91 > 90)") });
          expect(failure).toMatchObject({ content: expect.stringContaining("#/adGroups/0/ads/0/descriptions/2: String is too long (91 > 90)") });
          expect(execute).not.toHaveBeenCalled();
          return reply("", [call("corrected", "lookup", corrected)]);
        },
        reply("Draft checked."),
      );
      const result = await runTurn(deps(store, model, {
        lookup: tool("lookup", { parameters: CAMPAIGN_SCHEMA, execute }),
      }).deps, { id: "draft", text: "Check the draft." });
      expect(result.text).toBe("Draft checked.");
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0][1]).toEqual(corrected);
      expect(store.action("invalid")).toBeUndefined();
      expect(store.action("corrected")?.status).toBe("succeeded");
    });
  });

  it.each([
    [{ type: "string", enum: ["PHRASE", "EXACT"] }, "BROAD", "#/value", "PHRASE"],
    [{ type: "object", required: ["budget"] }, {}, "#/value", "budget"],
    [{ type: "object", additionalProperties: false }, { extra: 1 }, "#/value/extra", "False boolean schema"],
    [{ oneOf: [{ type: "string" }, { minLength: 1 }] }, "both", "#/value", "2 matches"],
  ])("keeps useful field errors when a constraint has no deeper detail", async (schema, value, path, reason) => {
    await withStore(async store => {
      const execute = vi.fn<ToolDefinition["execute"]>(async () => ({ data: {} }));
      const { model, requests } = scripted(reply("", [call("bad", "lookup", { value })]), reply("Please correct the input."));
      await runTurn(deps(store, model, {
        lookup: tool("lookup", {
          parameters: { type: "object", properties: { value: schema } },
          execute,
        }),
      }).deps, { id: "invalid", text: "Check this." });
      const result = requests[1].messages.find(m => m.role === "tool");
      expect(result).toMatchObject({ content: expect.stringContaining(path) });
      expect(result).toMatchObject({ content: expect.stringContaining(reason) });
      expect(execute).not.toHaveBeenCalled();
    });
  });

  it("does not offer tools the client has no permission for", async () => {
    await withStore(async store => {
      const { model, requests } = scripted(reply("hi"));
      const secretTool = tool("secret_tool", { permission: "billing.write" });
      await runTurn(deps(store, model, { lookup: tool("lookup"), secret_tool: secretTool }).deps, { id: "m1", text: "hi" });
      expect(requests[0].tools.map(t => t.name)).toEqual(["lookup"]);
    });
  });

  it("marks a failed write uncertain and refuses to run that tool again", async () => {
    await withStore(async store => {
      let runs = 0;
      const save = tool("save", {
        effect: "write", permission: "records.write",
        async execute() { runs++; throw new Error("connection reset"); },
      });
      const { model, requests } = scripted(reply("", [call("w1", "save")]), reply("", [call("w2", "save")]), reply("sorry"));
      await runTurn(deps(store, model, { save }).deps, { id: "m1", text: "save it" });
      expect(runs).toBe(1);
      expect(store.action("w1")?.status).toBe("uncertain");
      expect(store.action("w2")?.status).toBe("failed");
      expect(requests[1].messages.at(-1)).toMatchObject({ content: expect.stringContaining("uncertain") });
    });
  });

  it("after a crash, reconciles an interrupted write instead of running it again", async () => {
    await withStore(async store => {
      let runs = 0;
      const save = tool("save", {
        effect: "write", permission: "records.write",
        async execute() { runs++; return { data: {} }; },
        async reconcile() { return { status: "succeeded", result: { data: { found: true } } }; },
      });
      // State left by a process that died mid-tool: call saved as running, no result message.
      store.append({ role: "user", content: "save it" });
      store.append({ role: "assistant", content: null, tool_calls: [call("w1", "save")] });
      store.putAction({ id: "w1", tool: "save", args: {}, status: "running", attempts: 1, createdAt: 1, updatedAt: 1 });

      const { model, requests } = scripted(reply("It was saved."));
      await runTurn(deps(store, model, { save }).deps, { id: "m2", text: "did it work?" });
      expect(runs).toBe(0);
      expect(store.action("w1")?.status).toBe("succeeded");
      const toolMessage = requests[0].messages.find(m => m.role === "tool");
      expect(toolMessage).toMatchObject({ tool_call_id: "w1", content: expect.stringContaining("found") });
    });
  });

  it("after a crash without reconcile, leaves the write uncertain", async () => {
    await withStore(async store => {
      const save = tool("save", { effect: "write", permission: "records.write" });
      store.append({ role: "assistant", content: null, tool_calls: [call("w1", "save")] });
      store.putAction({ id: "w1", tool: "save", args: {}, status: "running", attempts: 1, createdAt: 1, updatedAt: 1 });
      const { model } = scripted(reply("A person will check."));
      await runTurn(deps(store, model, { save }).deps, { id: "m2", text: "status?" });
      expect(store.action("w1")?.status).toBe("uncertain");
    });
  });

  it("a repeated approval after a restart reconciles a running write even though its original proposal already has a tool reply", async () => {
    await withStore(async store => {
      let runs = 0;
      let checks = 0;
      const save = tool("save", {
        effect: "write", permission: "records.write", approval: () => ({ title: "Save", summary: "Save it" }),
        async execute() { runs++; return { data: {} }; },
        async reconcile() { checks++; return { status: "succeeded", result: { data: { found: true } } }; },
      });
      store.append({ role: "assistant", content: null, tool_calls: [call("approved-crash", "save")] });
      store.append({ role: "tool", tool_call_id: "approved-crash", content: JSON.stringify({ awaitingApproval: true }) });
      store.putAction({ id: "approved-crash", tool: "save", args: {}, status: "running", attempts: 1, createdAt: 1, updatedAt: 1 });
      const { model } = scripted();
      const d = deps(store, model, { save }).deps;
      expect((await decideAction(d, "approved-crash", true, "")).status).toBe("done");
      expect((await decideAction(d, "approved-crash", true, "")).status).toBe("done");
      expect(runs).toBe(0);
      expect(checks).toBe(1);
      expect(store.action("approved-crash")?.status).toBe("succeeded");
    });
  });

  it("an interrupted approved write without reconciliation stays uncertain, never runs again or gets reported done", async () => {
    await withStore(async store => {
      let runs = 0;
      const save = tool("save", { effect: "write", permission: "records.write",
        async execute() { runs++; return { data: {} }; },
      });
      store.putAction({ id: "approved-unknown", tool: "save", args: {}, status: "running", attempts: 1, createdAt: 1, updatedAt: 1 });
      const { model } = scripted();
      const d = deps(store, model, { save }).deps;
      expect((await decideAction(d, "approved-unknown", true, "")).status).toBe("uncertain");
      expect((await decideAction(d, "approved-unknown", true, "")).status).toBe("uncertain");
      expect(runs).toBe(0);
      expect(store.action("approved-unknown")?.status).toBe("uncertain");
    });
  });

  it("rechecks an answered uncertain opt-in approval on the next message without executing another write", async () => {
    await withStore(async store => {
      const recoveryClient = { ...client, id: `recovery-${crypto.randomUUID()}` };
      const dashboard = env.DASHBOARD.get(env.DASHBOARD.idFromName(recoveryClient.id));
      let writes = 0, checks = 0;
      const save = tool("save", {
        effect: "write", permission: "records.write", recoverUncertain: true,
        approval: () => ({ title: "Save", summary: "Save it" }),
        async execute() { writes++; throw new Error("connection reset"); },
        async reconcile() { checks++; return { status: "succeeded", result: { data: { found: true } } }; },
      });
      const { model, requests } = scripted(reply("", [call("recovery-approved", "save")]), reply("Waiting for approval."), reply("Verified."), reply("Still verified."));
      const d = deps(store, model, { save }, { client: recoveryClient }).deps;
      await runTurn(d, { id: "propose", text: "save it" });
      await dashboard.decide("recovery-approved", true, "approver", "");
      const decision = await decideAction(d, "recovery-approved", true, "");
      expect(decision.status).toBe("uncertain");
      await dashboard.finish("recovery-approved", "uncertain", decision.content);
      expect(JSON.parse((await dashboard.finish("recovery-approved", "done", '{"unverified":true}'))!)).toMatchObject({ status: "uncertain" });
      expect(store.messages().some(({ message }) => message.role === "tool" && message.tool_call_id === "recovery-approved")).toBe(true);

      await runTurn(d, { id: "check", text: "Please check again." });
      expect(writes).toBe(1);
      expect(checks).toBe(1);
      expect(store.action("recovery-approved")).toMatchObject({ status: "succeeded", attempts: 1, result: { data: { found: true } } });
      expect(store.action("recovery-approved")?.error).toBeUndefined();
      expect(JSON.parse((await dashboard.approvalJson("recovery-approved"))!)).toMatchObject({
        status: "done", decidedBy: "approver", result: { actionId: "recovery-approved", result: { found: true } },
      });
      expect(await dashboard.get("approval-recovery-approved")).toMatchObject({ kind: "status", title: "Done: Save" });
      expect(requests[2].messages).toContainEqual({
        role: "user", content: expect.stringContaining("A read-only recovery check verified completion of the earlier save request recovery-approved. No write was retried."),
      });
      await runTurn(d, { id: "later", text: "status?" });
      expect(checks).toBe(1);
      expect(store.messages().filter(({ message }) => message.role === "user" && message.content.includes("A read-only recovery check"))).toHaveLength(1);
    });
  });

  it.each(["absent", "unknown", "throws"] as const)("keeps an answered opt-in write blocked when recovery is %s", async outcome => {
    await withStore(async store => {
      let writes = 0, checks = 0;
      const save = tool("save", {
        effect: "write", permission: "records.write", recoverUncertain: true,
        async execute() { writes++; return { data: {} }; },
        async reconcile() {
          checks++;
          if (outcome === "throws") throw new Error("read unavailable");
          return outcome === "absent" ? { status: "absent" } : { status: "unknown", reason: "incomplete read" };
        },
      });
      store.append({ role: "assistant", content: null, tool_calls: [call("uncertain-recorded", "save")] });
      store.append({ role: "tool", tool_call_id: "uncertain-recorded", content: JSON.stringify({ uncertain: true }) });
      store.putAction({ id: "uncertain-recorded", tool: "save", args: {}, status: "uncertain", error: "Timed out.", attempts: 1, createdAt: 1, updatedAt: 1 });
      const { model } = scripted(reply("", [call("blocked-repeat", "save")]), reply("Still uncertain."));
      await runTurn(deps(store, model, { save }).deps, { id: "fresh", text: "check again" });
      expect(checks).toBe(1);
      expect(writes).toBe(0);
      expect(store.action("uncertain-recorded")).toMatchObject({ status: "uncertain", attempts: 1 });
      expect(store.action("blocked-repeat")).toMatchObject({ status: "failed", error: expect.stringContaining("earlier call to this tool has an uncertain result") });
      expect(store.messages().some(({ message }) => message.role === "user" && message.content.includes("verified completion"))).toBe(false);
    });
  });

  it("does not recheck an answered uncertain write whose tool has not opted in", async () => {
    await withStore(async store => {
      let checks = 0;
      const save = tool("save", {
        effect: "write", permission: "records.write",
        async reconcile() { checks++; return { status: "succeeded", result: { data: {} } }; },
      });
      store.append({ role: "assistant", content: null, tool_calls: [call("nonopt-recorded", "save")] });
      store.append({ role: "tool", tool_call_id: "nonopt-recorded", content: JSON.stringify({ uncertain: true }) });
      store.putAction({ id: "nonopt-recorded", tool: "save", args: {}, status: "uncertain", attempts: 1, createdAt: 1, updatedAt: 1 });
      const { model } = scripted(reply("A person must check."));
      await runTurn(deps(store, model, { save }).deps, { id: "fresh", text: "check again" });
      expect(checks).toBe(0);
      expect(store.action("nonopt-recorded")?.status).toBe("uncertain");
    });
  });

  it.each(["absent", "succeeded"] as const)("reconciles a missing opt-in result only once per recovery pass when %s", async outcome => {
    await withStore(async store => {
      let checks = 0;
      const save = tool("save", {
        effect: "write", permission: "records.write", recoverUncertain: true,
        async reconcile() { checks++; return outcome === "absent" ? { status: "absent" } : { status: "succeeded", result: { data: { found: true } } }; },
      });
      store.append({ role: "assistant", content: null, tool_calls: [call("missing-optin", "save")] });
      store.putAction({ id: "missing-optin", tool: "save", args: {}, status: "running", attempts: 1, createdAt: 1, updatedAt: 1 });
      const { model, requests } = scripted(reply("Still uncertain."));
      await runTurn(deps(store, model, { save }).deps, { id: "fresh", text: "check again" });
      expect(checks).toBe(1);
      expect(store.action("missing-optin")?.status).toBe(outcome === "absent" ? "uncertain" : "succeeded");
      expect(requests[0].messages.filter(message => message.role === "tool")).toEqual([
        { role: "tool", tool_call_id: "missing-optin", content: expect.stringContaining(outcome === "absent" ? '"uncertain":true' : '"found":true') },
      ]);
      if (outcome === "succeeded") {
        const toolIndex = requests[0].messages.findIndex(message => message.role === "tool");
        const evidenceIndex = requests[0].messages.findIndex(message => message.role === "user" && typeof message.content === "string" && message.content.includes("A read-only recovery check"));
        expect(evidenceIndex).toBeGreaterThan(toolIndex);
      }
    });
  });

  it.each(["1", "noted"])("finishes an orphan approval card after local verification with recovery marker %s", async marker => {
    await withStore(async store => {
      const recoveryClient = { ...client, id: `orphan-${crypto.randomUUID()}` };
      const dashboard = env.DASHBOARD.get(env.DASHBOARD.idFromName(recoveryClient.id));
      await dashboard.propose({ id: "orphan", agent: agent.id, conversationId: "c1", tool: "save", title: "Save", summary: "Save it", previewJson: "{}" });
      await dashboard.decide("orphan", true, "approver", "");
      if (marker === "1") await dashboard.finish("orphan", "uncertain", '{"uncertain":true}');
      // Crash after saving verified state, before dashboard finish (possibly after writing the evidence).
      store.putAction({ id: "orphan", tool: "save", args: {}, status: "succeeded", result: { data: { found: true } }, attempts: 1, createdAt: 1, updatedAt: 2 });
      store.setMeta("recovery-finish-orphan", marker);
      if (marker === "noted") store.append({ role: "user", content: "[Runtime note, not from the user] A read-only recovery check verified completion of the earlier save request orphan. No write was retried." });
      let writes = 0, checks = 0;
      const save = tool("save", {
        effect: "write", permission: "records.write", recoverUncertain: true,
        async execute() { writes++; return { data: {} }; },
        async reconcile() { checks++; return { status: "unknown", reason: "Must not need another read." }; },
      });
      const { model, requests } = scripted(reply("Verified."));
      await runTurn(deps(store, model, { save }, { client: recoveryClient }).deps, { id: "fresh", text: "check again" });
      expect(writes).toBe(0);
      expect(checks).toBe(0);
      expect(JSON.parse((await dashboard.approvalJson("orphan"))!)).toMatchObject({ status: "done" });
      expect(await dashboard.get("approval-orphan")).toMatchObject({ kind: "status", title: "Done: Save" });
      expect(store.meta("recovery-finish-orphan")).toBe("");
      expect(requests[0].messages.filter(message => message.role === "user" && typeof message.content === "string" && message.content.includes("A read-only recovery check"))).toHaveLength(1);
    });
  });

  it("recovery preserves final approval cards and refuses mismatched approval scope", async () => {
    await withStore(async store => {
      const recoveryClient = { ...client, id: `recovery-finals-${crypto.randomUUID()}` };
      const dashboard = env.DASHBOARD.get(env.DASHBOARD.idFromName(recoveryClient.id));
      const cases = ["pending", "declined", "failed", "done", "wrong-agent", "wrong-conversation", "wrong-tool"] as const;
      const before = [];
      for (const state of cases) {
        await dashboard.propose({
          id: state, agent: state === "wrong-agent" ? "other" : agent.id, conversationId: state === "wrong-conversation" ? "other" : "c1",
          tool: state === "wrong-tool" ? "other" : "save", title: "Save", summary: "Save it", previewJson: "{}",
        });
        if (state !== "pending") await dashboard.decide(state, state !== "declined", "approver", "");
        if (state === "declined") await dashboard.closeDeclined(state);
        else if (state !== "pending") await dashboard.finish(state, state === "failed" || state === "done" ? state : "uncertain", '{"prior":true}');
        before.push({ approval: await dashboard.approvalJson(state), card: await dashboard.get(`approval-${state}`) });
        store.putAction({ id: state, tool: "save", args: {}, status: "succeeded", result: { data: { found: true } }, attempts: 1, createdAt: 1, updatedAt: 2 });
        store.setMeta(`recovery-finish-${state}`, "1");
      }
      const { model } = scripted(reply("Checked."));
      const save = tool("save", { effect: "write", permission: "records.write", recoverUncertain: true });
      await runTurn(deps(store, model, { save }, { client: recoveryClient }).deps, { id: "fresh", text: "check again" });
      for (const [index, state] of cases.entries()) {
        expect(await dashboard.approvalJson(state)).toBe(before[index].approval);
        expect(await dashboard.get(`approval-${state}`)).toEqual(before[index].card);
      }
    });
  });

  it("stops before calling the model when the cost limit is used up", async () => {
    await withStore(async store => {
      store.reserve("old", 0, 0, 5, 0);
      const { model, requests } = scripted();
      const result = await runTurn(deps(store, model, {}, { client: { ...client, limits: { maxCostUsd: 5 } } }).deps, { id: "m1", text: "hi" });
      expect(result.status).toBe("stopped");
      expect(requests).toHaveLength(0);
    });
  });

  it("keeps a failed model call's cost reserved", async () => {
    await withStore(async store => {
      const model: ModelAdapter = { async turn() { throw new Error("network"); } };
      await expect(runTurn(deps(store, model, {}).deps, { id: "m1", text: "hi" })).rejects.toThrow("network");
      expect(store.spentUsd()).toBeGreaterThan(0);
    });
  });

  it("answers a retried message id with that message's own reply, even after newer messages", async () => {
    await withStore(async store => {
      const { model, requests } = scripted(reply("first answer"), reply("second answer"));
      const { deps: d, events } = deps(store, model, {});
      await runTurn(d, { id: "m1", text: "hi" });
      await runTurn(d, { id: "m2", text: "more" });
      const again = await runTurn(d, { id: "m1", text: "hi" });
      expect(again).toEqual({ status: "duplicate", text: "first answer" });
      expect(requests).toHaveLength(2);
      expect(events.at(-1)).toEqual({ type: "text", delta: "first answer" });
    });
  });

  it("finishes an interrupted message when it is retried, without adding it twice", async () => {
    await withStore(async store => {
      let calls = 0;
      const model: ModelAdapter = {
        async turn(request) {
          if (++calls === 1) throw new Error("connection dropped");
          expect(request.messages.filter(m => m.role === "user")).toEqual([{ role: "user", content: "hi" }]);
          return reply("recovered answer");
        },
      };
      const d = deps(store, model, {}).deps;
      await expect(runTurn(d, { id: "m1", text: "hi" })).rejects.toThrow("connection dropped");
      const retry = await runTurn(d, { id: "m1", text: "hi" });
      expect(retry).toEqual({ status: "replied", text: "recovered answer" });
      expect(calls).toBe(2);
      // A third attempt is now a plain duplicate.
      expect(await runTurn(d, { id: "m1", text: "hi" })).toEqual({ status: "duplicate", text: "recovered answer" });
    });
  });

  it("does not resume an interrupted message once a newer message has been answered", async () => {
    await withStore(async store => {
      let calls = 0;
      const model: ModelAdapter = {
        async turn() {
          if (++calls === 1) throw new Error("connection dropped");
          return reply("answer to m2");
        },
      };
      const d = deps(store, model, {}).deps;
      await expect(runTurn(d, { id: "m1", text: "first" })).rejects.toThrow();
      await runTurn(d, { id: "m2", text: "second" });
      const historyBefore = store.messages().length;
      const retry = await runTurn(d, { id: "m1", text: "first" });
      expect(retry.status).toBe("stopped");
      expect(retry.text).toContain("interrupted");
      expect(calls).toBe(2);
      expect(store.messages()).toHaveLength(historyBefore);
    });
  });

  it("compacts older history when the provider's real token count nears the window", async () => {
    await withStore(async store => {
      const small = { ...client, model: { ...client.model, contextWindowTokens: 10_000, maxOutputTokens: 500 } };
      const { model, requests } = scripted(
        reply("first", [], 9_000), // the provider reports a large prompt
        reply("Summary: user said hi."),
        reply("second"),
      );
      const d = deps(store, model, {}, { client: small }).deps;
      await runTurn(d, { id: "m1", text: "hi" });
      await runTurn(d, { id: "m2", text: "and now?" });
      expect(requests).toHaveLength(3);
      expect(requests[1].tools).toEqual([]);
      const history = requests[2].messages.slice(1);
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({ role: "user", content: expect.stringContaining("Summary: user said hi.") });
      expect(history[1]).toEqual({ role: "user", content: "and now?" });
    });
  });

  it("binds a conversation to one client and agent", async () => {
    await withStore(async store => {
      store.bind("acme", "helper");
      store.bind("acme", "helper");
      expect(() => store.bind("acme", "third")).toThrow("another client or agent");
      expect(() => store.bind("other", "helper")).toThrow("another client or agent");
    });
  });
});

describe("per-client agent model and limits", () => {
  const acme = CLIENTS.find(client => client.id === "acme")!;
  const helper = { ...AGENTS.helper, tools: [] };

  it("resolves client, template, per-client agent and explicit limits in that order", () => {
    const configured = {
      ...acme,
      limits: { maxTurnSteps: 3, maxCostUsd: 1, modelTimeoutMs: 2_000, maxTurnActiveMs: 4_000 },
      agentLimits: { helper: { maxTurnSteps: 7, maxCostUsd: 10, maxJobCostUsd: 8, modelTimeoutMs: 420_000, maxTurnActiveMs: 780_000 } },
    };
    const template = { ...helper, limits: { maxTurnSteps: 5, modelTimeoutMs: 3_000 } };
    expect(limitsFor(configured, template)).toEqual({ maxTurnSteps: 7, maxCostUsd: 10, maxJobCostUsd: 8, modelTimeoutMs: 420_000, maxTurnActiveMs: 780_000 });
    expect(limitsFor(configured, template, true)).toEqual({ maxTurnSteps: 7, maxCostUsd: 10, maxJobCostUsd: 8, modelTimeoutMs: 3_000, maxTurnActiveMs: 4_000 });
    expect(limitsFor(configured, template, true, { maxCostUsd: null, modelTimeoutMs: 900, maxTurnActiveMs: 1_000 })).toMatchObject({ maxCostUsd: null, modelTimeoutMs: 900, maxTurnActiveMs: 1_000 });
    expect(limitsFor(acme, helper)).toMatchObject({ maxCostUsd: 10, maxJobCostUsd: 8, modelTimeoutMs: 420_000, maxTurnActiveMs: 780_000 });
    expect(limitsFor(acme, helper, true)).toMatchObject({ maxCostUsd: 10, modelTimeoutMs: 60_000, maxTurnActiveMs: 300_000 });
    expect(acme.dailyCostCapUsd).toBe(25);
    for (const client of CLIENTS) for (const id of client.agents.filter(id => id !== "helper")) {
      expect(limitsFor(client, AGENTS[id])).toEqual({ ...DEFAULT_LIMITS, ...client.limits, ...AGENTS[id].limits });
    }
  });

  it.each([false, true])("selects the provider, key and settled prices for voice=%s", async voice => {
    await withStore(async store => {
      const { model, requests } = scripted(reply("Hello."));
      const modelKey = vi.fn((name: string) => `key:${name}`);
      const configured = { ...acme, id: `routing-${crypto.randomUUID()}` };
      const result = await runTurn(deps(store, model, {}, { client: configured, agent: helper, voice, modelKey }).deps, { id: "m1", text: "Hello" });
      expect(result.status).toBe("replied");
      const request = requests[0];
      expect(request.config).toMatchObject(voice
        ? { model: "test-model", secretEnv: "OPENAI_API_KEY", inputCostPerMillion: 0.2, outputCostPerMillion: 1, extraBody: { service_tier: "priority" } }
        : { api: "claude", model: "claude-opus-5-5", secretEnv: "ANTHROPIC_API_KEY", inputCostPerMillion: 4, outputCostPerMillion: 20 });
      expect(request.apiKey).toBe(voice ? "key:OPENAI_API_KEY" : "key:ANTHROPIC_API_KEY");
      expect(modelKey).toHaveBeenCalledExactlyOnceWith(request.config.secretEnv);
      expect(store.spentUsd()).toBeCloseTo(voice ? 0.00003 : 0.0006, 9);
    });
  });

  it.each([false, true])("uses the selected context window and provider for compaction, voice=%s", async voice => {
    await withStore(async store => {
      store.append({ role: "user", content: "Earlier question." });
      const seq = store.append({ role: "assistant", content: "Earlier answer." });
      store.setMeta("promptSeq", String(seq));
      store.setMeta("promptTokens", "100000");
      const { model, requests } = scripted(...(voice ? [reply("The earlier exchange.")] : []), reply("Hello."));
      await runTurn(deps(store, model, {}, { client: { ...acme, id: `window-${crypto.randomUUID()}` }, agent: helper, voice }).deps, { id: "m1", text: "Hello" });
      expect(requests).toHaveLength(voice ? 2 : 1);
      expect(requests[0].messages[0].content === COMPACT_PROMPT).toBe(voice);
      expect(requests.every(request => request.config.model === (voice ? "test-model" : "claude-opus-5-5"))).toBe(true);
      expect(requests.every(request => request.apiKey === "key")).toBe(true);
    });
  });

  it.each([false, true])("keeps Helper's ten-dollar conversation cap on voice=%s", async voice => {
    await withStore(async store => {
      store.reserve("earlier-work", 0, 0, 3, Date.now());
      const { model, requests } = scripted(reply("Hello."));
      const d = deps(store, model, {}, { client: { ...acme, id: `chat-cap-${crypto.randomUUID()}` }, agent: helper, voice }).deps;
      expect((await runTurn(d, { id: "m1", text: "Hello" })).status).toBe("replied");
      store.reserve("rest-of-cap", 0, 0, 10 - store.spentUsd(), Date.now());
      expect((await runTurn(d, { id: "m2", text: "Again" })).status).toBe("stopped");
      expect(requests).toHaveLength(1);
    });
  });

  it.each([false, true])("bounds active work using off-call versus call timing, voice=%s", async voice => {
    await withStore(async store => {
      let elapsed = 0;
      const execute = vi.fn(async () => ({ data: {} }));
      const { model, requests } = scripted(() => {
        elapsed = 300_001;
        return reply("", [call("slow-step", "lookup")]);
      }, reply("Done."));
      const result = await runTurn(deps(store, model, { lookup: tool("lookup", { execute }) }, {
        client: { ...acme, id: `active-time-${crypto.randomUUID()}`, permissions: ["records.read"] },
        agent: { ...helper, tools: ["lookup"] }, voice, now: () => elapsed,
      }).deps, { id: "m1", text: "Look it up" });
      expect(result.status).toBe(voice ? "stopped" : "replied");
      expect(requests).toHaveLength(voice ? 1 : 2);
      expect(execute).toHaveBeenCalledTimes(voice ? 0 : 1);
    });
  });
});

describe("daily cap on a call", () => {
  /** A stand-in for the client's spend ledger whose answers the test controls (the real one answers at once). */
  function ledger(reserve: () => Promise<boolean>, settle: () => Promise<void> = async () => {}) {
    const namespace = { idFromName: (name: string) => env.USAGE.idFromName(name), get: () => ({ reserve, settle }) };
    return namespace as unknown as TurnDeps["bindings"]["USAGE"];
  }
  const heard = (events: TurnEvent[]) => events.flatMap(event => event.type === "text" ? [event.delta] : []).join("");
  /** Writes `text`, then is still busy until the loop cuts the request off. `written` resolves once it has written. */
  function cutOff(text: string, toolCalls: ToolCall[] = []) {
    let wrote = () => {};
    const state = { cut: false, written: new Promise<void>(resolve => { wrote = resolve; }) };
    const model: ModelAdapter = {
      async turn(request) {
        request.onText?.(text);
        const cut = new Promise<void>(resolve => request.signal?.addEventListener("abort", () => { state.cut = true; resolve(); }, { once: true }));
        wrote();
        await cut;
        return reply(text, toolCalls);
      },
    };
    return { model, state };
  }

  it("asks the model while the cap is still being checked, and holds its words until the cap allows them", async () => {
    await withStore(async store => {
      let allow = (_ok: boolean) => {};
      const answer = new Promise<boolean>(resolve => { allow = resolve; });
      let heardWhenWritten = "not written";
      const model: ModelAdapter = {
        async turn(request) {
          request.onText?.("Hello there. ");
          heardWhenWritten = heard(made.events);
          allow(true);
          return reply("Hello there. ");
        },
      };
      const made = deps(store, model, {}, { voice: true, bindings: { ...env, USAGE: ledger(() => answer) } });
      const result = await runTurn(made.deps, { id: "m1", text: "hi" });
      expect(heardWhenWritten).toBe("");
      expect(result.status).toBe("replied");
      expect(heard(made.events)).toContain("Hello there.");
    });
  });

  it("runs a lookup without waiting for the ledger to record the step before it, and ends once the ledger has every step", async () => {
    await withStore(async store => {
      let lookedUp = () => {};
      const afterLookup = new Promise<void>(resolve => { lookedUp = resolve; });
      let recorded = 0;
      // Recording a step finishes only after the lookup has run: a loop that waited for it first would never get there.
      const settle = async () => { await afterLookup; await new Promise(resolve => setTimeout(resolve, 20)); recorded++; };
      const lookup = tool("lookup", { async execute() { lookedUp(); return { data: { ok: true } }; } });
      let step = 0;
      // Spoken words reach a call through onText, as the real adapter sends them.
      const model: ModelAdapter = {
        async turn(request) {
          if (step++ === 0) return reply("", [call("a", "lookup")]);
          request.onText?.("It is done. ");
          return reply("It is done. ");
        },
      };
      const made = deps(store, model, { lookup }, { voice: true, bindings: { ...env, USAGE: ledger(async () => true, settle) } });
      const result = await runTurn(made.deps, { id: "m1", text: "look it up" });
      expect(result.status).toBe("replied");
      expect(recorded).toBe(2);
    });
  });

  it("says and runs nothing the model wrote when the cap refuses the call, and cuts the model off", async () => {
    await withStore(async store => {
      let ran = 0;
      const lookup = tool("lookup", { async execute() { ran++; return { data: {} }; } });
      const { model, state } = cutOff("Your balance is nine dollars. ", [call("a", "lookup")]);
      const made = deps(store, model, { lookup }, { voice: true, bindings: { ...env, USAGE: ledger(async () => false) } });
      const result = await runTurn(made.deps, { id: "m1", text: "hi" });
      expect(result.status).toBe("stopped");
      expect(heard(made.events)).toContain("usage limit");
      expect(heard(made.events)).not.toContain("balance");
      expect(ran).toBe(0);
      expect(state.cut).toBe(true);
    });
  });

  it("fails the turn and says nothing when the ledger cannot answer", async () => {
    await withStore(async store => {
      const { model, state } = cutOff("Your balance is nine dollars. ");
      const made = deps(store, model, {}, { voice: true, bindings: { ...env, USAGE: ledger(async () => { throw new Error("ledger down"); }) } });
      await expect(runTurn(made.deps, { id: "m1", text: "hi" })).rejects.toThrow("ledger down");
      expect(heard(made.events)).toBe("");
      expect(state.cut).toBe(true);
    });
  });

  it("records a call's real cost in the client's ledger, not the larger amount reserved for it", async () => {
    const callClient = { ...client, id: `cap-${crypto.randomUUID()}` };
    await withStore(async store => {
      const model: ModelAdapter = {
        async turn(request) {
          request.onText?.("Hello there. ");
          return reply("Hello there. ");
        },
      };
      await runTurn(deps(store, model, {}, { voice: true, client: callClient }).deps, { id: "m1", text: "hi" });
    });
    const spent = await env.USAGE.get(env.USAGE.idFromName(callClient.id)).spent(new Date().toISOString().slice(0, 10));
    // 100 input and 10 output tokens at $1 per million each; the reservation was for 1,000 output tokens.
    expect(spent).toBeCloseTo(0.00011, 8);
  });

  it("says nothing a stopped call wrote when the cap answers late, and records its cost only once the reservation is made", async () => {
    await withStore(async store => {
      let allow = (_ok: boolean) => {};
      const answer = new Promise<boolean>(resolve => { allow = resolve; });
      const ledgerSaw: string[] = [];
      const moved = new AbortController();
      const { model, state } = cutOff("Hello there. ");
      const made = deps(store, model, {}, { voice: true, overtaken: moved.signal, bindings: { ...env, USAGE: ledger(
        async () => { const ok = await answer; ledgerSaw.push("reserved"); return ok; },
        async () => { ledgerSaw.push("settled"); },
      ) } });
      const running = runTurn(made.deps, { id: "m1", text: "hi" });
      await state.written;
      // The caller speaks again while the cap is still being checked: the turn stops, and the cap's answer comes after that.
      moved.abort();
      await new Promise(resolve => setTimeout(resolve, 20));
      allow(true);
      expect((await running).status).toBe("stopped");
      expect(heard(made.events)).toBe("");
      expect(ledgerSaw).toEqual(["reserved", "settled"]);
    });
  });
});

describe("one retry before the model replies", () => {
  const answered = () => new Response(
    'data: {"choices":[{"index":0,"delta":{"content":"Answered."},"finish_reason":"stop"}]}\n\n'
    + 'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10}}\n\ndata: [DONE]\n\n',
    { headers: { "content-type": "text/event-stream" } },
  );
  const busy = (status = 503, retryAfter?: string) => new Response(null, {
    status, headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
  });
  const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
  const heard = (events: TurnEvent[]) => events.flatMap(event => event.type === "text" ? [event.delta] : []).join("");

  function fixture(store: Store, overrides: Partial<TurnDeps> = {}) {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const timers = vi.spyOn(globalThis, "setTimeout");
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Unscripted provider request"); });
    const reserve = vi.fn(async (_id: string, _day: string, _cost: number, _cap: number) => true);
    const settle = vi.fn(async (_id: string, _cost: number) => {});
    const localReserve = vi.spyOn(store, "reserve");
    const localSettle = vi.spyOn(store, "settle");
    const unresolved = vi.spyOn(store, "markUnresolved");
    const namespace = { idFromName: (name: string) => env.USAGE.idFromName(name), get: () => ({ reserve, settle }) };
    const made = deps(store, new CompatibleChatAdapter(), { lookup: tool("lookup") }, {
      bindings: { ...env, USAGE: namespace as unknown as TurnDeps["bindings"]["USAGE"] }, ...overrides,
    });
    const start = (text = "hi") => runTurn(made.deps, { id: "m1", text }).catch((error: unknown) => error);
    const booked = (phase: "settled" | "unresolved", cost?: number) => {
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(localReserve).toHaveBeenCalledTimes(1);
      expect(localSettle).toHaveBeenCalledTimes(phase === "settled" ? 1 : 0);
      expect(unresolved).toHaveBeenCalledTimes(phase === "unresolved" ? 1 : 0);
      expect(settle).toHaveBeenCalledTimes(phase === "settled" ? 1 : 0);
      if (phase === "settled") {
        const id = reserve.mock.calls[0][0];
        expect(localSettle.mock.calls[0][0]).toBe(id);
        expect(settle.mock.calls[0][0]).toBe(id);
        expect(store.spentUsd()).toBeCloseTo(cost ?? 0.00011, 8);
        expect(settle.mock.calls[0][1]).toBeCloseTo(cost ?? 0.00011, 8);
      }
      expect(vi.getTimerCount()).toBe(0);
    };
    return { ...made, fetch, reserve, settle, localReserve, localSettle, unresolved, timers, start, booked };
  }

  it("answers on the first try and settles one reservation with real usage", async () => {
    await withStore(async store => {
      const f = fixture(store);
      f.fetch.mockResolvedValueOnce(answered());
      expect(await f.start()).toMatchObject({ status: "replied", text: "Answered." });
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(heard(f.events)).toBe("Answered.");
      f.booked("settled");
    });
  });

  it("reserves input at its dearest price: a cache write costs more than plain input, and the cap must hold for it", async () => {
    const reserved = (model: Partial<typeof client.model>) => withStore(async store => {
      const f = fixture(store, { client: { ...client, model: { ...client.model, ...model } } });
      f.fetch.mockResolvedValueOnce(answered());
      await f.start();
      const cost = f.reserve.mock.calls[0][2];
      vi.useRealTimers();
      vi.restoreAllMocks();
      return cost;
    });
    // 1,000 output tokens at $1 per million are reserved either way; the rest is the input.
    const output = 0.001;
    const plain = await reserved({}), written = await reserved({ cacheWriteCostPerMillion: 3 }), cheaper = await reserved({ cacheWriteCostPerMillion: 0.5 });
    expect(plain - output).toBeGreaterThan(0);
    expect(written - output).toBeCloseTo(3 * (plain - output), 12);
    expect(cheaper).toBeCloseTo(plain, 12);
  });

  it.each([false, true])("enforces agent model timeouts off calls but shared timing on voice=%s", async voice => {
    await withStore(async store => {
      const f = fixture(store, {
        voice,
        client: { ...client, agentLimits: { helper: { modelTimeoutMs: 420_000, maxTurnActiveMs: 780_000 } } },
      });
      f.fetch.mockReturnValueOnce(new Promise<Response>(() => {}));
      const running = f.start();
      await flush();
      const timeout = voice ? 60_000 : 420_000;
      expect(f.timers).toHaveBeenCalledWith(expect.any(Function), timeout);
      await vi.advanceTimersByTimeAsync(timeout - 1);
      expect(f.unresolved).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await running).toMatchObject({ message: "The model took too long to answer." });
      expect(f.fetch).toHaveBeenCalledTimes(1);
      f.booked("unresolved");
    });
  });

  it.each([429, 500, 502, 503, 599])("busy HTTP %i then answered: resends the exact request once after 500 ms", async status => {
    await withStore(async store => {
      const f = fixture(store);
      f.fetch.mockResolvedValueOnce(busy(status)).mockResolvedValueOnce(answered());
      const running = f.start();
      await flush();
      expect(f.fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(499);
      expect(f.fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await running).toMatchObject({ status: "replied", text: "Answered." });
      expect(f.fetch).toHaveBeenCalledTimes(2);
      expect(f.fetch.mock.calls[1]).toEqual(f.fetch.mock.calls[0]);
      expect(heard(f.events)).toBe("Answered.");
      f.booked("settled");
    });
  });

  it("busy twice: shows the second error, marks once, and never tries a third time", async () => {
    await withStore(async store => {
      const f = fixture(store);
      f.fetch.mockResolvedValueOnce(busy(429)).mockResolvedValueOnce(busy(502));
      const running = f.start();
      await flush();
      await vi.advanceTimersByTimeAsync(500);
      expect(await running).toMatchObject({ status: 502, message: "Model provider returned HTTP 502." });
      expect(f.fetch).toHaveBeenCalledTimes(2);
      expect(heard(f.events)).toBe("");
      f.booked("unresolved");
    });
  });

  it("busy then 400: shows the second error and settles once at zero", async () => {
    await withStore(async store => {
      const f = fixture(store);
      f.fetch.mockResolvedValueOnce(busy()).mockResolvedValueOnce(busy(400));
      const running = f.start();
      await flush();
      await vi.advanceTimersByTimeAsync(500);
      expect(await running).toMatchObject({ status: 400 });
      expect(f.fetch).toHaveBeenCalledTimes(2);
      expect(heard(f.events)).toBe("");
      expect(f.localSettle).toHaveBeenCalledWith(expect.any(String), 0, 0, 0);
      f.booked("settled", 0);
    });
  });

  it("busy then overtaken during the wait: stops immediately, clears the wait and settles zero", async () => {
    await withStore(async store => {
      const moved = new AbortController();
      const f = fixture(store, { voice: true, overtaken: moved.signal });
      f.fetch.mockResolvedValueOnce(busy());
      const running = f.start();
      await flush();
      await vi.advanceTimersByTimeAsync(100);
      moved.abort();
      expect(await running).toMatchObject({ status: "stopped", text: "" });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(heard(f.events)).toBe("");
      f.booked("settled", 0);
    });
  });

  it("busy then timed out during the wait: sends no second request and settles zero", async () => {
    await withStore(async store => {
      const f = fixture(store, { limits: { modelTimeoutMs: 5_000 } });
      f.fetch.mockResolvedValueOnce(busy());
      const running = f.start();
      await flush();
      // A delayed event loop can deliver the deadline before the shorter wait callback.
      const timeout = f.timers.mock.calls.find(([, ms]) => ms === 5_000)?.[0];
      if (typeof timeout !== "function") throw new Error("Missing model deadline");
      timeout();
      expect(await running).toMatchObject({ message: "The model took too long to answer." });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(heard(f.events)).toBe("");
      f.booked("settled", 0);
    });
  });

  it("busy then overtaken during the second try: settles partial cost once and ignores its late answer", async () => {
    await withStore(async store => {
      const moved = new AbortController();
      const f = fixture(store, { voice: true, overtaken: moved.signal });
      let finish = (_response: Response) => {};
      const late = new Promise<Response>(resolve => { finish = resolve; });
      f.fetch.mockResolvedValueOnce(busy()).mockReturnValueOnce(late);
      const running = f.start();
      await flush();
      await vi.advanceTimersByTimeAsync(500);
      moved.abort();
      expect(await running).toMatchObject({ status: "stopped", text: "" });
      expect(f.fetch).toHaveBeenCalledTimes(2);
      expect(f.fetch.mock.calls[1][1]?.signal?.aborted).toBe(true);
      const cost = (f.localReserve.mock.calls[0][1] + 1_000) / 1_000_000;
      f.booked("settled", cost);
      finish(answered());
      await flush();
      expect(heard(f.events)).toBe("");
      f.booked("settled", cost);
    });
  });

  it("network error before a response then answered: retries and charges only the answer", async () => {
    await withStore(async store => {
      const f = fixture(store);
      f.fetch.mockRejectedValueOnce(new TypeError("connection reset")).mockResolvedValueOnce(answered());
      const running = f.start();
      await flush();
      await vi.advanceTimersByTimeAsync(500);
      expect(await running).toMatchObject({ status: "replied", text: "Answered." });
      expect(f.fetch).toHaveBeenCalledTimes(2);
      expect(heard(f.events)).toBe("Answered.");
      f.booked("settled");
    });
  });

  it("some output then a broken stream: never retries and keeps the original reservation", async () => {
    await withStore(async store => {
      const f = fixture(store);
      f.fetch.mockResolvedValueOnce(new Response(
        'data: {"choices":[{"index":0,"delta":{"content":"Started. "}}]}\n\ndata: {"error":{"message":"busy"}}\n\n',
      ));
      expect(await f.start()).toMatchObject({ message: "Model provider reported an error mid-stream." });
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(heard(f.events)).toBe("Started. ");
      f.booked("unresolved");
    });
  });

  it("daily cap refuses chat: sends no request and makes no local reservation", async () => {
    await withStore(async store => {
      const f = fixture(store);
      f.reserve.mockResolvedValueOnce(false);
      expect(await f.start()).toMatchObject({ status: "stopped", text: expect.stringContaining("usage limit") });
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.reserve).toHaveBeenCalledTimes(1);
      expect(f.localReserve).not.toHaveBeenCalled();
      expect(f.localSettle).not.toHaveBeenCalled();
      expect(f.unresolved).not.toHaveBeenCalled();
      expect(f.settle).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("voice busy waits for a pending cap and never retries after that cap refuses", async () => {
    await withStore(async store => {
      const f = fixture(store, { voice: true });
      let allow = (_ok: boolean) => {};
      f.reserve.mockReturnValueOnce(new Promise<boolean>(resolve => { allow = resolve; }));
      f.fetch.mockResolvedValueOnce(busy());
      const running = f.start();
      await flush();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(f.settle).not.toHaveBeenCalled();
      allow(false);
      expect(await running).toMatchObject({ status: "stopped", text: expect.stringContaining("usage limit") });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(f.reserve).toHaveBeenCalledTimes(1);
      expect(f.localSettle).toHaveBeenCalledWith(expect.any(String), 0, 0, 0);
      expect(f.settle).not.toHaveBeenCalled();
      expect(f.unresolved).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("voice busy waits for a pending cap, then retries using that one reservation", async () => {
    await withStore(async store => {
      const f = fixture(store, { voice: true });
      let allow = (_ok: boolean) => {};
      const ledgerSaw: string[] = [];
      f.reserve.mockImplementationOnce(async () => {
        const ok = await new Promise<boolean>(resolve => { allow = resolve; });
        ledgerSaw.push("reserved");
        return ok;
      });
      f.settle.mockImplementationOnce(async () => { ledgerSaw.push("settled"); });
      f.fetch.mockResolvedValueOnce(busy()).mockResolvedValueOnce(answered());
      const running = f.start();
      await flush();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(f.settle).not.toHaveBeenCalled();
      allow(true);
      await flush();
      await vi.advanceTimersByTimeAsync(500);
      expect(await running).toMatchObject({ status: "replied", text: "Answered." });
      expect(f.fetch).toHaveBeenCalledTimes(2);
      expect(ledgerSaw).toEqual(["reserved", "settled"]);
      expect(heard(f.events)).toBe("Answered.");
      f.booked("settled");
    });
  });

  it("a stopped voice retry waiting on the cap settles only after its pending reservation answers", async () => {
    await withStore(async store => {
      const moved = new AbortController();
      const f = fixture(store, { voice: true, overtaken: moved.signal });
      let allow = (_ok: boolean) => {};
      const ledgerSaw: string[] = [];
      f.reserve.mockImplementationOnce(async () => {
        const ok = await new Promise<boolean>(resolve => { allow = resolve; });
        ledgerSaw.push("reserved");
        return ok;
      });
      f.settle.mockImplementationOnce(async () => { ledgerSaw.push("settled"); });
      f.fetch.mockResolvedValueOnce(busy());
      const running = f.start();
      await flush();
      moved.abort();
      await flush();
      expect(f.settle).not.toHaveBeenCalled();
      allow(true);
      expect(await running).toMatchObject({ status: "stopped", text: "" });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(ledgerSaw).toEqual(["reserved", "settled"]);
      expect(heard(f.events)).toBe("");
      f.booked("settled", 0);
    });
  });

  it.each([400, 401, 403, 404, 408, 422, 499])("never retries non-busy HTTP %i", async status => {
    await withStore(async store => {
      const f = fixture(store);
      f.fetch.mockResolvedValueOnce(busy(status));
      expect(await f.start()).toMatchObject({ status });
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(heard(f.events)).toBe("");
      f.booked(status === 400 ? "settled" : "unresolved", 0);
    });
  });

  it.each([
    ["1", 1_000], ["2", 2_000], ["100", 500], ["nonsense", 500], ["-1", 500], ["", 500],
  ])("uses bounded Retry-After %s (%i ms)", async (header, wait) => {
    await withStore(async store => {
      const f = fixture(store);
      f.fetch.mockResolvedValueOnce(busy(429, header)).mockResolvedValueOnce(answered());
      const running = f.start();
      await flush();
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(f.fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await running).toMatchObject({ text: "Answered." });
      expect(f.fetch).toHaveBeenCalledTimes(2);
      f.booked("settled");
    });
  });

  it("honours Retry-After HTTP dates", async () => {
    await withStore(async store => {
      const f = fixture(store);
      vi.setSystemTime(new Date("2026-11-14T00:00:00Z"));
      f.fetch.mockResolvedValueOnce(busy(503, "Sat, 14 Nov 2026 00:00:01 GMT")).mockResolvedValueOnce(answered());
      const running = f.start();
      await flush();
      await vi.advanceTimersByTimeAsync(999);
      expect(f.fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await running).toMatchObject({ text: "Answered." });
      expect(f.fetch).toHaveBeenCalledTimes(2);
      f.booked("settled");
    });
  });

  it("does not retry when the normal time allowance cannot fit the wait and a useful attempt", async () => {
    await withStore(async store => {
      const f = fixture(store, { limits: { modelTimeoutMs: 1_499 } });
      f.fetch.mockResolvedValueOnce(busy());
      expect(await f.start()).toMatchObject({ status: 503 });
      expect(f.fetch).toHaveBeenCalledTimes(1);
      f.booked("unresolved");
    });
  });

  it("the second attempt has only the original deadline's remaining time, not a fresh timeout", async () => {
    await withStore(async store => {
      const f = fixture(store, { limits: { modelTimeoutMs: 5_000 } });
      let finish = (_response: Response) => {};
      f.fetch.mockResolvedValueOnce(busy()).mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }));
      const running = f.start();
      await flush();
      await vi.advanceTimersByTimeAsync(500);
      expect(f.fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(4_500);
      expect(await running).toMatchObject({ message: "The model took too long to answer." });
      expect(f.fetch.mock.calls[1][1]?.signal?.aborted).toBe(true);
      finish(answered());
      await flush();
      expect(heard(f.events)).toBe("");
      f.booked("unresolved");
    });
  });

  it("never retries its own first-attempt timeout, even if fetch ignores the abort", async () => {
    await withStore(async store => {
      const f = fixture(store, { limits: { modelTimeoutMs: 5_000 } });
      let fail = (_error: Error) => {};
      f.fetch.mockReturnValueOnce(new Promise<Response>((_resolve, reject) => { fail = reject; }));
      const running = f.start();
      await flush();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await running).toMatchObject({ message: "The model took too long to answer." });
      fail(new TypeError("connection reset"));
      await flush();
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(heard(f.events)).toBe("");
      f.booked("unresolved");
    });
  });

  it("does not retry a tool call that has started arriving, even if an adapter then reports busy", async () => {
    await withStore(async store => {
      const f = fixture(store, { model: {
        async turn(request) {
          request.onToolCall?.("lookup");
          throw new ModelProtocolError("Model provider returned HTTP 503.", 503);
        },
      } });
      const turn = vi.spyOn(f.deps.model, "turn");
      expect(await f.start()).toMatchObject({ status: 503 });
      expect(turn).toHaveBeenCalledTimes(1);
      expect(f.fetch).not.toHaveBeenCalled();
      expect(store.actions()).toEqual([]);
      f.booked("unresolved");
    });
  });

  it("shows a second network failure as the original error, without a third attempt", async () => {
    await withStore(async store => {
      const f = fixture(store);
      const last = new TypeError("second connection failed");
      f.fetch.mockResolvedValueOnce(busy()).mockRejectedValueOnce(last);
      const running = f.start();
      await flush();
      await vi.advanceTimersByTimeAsync(500);
      expect(await running).toBe(last);
      expect(f.fetch).toHaveBeenCalledTimes(2);
      f.booked("unresolved");
    });
  });

  it("does not retry a conversation-cost refusal or ask the daily ledger", async () => {
    await withStore(async store => {
      store.reserve("old", 0, 0, 2, 0);
      const f = fixture(store, { limits: { maxCostUsd: 2 } });
      expect(await f.start()).toMatchObject({ status: "stopped", text: expect.stringContaining("cost limit") });
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.reserve).not.toHaveBeenCalled();
      expect(f.localReserve).not.toHaveBeenCalled();
      expect(f.localSettle).not.toHaveBeenCalled();
      expect(f.unresolved).not.toHaveBeenCalled();
      expect(f.settle).not.toHaveBeenCalled();
      expect(store.spentUsd()).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("remains silent when overtaken while the first busy try awaits a cap that later refuses", async () => {
    await withStore(async store => {
      const moved = new AbortController();
      const f = fixture(store, { voice: true, overtaken: moved.signal });
      let allow = (_ok: boolean) => {};
      f.reserve.mockReturnValueOnce(new Promise<boolean>(resolve => { allow = resolve; }));
      f.fetch.mockResolvedValueOnce(busy());
      const running = f.start();
      await flush();
      moved.abort();
      await flush();
      allow(false);
      expect(await running).toMatchObject({ status: "stopped", text: "" });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(f.reserve).toHaveBeenCalledTimes(1);
      expect(f.localReserve).toHaveBeenCalledTimes(1);
      expect(f.localSettle).toHaveBeenCalledExactlyOnceWith(expect.any(String), 0, 0, 0);
      expect(f.settle).not.toHaveBeenCalled();
      expect(f.unresolved).not.toHaveBeenCalled();
      expect(heard(f.events)).toBe("");
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("uses the shorter remaining turn allowance for both attempts", async () => {
    await withStore(async store => {
      const f = fixture(store, { limits: { modelTimeoutMs: 60_000, maxTurnActiveMs: 1_499 } });
      f.fetch.mockResolvedValueOnce(busy());
      expect(await f.start()).toMatchObject({ status: 503 });
      expect(f.fetch).toHaveBeenCalledTimes(1);
      f.booked("unresolved");
    });
  });

  it("keeps the same attached image, messages and tools on the second provider request", async () => {
    await withStore(async store => {
      const key = `${client.id}/chat-uploads/1234567890123456-retry.png`;
      await env.MEDIA.put(key, new Uint8Array(10), { httpMetadata: { contentType: "image/png" } });
      const url = `${MEDIA_PUBLIC_BASE}/${key}`;
      const f = fixture(store, { client: { ...client, model: { ...client.model, images: true } } });
      let requested = () => {};
      const firstRequest = new Promise<void>(resolve => { requested = resolve; });
      f.fetch.mockImplementationOnce(async () => { requested(); return busy(); }).mockResolvedValueOnce(answered());
      const running = f.start(`Look\n\nAttached files:\n#1: ${url} (image/png, 800×600, retry.png)`);
      await firstRequest;
      await flush();
      await vi.advanceTimersByTimeAsync(500);
      expect(await running).toMatchObject({ status: "replied", text: "Answered." });
      expect(f.fetch).toHaveBeenCalledTimes(2);
      expect(f.fetch.mock.calls[1]).toEqual(f.fetch.mock.calls[0]);
      expect(String(f.fetch.mock.calls[0][1]?.body)).toContain(`"image_url":{"url":"${url}"}`);
      f.booked("settled");
    });
  });

  it("does not retry text that has arrived, even if an adapter then reports busy", async () => {
    await withStore(async store => {
      const f = fixture(store, { model: {
        async turn(request) {
          request.onText?.("Started. ");
          throw new ModelProtocolError("Model provider returned HTTP 503.", 503);
        },
      } });
      const turn = vi.spyOn(f.deps.model, "turn");
      expect(await f.start()).toMatchObject({ status: 503 });
      expect(turn).toHaveBeenCalledTimes(1);
      expect(heard(f.events)).toBe("Started. ");
      expect(f.fetch).not.toHaveBeenCalled();
      f.booked("unresolved");
    });
  });

  it.each(["100", "Sat, 14 Nov 2026 00:01:40 GMT"])("falls back to 500 ms for long Retry-After %s when only that wait fits", async header => {
    await withStore(async store => {
      const f = fixture(store, { limits: { modelTimeoutMs: 1_800 } });
      vi.setSystemTime(new Date("2026-11-14T00:00:00Z"));
      f.fetch.mockResolvedValueOnce(busy(429, header)).mockResolvedValueOnce(answered());
      const running = f.start();
      await flush();
      await vi.advanceTimersByTimeAsync(499);
      expect(f.fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await running).toMatchObject({ status: "replied", text: "Answered." });
      expect(f.fetch).toHaveBeenCalledTimes(2);
      f.booked("settled");
    });
  });

  it.each([3_501, 5_001])("rechecks the deadline when the wait fires first after a %i ms clock delay", async delay => {
    await withStore(async store => {
      const f = fixture(store, { limits: { modelTimeoutMs: 5_000 } });
      f.fetch.mockResolvedValueOnce(busy(503));
      const running = f.start();
      await flush();
      vi.setSystemTime(Date.now() + delay);
      // The wait callback runs first; the deadline callback has not run, despite the clock jump.
      await vi.advanceTimersByTimeAsync(500);
      expect(await running).toMatchObject({ status: 503, message: "Model provider returned HTTP 503." });
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(f.fetch.mock.calls[0][1]?.signal?.aborted).toBe(false);
      expect(heard(f.events)).toBe("");
      f.booked("settled", 0);
    });
  });

  it("never retries output from callback-free compaction or emits it outward", async () => {
    await withStore(async store => {
      store.append({ role: "user", content: "Earlier question." });
      const seq = store.append({ role: "assistant", content: "Earlier answer." });
      store.setMeta("promptTokens", "9000");
      store.setMeta("promptSeq", String(seq));
      const f = fixture(store, {
        client: { ...client, model: { ...client.model, contextWindowTokens: 10_000, maxOutputTokens: 500 } },
        model: {
          async turn(request) {
            expect(request.tools).toEqual([]);
            request.onText?.("Summary started. ");
            throw new ModelProtocolError("Model provider returned HTTP 503.", 503);
          },
        },
      });
      const turn = vi.spyOn(f.deps.model, "turn");
      expect(await f.start()).toMatchObject({ status: 503 });
      expect(turn).toHaveBeenCalledTimes(1);
      expect(f.fetch).not.toHaveBeenCalled();
      expect(heard(f.events)).toBe("");
      f.booked("unresolved");
    });
  });

  it("busy then image 400 still retries without images, reserving and settling once per budgeted call", async () => {
    await withStore(async store => {
      const key = `${client.id}/chat-uploads/1234567890123456-image-refused.png`;
      await env.MEDIA.put(key, new Uint8Array(10), { httpMetadata: { contentType: "image/png" } });
      const url = `${MEDIA_PUBLIC_BASE}/${key}`;
      const f = fixture(store, { client: { ...client, model: { ...client.model, images: true } } });
      let requested = () => {};
      const firstRequest = new Promise<void>(resolve => { requested = resolve; });
      f.fetch.mockImplementationOnce(async () => { requested(); return busy(503); })
        .mockResolvedValueOnce(busy(400)).mockResolvedValueOnce(answered());
      const running = f.start(`Look\n\nAttached files:\n#1: ${url} (image/png, 800×600, retry.png)`);
      await firstRequest;
      await flush();
      await vi.advanceTimersByTimeAsync(500);
      expect(await running).toMatchObject({ status: "replied", text: "Answered." });
      expect(f.fetch).toHaveBeenCalledTimes(3);
      expect(f.fetch.mock.calls[1]).toEqual(f.fetch.mock.calls[0]);
      expect(String(f.fetch.mock.calls[0][1]?.body)).toContain(`"image_url":{"url":"${url}"}`);
      expect(String(f.fetch.mock.calls[2][1]?.body)).not.toContain('"image_url"');
      expect(f.reserve).toHaveBeenCalledTimes(2);
      expect(f.localReserve).toHaveBeenCalledTimes(2);
      expect(f.localSettle).toHaveBeenCalledTimes(2);
      expect(f.settle).toHaveBeenCalledTimes(2);
      expect(f.unresolved).not.toHaveBeenCalled();
      const first = f.reserve.mock.calls[0][0];
      const second = f.reserve.mock.calls[1][0];
      expect(second).not.toBe(first);
      expect(f.localReserve.mock.calls.map(([id]) => id)).toEqual([first, second]);
      expect(f.localSettle).toHaveBeenNthCalledWith(1, first, 0, 0, 0);
      expect(f.localSettle).toHaveBeenNthCalledWith(2, second, 100, 10, 0.00011);
      expect(f.settle).toHaveBeenNthCalledWith(1, first, 0);
      expect(f.settle).toHaveBeenNthCalledWith(2, second, 0.00011);
      expect(store.spentUsd()).toBeCloseTo(0.00011, 8);
      expect(heard(f.events)).toBe("Answered.");
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe("Claude's usage and kept thinking in the spend limits", () => {
  const sse = (...events: object[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  const begun = { type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1 } } };
  /** `usage` null: the reply never says where its count ended. */
  const ended = (stop_reason: string, usage: object | null = { output_tokens: 10 }) =>
    [{ type: "message_delta", delta: { stop_reason }, ...(usage ? { usage } : {}) }, { type: "message_stop" }];
  const says = (text: string) => [
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
  ];
  /** Claude thinks (a signature of `thinking` bytes) and asks for the lookup. */
  const thinks = (thinking: number) => sse(
    begun,
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "s".repeat(thinking) } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "lookup", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } },
    { type: "content_block_stop", index: 1 },
    ...ended("tool_use"),
  );
  /** A client of its own (so a daily ledger of its own) on Claude: $1 input, $1.25 cache writes and `output` dollars per million tokens, 1,000 output tokens at most. */
  const claude = (maxCostUsd: number, output = 1): ClientConfig => ({
    ...client, id: `claude-${crypto.randomUUID()}`, limits: { maxCostUsd },
    model: { ...client.model, api: "claude", cacheReadCostPerMillion: 0.1, cacheWriteCostPerMillion: 1.25, outputCostPerMillion: output },
  });

  /** One turn through the real adapters: Claude thinks and asks for a lookup, then answers. */
  async function round(store: Store, thinking: number, maxCostUsd: number) {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Unscripted provider request"); });
    fetch.mockResolvedValueOnce(thinks(thinking)).mockResolvedValueOnce(sse(begun, ...says("Done."), ...ended("end_turn")));
    const reserved = vi.spyOn(store, "reserve");
    const model = new ProviderAdapter();
    const asked = vi.spyOn(model, "turn");
    const made = deps(store, model, { lookup: tool("lookup") }, { client: claude(maxCostUsd) });
    const result = await runTurn(made.deps, { id: "m1", text: "Look it up." }).catch((error: unknown) => error);
    return { result, fetch, reserved, asked };
  }

  it("reserves the thinking it is about to send back, at the price of writing it to the cache again", async () => {
    await withStore(async store => {
      const { result, fetch, reserved, asked } = await round(store, 40_000, 5);
      expect(result).toMatchObject({ status: "replied", text: "Done." });
      expect(reserved).toHaveBeenCalledTimes(2);
      // The first request has nothing of Claude's to send back.
      const first = asked.mock.calls[0][0];
      expect(reserved.mock.calls[0][1]).toBe(requestInputEstimate(first.messages, first.tools));
      // The second carries the reply as Claude wrote it: its bytes, as sent, are counted on top of the saved messages.
      const sent = JSON.parse(String(fetch.mock.calls[1][1]?.body)) as { messages: { role: string; content: unknown }[] };
      const kept = new TextEncoder().encode(JSON.stringify(sent.messages.find(message => message.role === "assistant")!.content)).length;
      expect(kept).toBeGreaterThan(40_000);
      const second = asked.mock.calls[1][0];
      const [, inputTokens, outputTokens, cost] = reserved.mock.calls[1];
      expect(inputTokens).toBe(requestInputEstimate(second.messages, second.tools) + kept);
      expect(outputTokens).toBe(1000);
      // $1.25 a million, as if the cache had expired and none of it were read back at $0.10.
      expect(cost).toBeCloseTo((inputTokens * 1.25 + 1000) / 1_000_000, 12);
    });
  });

  it("stops at the cost limit before the provider is asked when the thinking to send back no longer fits it", async () => {
    await withStore(async store => {
      // 400,000 bytes of kept thinking at $1.25 a million are $0.50: more than the $0.25 this conversation may spend.
      const { result, fetch, reserved } = await round(store, 400_000, 0.25);
      expect(result).toMatchObject({ status: "stopped", text: expect.stringContaining("cost limit") });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(reserved).toHaveBeenCalledTimes(1);
      // Only the first request was paid for: 100 input and 10 output tokens at $1 a million.
      expect(store.spentUsd()).toBeCloseTo(0.00011, 9);
    });
  });

  it("the same round with little to send back goes through under the same limit", async () => {
    await withStore(async store => {
      const { result, fetch } = await round(store, 10, 0.25);
      expect(result).toMatchObject({ status: "replied", text: "Done." });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(store.spentUsd()).toBeCloseTo(0.00022, 9);
    });
  });

  it.each([
    { limit: 0.5, usage: { output_tokens: 200 }, outcome: "the cost-limit stop, settled on what it used" },
    { limit: 0.5, usage: null, outcome: "the cost-limit stop, its reservation kept" },
    { limit: 0.5, usage: { output_tokens: -200 }, outcome: "the cost-limit stop, its reservation kept" },
    { limit: 5, usage: { output_tokens: 200 }, outcome: "a cut-off reply, settled on what it used" },
    { limit: 5, usage: null, outcome: "a cut-off reply, its reservation kept" },
    { limit: 5, usage: { output_tokens: -200 }, outcome: "a cut-off reply, its reservation kept" },
  ])("a reply cut off with a cost limit of $limit dollars and a final count of $usage is $outcome", async ({ limit, usage }) => {
    await withStore(async store => {
      const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(sse(begun, ...says("Half an ans"), ...ended("max_tokens", usage)));
      const reserved = vi.spyOn(store, "reserve"), settled = vi.spyOn(store, "settle"), unresolved = vi.spyOn(store, "markUnresolved");
      // Output at $1,000 a million: the model's own 1,000 tokens are $1, so $0.50 to spend shrinks the window and $5 does not.
      const result = await runTurn(deps(store, new ProviderAdapter(), {}, { client: claude(limit, 1000) }).deps, { id: "m1", text: "hi" }).catch((error: unknown) => error);
      expect(fetch).toHaveBeenCalledTimes(1);
      const squeezed = limit < 1;
      const window = (JSON.parse(String(fetch.mock.calls[0][1]?.body)) as { max_tokens: number }).max_tokens;
      expect(window).toBeGreaterThan(200);
      expect(window < 1000).toBe(squeezed);
      // Cut short by the allowance, the turn ends as the spending stop; by the model's own limit, as the cut-off it is.
      if (squeezed) expect(result).toMatchObject({ status: "stopped", text: expect.stringContaining("cost limit") });
      else expect(result).toMatchObject({ message: "The model reply was cut off by its output limit." });
      const [id, , , reservedCost] = reserved.mock.calls[0];
      if (usage?.output_tokens === 200) {
        // 100 input tokens at $1 and 200 output tokens at $1,000, per million.
        expect(settled).toHaveBeenCalledTimes(1);
        expect(settled.mock.calls[0].slice(0, 3)).toEqual([id, 100, 200]);
        expect(unresolved).not.toHaveBeenCalled();
        expect(store.spentUsd()).toBeCloseTo(0.2001, 9);
      } else {
        // Billed, for an amount nobody can say: never settled as free or as less than nothing, the whole reservation keeps counting.
        expect(settled).not.toHaveBeenCalled();
        expect(unresolved).toHaveBeenCalledWith(id);
        expect(reservedCost).toBeGreaterThan(0.2);
        expect(store.spentUsd()).toBeCloseTo(reservedCost, 9);
      }
    });
  });

  it("a finished reply that never says where its count ended fails the turn and keeps its reservation", async () => {
    await withStore(async store => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(sse(begun, ...says("Done."), ...ended("end_turn", null)));
      const reserved = vi.spyOn(store, "reserve"), settled = vi.spyOn(store, "settle");
      const result = await runTurn(deps(store, new ProviderAdapter(), {}, { client: claude(5) }).deps, { id: "m1", text: "hi" }).catch((error: unknown) => error);
      expect(result).toMatchObject({ message: "Model provider did not report usage." });
      expect(settled).not.toHaveBeenCalled();
      expect(store.spentUsd()).toBeCloseTo(reserved.mock.calls[0][3], 9);
      expect(store.spentUsd()).toBeGreaterThan(0.001);
    });
  });
});
