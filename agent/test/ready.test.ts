import { createExecutionContext, env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { acme } from "./fixtures/demo";
import type { AgentTemplate, ClientConfig, ToolContext, TurnEvent } from "../src/contracts";
import { runTurn, type TurnDeps } from "../src/loop";
import type { ModelAdapter, ModelTurnReply } from "../src/model";
import { brokenRule, compileRules, SentenceGate } from "../src/rules";
import { Store } from "../src/store";
import { noDesk } from "./desk";
import { imageTool, postCard } from "../src/tools";

const acmeRules = compileRules(acme.outputRules!);

describe("Acme Test Co output rules", () => {
  const blocked = [
    "We guarantee you'll see more leads.",
    "I promise this campaign will work.",
    "The setup fee is $500.",
    "That would cost you about $1,200 a month.",
    "Your new site will be live by Friday.",
    "We'll have it done by next week.",
    "You'll rank #1 for bakery Denver.",
    "You will appear on the first page within a month.",
    "We charge $99 a month.",
    "Your website will be $2,000.",
    "That'll only be $99.",
    "Our hourly rate is $120.",
    "It will be ready by September 3rd.",
    "Septic pumping prices start at $300.",
  ];
  const allowed = [
    "I can't guarantee results, but here is what usually helps.",
    "We cannot guarantee rankings.",
    "Yesterday's spend was $12.50 with 40 clicks.",
    "Cost per conversion was $4.20 over the last 7 days.",
    "A person from the team will confirm pricing and timing.",
    "Google decides rankings; we can improve your chances.",
    // Second's ordinary ad reporting: ad spend and Google's charges are not our prices.
    "The search term roof repair quotes cost $45 with no leads.",
    "Your click-through rate was 3% and clicks cost $2 each.",
    "The new campaign will be $50 a day and is created paused.",
    "Google can charge up to $100 on a single day.",
    "Google doesn’t guarantee your ad will show.",
    // Words that only start like a month ("sep", "dec") are not dates.
    "The work is done by septic specialists.",
    "The job was done by decent contractors.",
  ];
  it.each(blocked)("blocks: %s", text => expect(brokenRule(text, acmeRules)).toBeDefined());
  it.each(allowed)("allows: %s", text => expect(brokenRule(text, acmeRules)).toBeUndefined());
});

describe("sentence gate", () => {
  it("passes checked sentences and holds back the first one that breaks a rule", () => {
    const out: string[] = [];
    const gate = new SentenceGate(acmeRules, d => out.push(d));
    for (const chunk of ["Happy to ", "help. We guar", "antee page one. More text."]) gate.push(chunk);
    gate.finish();
    expect(out.join("")).toBe("Happy to help. ");
    expect(gate.violation?.id).toBe("no-guarantees");
  });

  it("streams straight through when there are no rules", () => {
    const out: string[] = [];
    const gate = new SentenceGate([], d => out.push(d));
    gate.push("Half a sent");
    expect(out).toEqual(["Half a sent"]);
  });
});

const usage = { inputTokens: 10, outputTokens: 5 };
const agent: AgentTemplate = { id: "helper", name: "Helper", role: "test", prompt: "You help.", tools: [] };
function client(overrides: Partial<ClientConfig> = {}): ClientConfig {
  return {
    id: `ready-${crypto.randomUUID()}`, name: "Test Co", tokenEnv: "CLIENT_TOKEN_TEST", agents: ["helper"], permissions: [],
    model: { baseURL: "https://model.invalid", model: "fake", secretEnv: "DEEPSEEK_API_KEY", inputCostPerMillion: 1, outputCostPerMillion: 1, maxOutputTokens: 1000, contextWindowTokens: 100_000 },
    outputRules: acme.outputRules, ...overrides,
  };
}
/** A model that streams each scripted reply through onText, like the real adapter. */
function streaming(...texts: string[]) {
  const calls: string[][] = [];
  const model: ModelAdapter = {
    async turn(request) {
      calls.push(request.messages.map(m => String(m.content ?? "")));
      const text = texts.shift() ?? "";
      for (const word of text.split(/(?<= )/)) request.onText?.(word);
      return { content: text, toolCalls: [], usage } satisfies ModelTurnReply;
    },
  };
  return { model, calls };
}
async function run(model: ModelAdapter, c: ClientConfig, text = "hi") {
  const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.newUniqueId());
  return runInDurableObject(stub, async (_i, state) => {
    const events: TurnEvent[] = [];
    const deps: TurnDeps = { store: new Store(state.storage), model, client: c, agent, catalog: {}, conversationId: "c1", bindings: env, desk: noDesk, modelKey: () => "key", emit: e => events.push(e) };
    const result = await runTurn(deps, { id: "m1", text });
    const seen = events.flatMap(e => e.type === "text" ? [e.delta] : []).join("");
    return { result, seen };
  });
}
async function cards(clientId: string) {
  return (JSON.parse(await env.DASHBOARD.get(env.DASHBOARD.idFromName(clientId)).list(20)) as { cards: { id: string; kind: string }[] }).cards;
}

describe("output rules in the loop", () => {
  it("never shows the broken sentence, and the agent continues from what the user saw", async () => {
    const { model, calls } = streaming("Happy to help. We guarantee page one. ", "A person will confirm what results to expect.");
    const { result, seen } = await run(model, client());
    expect(seen).toBe("Happy to help. A person will confirm what results to expect.");
    expect(seen).not.toMatch(/guarantee/i);
    expect(result).toEqual({ status: "replied", text: seen });
    expect(calls[1].at(-1)).toContain("Never guarantee or promise results");
  });

  it("sends a safe fallback and raises an alert when the agent keeps breaking a rule", async () => {
    const c = client();
    const { model } = streaming("We guarantee it.", "I guarantee it.", "Guaranteed results.");
    const { result, seen } = await run(model, c);
    expect(result.status).toBe("stopped");
    expect(seen).not.toMatch(/guarantee/i);
    expect(seen).toContain("someone from the team");
    expect((await cards(c.id)).map(card => card.kind)).toEqual(["alert"]);
  });

  it("refuses a dashboard card that breaks a rule", async () => {
    const context = { brokenRule: (text: string) => brokenRule(text, acmeRules)?.message } as unknown as ToolContext;
    await expect(postCard.execute(context, { kind: "report", title: "Plan", summary: "We guarantee 50 leads." })).rejects.toMatchObject({ definite: true });
  });
});

describe("daily spend cap", () => {
  it("stops before calling the model once the client's day is spent, and raises one alert", async () => {
    const c = client({ dailyCostCapUsd: 0.0001, outputRules: [] });
    const { model, calls } = streaming("never sent");
    const first = await run(model, c);
    const second = await run(model, c);
    expect(calls).toHaveLength(0);
    expect(first.result.status).toBe("stopped");
    expect(first.seen).toContain("usage limit");
    expect(second.result.status).toBe("stopped");
    expect((await cards(c.id)).map(card => card.kind)).toEqual(["alert"]);
  });

  it("counts paid image drafts against the same daily cap and refuses one that would pass it", async () => {
    const c = client({ dailyCostCapUsd: 0.3, outputRules: [], permissions: ["images.create"] });
    let generated = 0;
    const image = imageTool(async () => { generated++; return new Uint8Array([1]); });
    const results: string[] = [];
    for (const n of [1, 2]) {
      let step = 0;
      const model: ModelAdapter = {
        async turn(request) {
          if (step++ === 0) return { content: "", toolCalls: [{ id: `img-${c.id}-${n}`, type: "function", function: { name: "generate_image", arguments: JSON.stringify({ prompt: "a bakery storefront at dawn" }) } }], usage };
          results.push(String(request.messages.at(-1)?.content));
          return { content: "ok", toolCalls: [], usage };
        },
      };
      const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.newUniqueId());
      await runInDurableObject(stub, (_i, state) => runTurn({
        store: new Store(state.storage), model, client: c, agent: { ...agent, tools: ["generate_image"] }, catalog: { generate_image: image },
        conversationId: `c${n}`, bindings: env, desk: noDesk, modelKey: () => "key", emit: () => {},
      }, { id: "m1", text: "make an image" }));
    }
    expect(generated).toBe(1); // $0.25 fits under $0.30; a second $0.25 does not
    expect(results[0]).toContain("draft");
    expect(results[1]).toContain("usage limit");
  });

  it("counts spend across conversations of the same client", async () => {
    const c = client({ dailyCostCapUsd: 0.05, outputRules: [] });
    const ledger = env.USAGE.get(env.USAGE.idFromName(c.id));
    const day = new Date().toISOString().slice(0, 10);
    expect(await ledger.reserve("a", day, 0.03, 0.05)).toBe(true);
    expect(await ledger.reserve("b", day, 0.03, 0.05)).toBe(false);
    await ledger.settle("a", 0.01);
    expect(await ledger.reserve("b", day, 0.03, 0.05)).toBe(true);
  });
});

describe("rate limit", () => {
  const request = (token = "test-token-acme-0123456789abcdef") =>
    new Request("https://brain/v1/dashboard", { headers: { authorization: `Bearer ${token}` } });
  // Miniflare's limiter uses wall-clock minute windows in a separate Durable Object.
  // A 65-request loop can span two windows. Production is also approximate, not a
  // strict global cap: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/#accuracy
  // Drive the actual route with explicit provider decisions instead of counting a timed burst.
  const bindings = (limit: RateLimit["limit"]) => ({
    ...env, CLIENT_LIMITER: { limit }, MEDIA_LIMITER: env.CLIENT_LIMITER,
    LEADS_LIMITER: env.CLIENT_LIMITER, LEAD_INTAKE_LIMITER: env.CLIENT_LIMITER,
  });

  it("allows an authenticated request through the real Worker and native limiter", async () => {
    expect((await SELF.fetch(request())).status).toBe(200);
  });

  it("returns 429 when the limiter refuses, without reading dashboard data", async () => {
    const limit = vi.fn<RateLimit["limit"]>().mockResolvedValue({ success: false });
    const get = vi.fn(() => { throw new Error("A refused request must not read dashboard data"); });
    const dashboard = new Proxy(env.DASHBOARD, { get(target, key, receiver) {
      if (key === "get") return get;
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const response = await worker.fetch(request(), {
      ...bindings(limit), DASHBOARD: dashboard,
    }, createExecutionContext());
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "Too many requests" });
    expect(limit).toHaveBeenCalledExactlyOnceWith({ key: "acme" });
    expect(get).not.toHaveBeenCalled();
  });

  it("keys decisions by authenticated client and does not spend allowance on bad credentials", async () => {
    const limit = vi.fn<RateLimit["limit"]>().mockImplementation(async ({ key }) => ({ success: key === "kestrel" }));
    const bound = bindings(limit);
    expect((await worker.fetch(request(), bound, createExecutionContext())).status).toBe(429);
    expect((await worker.fetch(request("test-token-kestrel-0123456789abcdef"), bound, createExecutionContext())).status).toBe(200);
    expect((await worker.fetch(request("invalid"), bound, createExecutionContext())).status).toBe(401);
    expect(limit.mock.calls).toEqual([[{ key: "acme" }], [{ key: "kestrel" }]]);
  });
});
