import { testDesk } from "./desk";
import { toolBindings } from "../src/bindings";
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Schedule, ToolContext, ToolDefinition, ToolResult } from "../src/contracts";
import type { ModelAdapter } from "../src/model";
import { latestDue, nextDue, validateSchedule, zonedInstant } from "../src/schedule";
import { Store } from "../src/store";
import { postCard, updateCard } from "../src/tools";
import { signUserPass } from "../src/user-auth";
import { TOOLS } from "../tools";

const weekdays7: Schedule = { id: "t", agent: "second", days: [1, 2, 3, 4, 5], time: "07:00", timezone: "America/Chicago", task: "x" };
const runtimeScheduler = scheduler;

describe("schedule times", () => {
  it("keeps 07:00 Chicago local across daylight saving", () => {
    expect(new Date(zonedInstant("America/Chicago", 2026, 7, 15, 7, 0)).toISOString()).toBe("2026-07-15T12:00:00.000Z");
    expect(new Date(zonedInstant("America/Chicago", 2026, 12, 15, 7, 0)).toISOString()).toBe("2026-12-15T13:00:00.000Z");
    // Day after the fall-back change (Sunday 1 November 2026).
    expect(new Date(zonedInstant("America/Chicago", 2026, 11, 2, 7, 0)).toISOString()).toBe("2026-11-02T13:00:00.000Z");
  });

  it("finds the latest and next weekday runs", () => {
    const saturdayNoonChicago = Date.parse("2026-11-07T18:00:00Z");
    expect(latestDue(weekdays7, saturdayNoonChicago)).toEqual({ runKey: "2026-11-06", at: Date.parse("2026-11-06T13:00:00Z") });
    expect(nextDue(weekdays7, saturdayNoonChicago)).toEqual({ runKey: "2026-11-09", at: Date.parse("2026-11-09T13:00:00Z") });
  });

  it("runs a monthly schedule on its day of the month, in local time", () => {
    const monthly: Schedule = { id: "m", agent: "third", monthDays: [1], time: "08:00", timezone: "America/Chicago", task: "x" };
    // 31 Oct 2026 late evening in Chicago is already 1 Nov in UTC: the run is still 1 Nov 08:00 Chicago.
    const oct31EveningChicago = Date.parse("2026-11-01T03:00:00Z");
    expect(latestDue(monthly, oct31EveningChicago)).toBeUndefined();
    expect(nextDue(monthly, oct31EveningChicago)).toEqual({ runKey: "2026-11-01", at: Date.parse("2026-11-01T14:00:00Z") });
    expect(latestDue(monthly, Date.parse("2026-11-05T12:00:00Z"))).toEqual({ runKey: "2026-11-01", at: Date.parse("2026-11-01T14:00:00Z") });
    // Mid-month the next run is still found, so the scheduler can set its alarm: 1 Dec 08:00 Chicago (UTC-6).
    expect(nextDue(monthly, Date.parse("2026-11-12T12:00:00Z"))).toEqual({ runKey: "2026-12-01", at: Date.parse("2026-12-01T14:00:00Z") });
  });

  it("refuses schedules that could skip a month or mix both kinds of day", () => {
    expect(() => validateSchedule({ ...weekdays7, days: undefined, monthDays: [31] })).toThrow("monthDays must be 1-28");
    expect(() => validateSchedule({ ...weekdays7, monthDays: [1] })).toThrow("either days or monthDays");
    expect(() => validateSchedule({ ...weekdays7, days: undefined })).toThrow("either days or monthDays");
  });
});

describe("scheduler", () => {
  beforeEach(() => {
    // A scheduled run reaches outside only through its tools; a direct fetch is a bug.
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => { throw new Error(`Unexpected fetch: ${String(input)}`); });
    vi.spyOn(runtimeScheduler, "wait").mockResolvedValue(undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); });
  // Acme Test Co's real schedule: weekdays 07:00 America/Chicago. Each test uses its own day, so its own job conversation.
  const at0701 = (day: string) => Date.parse(`${day}T13:01:00Z`);
  const usage = { inputTokens: 5, outputTokens: 2 };
  const postCardCall = (id: string) => ({ id, type: "function" as const, function: { name: "post_card", arguments: JSON.stringify({ kind: "report", title: "Daily ads check", summary: "Nothing connected yet." }) } });

  async function withModel(runKey: string, model: ModelAdapter) {
    const name = `acme/second/job-second-daily-ads-${runKey}`;
    await runInDurableObject(env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(name)), instance => { instance.model = model; });
  }
  async function acmeCards() {
    return (JSON.parse(await env.DASHBOARD.get(env.DASHBOARD.idFromName("acme")).list(100)) as { cards: { id: string; conversationId: string; kind: string }[] }).cards;
  }
  function scheduler() {
    return env.SCHEDULER.get(env.SCHEDULER.newUniqueId());
  }
  async function runAttempts(day: string, times: number) {
    const stub = scheduler();
    await stub.ensure("acme");
    for (let i = 0; i < times; i++) await stub.runDue(at0701(day) + i * 300_000);
    return stub.runs();
  }

  it("is done once its card is posted, and never runs again that day", async () => {
    let calls = 0;
    let firstMessage = "";
    await withModel("2026-11-09", {
      async turn(request) {
        calls++;
        firstMessage ||= String(request.messages.find(m => m.role === "user")?.content);
        expect(request.tools.map(t => t.name)).not.toContain("remember");
        return calls === 1 ? { content: "", toolCalls: [postCardCall("card-mon")], usage } : { content: "Posted.", toolCalls: [], usage };
      },
    });
    expect((await runAttempts("2026-11-09", 2)).sort((a, b) => a.scheduleId.localeCompare(b.scheduleId))).toEqual([
      { scheduleId: "second-daily-ads", runKey: "2026-11-09", status: "done", attempts: 1 },
    ]);
    expect(calls).toBe(2);
    expect(firstMessage).toContain("Daily ads check");
    expect(firstMessage).toContain("No person is present");
    expect((await acmeCards()).filter(c => c.conversationId === "job-second-daily-ads-2026-11-09").map(c => c.id)).toEqual(["card-mon"]);
    expect(fetch).not.toHaveBeenCalled(); // The run used only its model and tools.
  });

  it("retries a run that replied without posting a card, then posts its own failure card", async () => {
    let calls = 0;
    await withModel("2026-11-11", { async turn() { calls++; return { content: "All done!", toolCalls: [], usage }; } });
    expect(await runAttempts("2026-11-11", 4)).toEqual([{ scheduleId: "second-daily-ads", runKey: "2026-11-11", status: "failed", attempts: 3 }]);
    expect(calls).toBe(3); // each attempt really ran
    const failure = (await acmeCards()).find(c => c.id === "second-daily-ads@2026-11-11-failed");
    expect(failure).toMatchObject({ kind: "alert" });
  });

  it("does not count a run stopped by its step limit as done", async () => {
    let n = 0;
    await withModel("2026-11-12", {
      async turn() { n++; return { content: "", toolCalls: [{ id: `t${n}`, type: "function", function: { name: "current_time", arguments: "{\"timezone\":\"America/Chicago\"}" } }], usage }; },
    });
    const [run] = await runAttempts("2026-11-12", 1);
    expect(run).toMatchObject({ status: "retry", attempts: 1 });
  });

  it("counts a run done once its card is posted, even when the agent's last reply comes back empty", async () => {
    let calls = 0;
    // Its own weekday, so no other test shares this day's job conversation.
    await withModel("2026-11-17", {
      async turn() { calls++; return calls === 1 ? { content: "", toolCalls: [postCardCall("card-tue")], usage } : { content: "", toolCalls: [], usage }; },
    });
    expect(await runAttempts("2026-11-17", 2)).toEqual([{ scheduleId: "second-daily-ads", runKey: "2026-11-17", status: "done", attempts: 1 }]);
    expect(calls).toBe(2);
  });

  it("does not count a run whose only card is an alert (say, an output rule held its reply back) as done", async () => {
    // The run's conversation already holds an alert and no report; the agent then replies without posting one.
    await env.DASHBOARD.get(env.DASHBOARD.idFromName("acme")).post({
      id: "alert-rule-2026-11-18", agent: "second", kind: "alert", title: "Reply held back by an output rule", summary: "x", dataJson: "{}", conversationId: "job-second-daily-ads-2026-11-18",
    });
    await withModel("2026-11-18", { async turn() { return { content: "All done!", toolCalls: [], usage }; } });
    const [run] = await runAttempts("2026-11-18", 1);
    expect(run).toMatchObject({ status: "retry", attempts: 1 });
  });

  it("retries a job whose model fails, then gives up after three attempts", async () => {
    await withModel("2026-11-10", { async turn() { throw new Error("provider down"); } });
    expect(await runAttempts("2026-11-10", 4)).toEqual([{ scheduleId: "second-daily-ads", runKey: "2026-11-10", status: "failed", attempts: 3 }]);
  });

  it("sends every attempt of a run under one trusted request: the reviewed task alone, without the preamble", async () => {
    await withModel("2026-11-19", { async turn() { return { content: "All done!", toolCalls: [], usage }; } });
    expect((await runAttempts("2026-11-19", 2)).find(entry => entry.scheduleId === "second-daily-ads")).toMatchObject({ runKey: "2026-11-19", attempts: 2 });
    const run = "second-daily-ads@2026-11-19";
    const saved = await runInDurableObject(env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName("acme/second/job-second-daily-ads-2026-11-19")), (_instance, state) => {
      const store = new Store(state.storage);
      return { attempts: [1, 2].map(attempt => store.meta(`input-request-${run}#${attempt}`)), request: JSON.parse(store.meta(`user-request-${run}`) ?? "null") };
    });
    // What the Scheduler itself sent: without its `request`, each attempt would be its own request (`<run>#<attempt>`).
    expect(saved.attempts).toEqual([run, run]);
    expect(saved.request).toMatchObject({ id: run });
    expect(saved.request.text).not.toContain("Scheduled job");
  });

  it("labels a proposal from the Scheduler as scheduled with no requester", async () => {
    const day = "2026-11-20";
    const id = "scheduled-origin-proposal";
    let step = 0;
    await withModel(day, { async turn() {
      return step++ === 0
        ? { content: "", toolCalls: [{ id, type: "function", function: { name: "approve_record", arguments: "{}" } }], usage }
        : { content: "Waiting for approval.", toolCalls: [], usage };
    } });
    await runInDurableObject(env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`acme/second/job-second-daily-ads-${day}`)), instance => {
      const tool: ToolDefinition = {
        name: "approve_record", description: "Scheduled fixture.", permission: "dashboard.write", effect: "write", parallelSafe: false, timeoutMs: 5_000,
        parameters: { type: "object", properties: {}, additionalProperties: false },
        approval: () => ({ title: "Scheduled request", summary: "A scheduled fixture." }),
        execute: async () => { throw new Error("Must not execute without approval."); },
      };
      instance.catalog = { ...TOOLS, approve_record: tool };
    });
    await runAttempts(day, 1);
    expect(JSON.parse((await env.DASHBOARD.get(env.DASHBOARD.idFromName("acme")).approvalJson(id))!)).toMatchObject({ requestedBy: null, source: "scheduled", status: "pending" });
  });

  it("keeps a failure card owed when posting it fails, and posts it on a later alarm, even the next day", async () => {
    await withModel("2026-11-13", { async turn() { return { content: "done", toolCalls: [], usage }; } });
    const stub = scheduler();
    await stub.ensure("acme");
    // The dashboard write fails during the last attempt.
    await runInDurableObject(stub, instance => { Object.assign(instance, { reportFailure: async () => { throw new Error("dashboard down"); } }); });
    for (let i = 0; i < 3; i++) await stub.runDue(at0701("2026-11-13") + i * 300_000);
    expect(await stub.runs()).toEqual([{ scheduleId: "second-daily-ads", runKey: "2026-11-13", status: "notify", attempts: 3 }]);
    expect((await acmeCards()).some(c => c.id === "second-daily-ads@2026-11-13-failed")).toBe(false);

    // The dashboard is back; a later alarm (here Saturday, outside the run's own window) posts the owed card.
    await runInDurableObject(stub, instance => { delete (instance as unknown as Record<string, unknown>).reportFailure; });
    await stub.runDue(Date.parse("2026-11-14T15:00:00Z"));
    expect(await stub.runs()).toEqual([{ scheduleId: "second-daily-ads", runKey: "2026-11-13", status: "failed", attempts: 3 }]);
    expect((await acmeCards()).some(c => c.id === "second-daily-ads@2026-11-13-failed")).toBe(true);
  });

  it("skips a run missed by more than 12 hours", async () => {
    const stub = scheduler();
    await stub.ensure("acme");
    await stub.runDue(Date.parse("2026-11-10T12:00:00Z")); // over 12 hours after every Monday run (the last is Helper's 17:00), before Tuesday's first
    expect(await stub.runs()).toEqual([]);
  });
});

describe("dashboard cards", () => {
  function context(overrides: Partial<ToolContext> = {}): ToolContext {
    const results: Record<string, ToolResult> = { "ads-1": { data: { google: { connected: true, yesterday: { spend: 12.5 } } } } };
    return {
      clientId: "card-test", agentId: "second", conversationId: "c1", actionId: crypto.randomUUID(),
      signal: new AbortController().signal, bindings: toolBindings(env),
      actionResult: id => results[id], brokenRule: () => undefined, reserveSpend: async () => true, settings: {}, ...testDesk({ agentId: "second", secrets: {} }), ...overrides,
    };
  }
  const cards = async (clientId: string) => (JSON.parse(await env.DASHBOARD.get(env.DASHBOARD.idFromName(clientId)).list(10)) as { cards: Record<string, unknown>[] }).cards;

  it("attaches the cited tool results, not model-written numbers, and posts once per action", async () => {
    const ctx = context();
    const args = { kind: "report", title: "Daily ads check", summary: "Spend 12.5 yesterday.", sourceActionIds: ["ads-1"] };
    await postCard.execute(ctx, args);
    await postCard.execute(ctx, args);
    const [card, ...rest] = await cards("card-test");
    expect(rest).toEqual([]);
    expect(card).toMatchObject({ id: ctx.actionId, agent: "second", data: { "ads-1": { google: { connected: true, yesterday: { spend: 12.5 } } } } });
    expect(await postCard.reconcile!(ctx, args)).toMatchObject({ status: "succeeded" });
  });

  it("rejects citations of calls that did not succeed, and edits by other agents", async () => {
    await expect(postCard.execute(context({ clientId: "card-test-2" }), { kind: "report", title: "x y z", summary: "abc", sourceActionIds: ["made-up"] }))
      .rejects.toMatchObject({ definite: true });
    const ctx = context({ clientId: "card-test-2" });
    await postCard.execute(ctx, { kind: "status", title: "Campaign check", summary: "Waiting" });
    await expect(updateCard.execute(context({ clientId: "card-test-2", agentId: "third" }), { cardId: ctx.actionId, summary: "hijacked" })).rejects.toThrow();
    await updateCard.execute(context({ clientId: "card-test-2" }), { cardId: ctx.actionId, summary: "Done" });
    expect((await cards("card-test-2"))[0]).toMatchObject({ summary: "Done", title: "Campaign check" });
  });
});

describe("dashboard access", () => {
  const key = "test-dashboard-key-acme-0123456789abcdef";
  const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

  it("serves the page, and its data only with a dashboard pass for that client", async () => {
    const page = await SELF.fetch("https://brain/dashboard/acme");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");

    const get = async (pass: string, client = "acme") =>
      (await SELF.fetch(`https://brain/v1/clients/${client}/dashboard`, { headers: { "x-dashboard-pass": pass } })).status;
    expect(await get(await signUserPass(key, "acme", "staff-1", inAnHour(), "dashboard"))).toBe(200);
    // A memory pass signed with the same key is not a dashboard pass.
    expect(await get(await signUserPass(key, "acme", "staff-1", inAnHour()))).toBe(401);
    expect(await get(await signUserPass("x".repeat(40), "acme", "staff-1", inAnHour(), "dashboard"))).toBe(401);
    expect(await get(await signUserPass(key, "other", "staff-1", inAnHour(), "dashboard"))).toBe(401);
    expect(await get("nonsense")).toBe(401);
  });

  it("is also readable with the client token", async () => {
    const response = await SELF.fetch("https://brain/v1/dashboard", { headers: { authorization: "Bearer test-token-acme-0123456789abcdef" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("cards");
  });
});

