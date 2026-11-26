// Synthetic test-only clients and agents for the shared platform tests. Never deployed: the production build has only
// clients/kestrel. Imported by test/fixtures/setup.ts (the test runner) and test/fixtures/iris/desk.ts (the desk Worker).
import { AGENTS, EDITABLE, SETUP } from "../../agents";
import { CLIENTS, compose } from "../../clients";
import type { AgentTemplate, ClientConfig, EditableSetting, SetupItem, ToolDefinition } from "../../src/contracts";
import { ToolError } from "../../src/errors";
import { LEADS_TOOL } from "../../src/lead-routes";
import { MEDIA_TOOL } from "../../src/media";
import { TOOLS } from "../../tools";
import type { OutputRule } from "../../src/rules";

const SHARED_TOOLS = ["my_setup", "current_time", "propose_change", "start_in_background", "remember", "recall", "forget", "web_search", "read_page", "post_card", "update_card",
  "update_progress", "check_back_in", "learn_lesson", "learned_lessons", "forget_lesson", "lesson_propose", "lesson_search", "eyes"];

/** Where the checked-create test tool keeps its claim on a name. */
export const recordKey = (clientId: string, kind: string, name: string) => `records/${clientId}/${kind}/${name}.json`;

/**
 * A write that cannot be reconciled: an interrupted call stays uncertain until a person checks it. Its claim on the name
 * is kept in R2, and a person's "not created" check clears only this action's pending claim (checkedRetry).
 */
export const createRecord: ToolDefinition = {
  name: "create_record", label: "Creating the record", description: "Create a named record.",
  permission: "dashboard.write", effect: "write", parallelSafe: false, timeoutMs: 5_000,
  parameters: { type: "object", properties: { name: { type: "string" }, directionApprovalId: { type: "string" } }, required: ["name"], additionalProperties: false },
  checkedRetry: {
    label: args => `Create the record "${args.name}"`,
    async clear(context, args) {
      const key = recordKey(context.clientId, "projects", String(args.name));
      const record = await (await context.bindings.IMAGES.get(key))?.json<{ pending: boolean; actionId: string }>();
      if (record && !record.pending) throw new ToolError(`Cannot clear: "${args.name}" is recorded as created. A person must check it.`, true);
      if (record && record.actionId !== context.actionId) return;
      await context.bindings.IMAGES.put(key, JSON.stringify({ ...(record ?? { repo: args.name, actionId: context.actionId, createdAt: new Date().toISOString() }), pending: true, checkedAt: Date.now() }));
    },
  },
  async execute(context, args) {
    const key = recordKey(context.clientId, "projects", String(args.name));
    await context.bindings.IMAGES.put(key, JSON.stringify({ repo: args.name, actionId: context.actionId, pending: false, createdAt: new Date().toISOString() }));
    return { data: { created: true } };
  },
};

/** A write that waits for a person's approval and then does nothing outside: for approval and job-resume checks. */
export const approveRecord: ToolDefinition = {
  name: "approve_record", label: "Filing the record for approval", description: "Propose a record for a person to approve.",
  permission: "dashboard.write", effect: "write", parallelSafe: false, timeoutMs: 5_000,
  parameters: { type: "object", properties: {}, additionalProperties: true },
  approval: () => ({ title: "Approve the record", summary: "A record for a person to approve." }),
  async execute() { return { data: { done: true } }; },
};

/**
 * Markers for the two platform features an agent opts into by listing a tool: changing leads (LEADS_TOOL, an agent that builds
 * sites) and deleting media folders (MEDIA_TOOL, an agent that uses the library). No agent in this build lists them.
 */
const marker = (name: string, description: string): ToolDefinition => ({
  name, label: description, description, permission: "dashboard.write", effect: "read", parallelSafe: true, timeoutMs: 5_000,
  parameters: { type: "object", properties: {}, additionalProperties: false }, async execute() { return { data: {} }; },
});
export const markers = [marker(LEADS_TOOL, "Marking a site-building agent"), marker(MEDIA_TOOL, "Marking a media library agent")];

/** A general helper agent, standing in for a client's main agent. */
export const helper: AgentTemplate = {
  id: "helper", name: "Helper", role: "Test assistant",
  prompt: "You are Helper, a test assistant. Answer briefly and use your tools when asked.",
  tools: [...SHARED_TOOLS, "create_record", "approve_record", LEADS_TOOL, MEDIA_TOOL],
};

/** A second agent of the same clients, for checks that one agent's access never covers another. */
export const second: AgentTemplate = {
  id: "second", name: "Second", role: "Second test assistant",
  prompt: "You are Second, another test assistant.",
  tools: [...SHARED_TOOLS, "generate_image", "approve_record"],
};

/** A third agent, for checks across three agents of one client and between the two clients. */
export const third: AgentTemplate = {
  id: "third", name: "Third", role: "Third test assistant",
  prompt: "You are Third, another test assistant.",
  tools: SHARED_TOOLS,
};

/** What staff may edit for the third agent, and what it needs before it is useful: for the settings and setup panels. */
export const thirdEditable: EditableSetting[] = [
  { key: "site", label: "Site URL", type: "url", help: "The client's public site, e.g. https://www.example.com." },
  { key: "competitors", label: "Competitors", type: "list", help: "Competitor domains." },
  { key: "blogsPerMonth", label: "Blogs per month", type: "number", min: 0, max: 30, help: "How many new posts a month." },
  { key: "publishStatus", label: "Publish status", type: "choice", choices: ["draft", "publish"], help: "Whether new posts go live after approval." },
];
export function thirdSetup({ settings, has }: { settings: Record<string, unknown>; has(name: string): boolean }): SetupItem[] {
  const site = typeof settings.site === "string" && settings.site.startsWith("https://");
  return [
    { id: "site", label: "Site URL", kind: "setting", connected: site, missing: site ? [] : ["site"], unlocks: "Page checks on the client's own site." },
    { id: "search", label: "Search data", kind: "secret", connected: has("THIRD_SEARCH_KEY"), missing: has("THIRD_SEARCH_KEY") ? [] : ["THIRD_SEARCH_KEY"], unlocks: "Search figures for the site." },
  ];
}

const RULES: OutputRule[] = [
  { id: "no-guarantees", pattern: "(?<!\\b(?:can['’]t|cannot|can not|won['’]t|will not|don['’]t|do not|doesn['’]t|does not|didn['’]t|did not|isn['’]t|is not|aren['’]t|are not|not|no|never)\\s+(?:\\w+\\s+){0,2})\\bguarantee(?:d|s)?\\b|\\b(?:I|we)\\s+promise\\b", message: "Never guarantee or promise results, outcomes or performance." },
  { id: "no-price-quotes", pattern: "\\b(?:price|fee|retainer)s?\\b[^.!?\\n]{0,40}\\$\\s?\\d|\\b(?:we|I)\\s+(?:charge|quote|bill)\\b[^.!?\\n]{0,40}\\$\\s?\\d|\\b(?:our|my)\\s+(?:\\w+\\s+)?rates?\\b[^.!?\\n]{0,40}\\$\\s?\\d|(?:\\bwill|\\bwould|['’]ll)\\s+(?:only\\s+|just\\s+)?(?:cost|be|run)\\s+(?:you\\s+)?(?:about\\s+|around\\s+|roughly\\s+)?\\$\\s?\\d[\\d,.]*(?![\\d,.])(?!\\s*(?:a|per|\\/)\\s*day\\b|\\s+daily\\b)|\\b(?:costs?|run)\\s+you\\s+(?:about\\s+|around\\s+|roughly\\s+)?\\$\\s?\\d", message: "Never quote a price, fee or cost for our services; a person from the team handles pricing." },
  { id: "no-delivery-dates", pattern: "\\b(?:will be|it'll be|we'll have it|we will have it|ready|done|delivered|live|launched|finished)\\b[^.!?\\n]{0,30}\\b(?:by|on)\\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|next week|end of (?:the )?(?:day|week|month)|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b|\\d{1,2}(?:st|nd|rd|th)\\b)", message: "Never promise a delivery or launch date; say a person will confirm timing." },
  { id: "no-ranking-promises", pattern: "\\b(?:you'll|you will|will|we'll|we will)\\s+(?:rank|be ranked|appear|show up)\\s+(?:#\\s?1|number one|first|on (?:the )?first page|on page (?:one|1)|at the top)", message: "Never promise search rankings or positions." },
];

const model = (images: boolean) => ({
  baseURL: "https://api.openai.com/v1", model: "test-model", secretEnv: "OPENAI_API_KEY", inputCostPerMillion: 0.1, outputCostPerMillion: 0.5,
  maxOutputTokens: 32000, maxTokensParam: "max_completion_tokens" as const, contextWindowTokens: 128000, ...(images ? { images: true } : {}),
  extraBody: { reasoning_effort: "none" }, voice: { extraBody: { service_tier: "priority" }, inputCostPerMillion: 0.2, outputCostPerMillion: 1 },
});

const PERMISSIONS = ["time.read", "web.read", "memory.write", "setup.read", "jobs.run"];
const agentFile = { permissions: ["dashboard.write"], schedules: [], settings: {} };
/** The main agent's own budget: a job may spend $8, a conversation $10. */
const helperFile = { ...agentFile, limits: { maxJobCostUsd: 8, maxCostUsd: 10, modelTimeoutMs: 420000, maxTurnActiveMs: 780000 },
  // Its own staff model (Claude), while calls keep the client's voice model.
  model: { api: "claude" as const, baseURL: "https://api.anthropic.com/v1", model: "claude-opus-5-5", secretEnv: "ANTHROPIC_API_KEY", inputCostPerMillion: 4, outputCostPerMillion: 20,
    cacheReadCostPerMillion: 0.2, cacheWriteCostPerMillion: 5, maxOutputTokens: 64000, contextWindowTokens: 300000, images: true, extraBody: { output_config: { effort: "medium" } } } };
const images = { id: "openai_images", access: "write" as const, hosts: ["api.openai.com"], auth: { type: "bearer" as const, secret: "OPENAI_DESK_API_KEY" }, writes: [{ method: "POST", path: "/v1/images/generations" }] };
const slack = [
  { id: "slack", access: "write" as const, hosts: ["slack.com", "files.slack.com"], auth: { type: "bearer" as const, secret: "BEACON_SLACK_BOT_TOKEN" },
    gets: [{ method: "GET", path: "/api/conversations.history" }, { method: "GET", path: "/api/conversations.replies" }, { method: "GET", path: "/api/files.info" }, { method: "GET", path: "/api/users.info" }, { method: "GET", path: "/files-pri/**" }] },
  { id: "slack_reply", access: "write" as const, hosts: ["slack.com"], auth: { type: "bearer" as const, secret: "BEACON_SLACK_BOT_TOKEN" }, gets: [],
    writes: [{ method: "POST", path: "/api/chat.postMessage" }, { method: "POST", path: "/api/reactions.add", body: { name: "eyes" } }] },
];

/** A client with output rules, a second agent and an image connection. */
export const acme: ClientConfig = compose({
  id: "acme", name: "Acme Test Co", tokenEnv: "CLIENT_TOKEN_ACME", userSigningEnv: "USER_SIGNING_KEY_ACME",
  dashboardSigningEnv: "DASHBOARD_SIGNING_KEY_ACME", approverSigningEnv: "APPROVER_SIGNING_KEY_ACME", accessSigningEnv: "ACCESS_SIGNING_KEY_ACME",
  dailyCostCapUsd: 25, outputRules: RULES, agents: ["helper", "second", "third"], permissions: PERMISSIONS, model: model(true),
  callTestModels: {
    "gpt-4.1": { baseURL: "https://api.openai.com/v1", model: "gpt-4.1", secretEnv: "OPENAI_API_KEY", inputCostPerMillion: 2, outputCostPerMillion: 8, cacheReadCostPerMillion: 0.5, maxOutputTokens: 32000, maxTokensParam: "max_completion_tokens", contextWindowTokens: 128000 },
    "gpt-4.1-mini": { baseURL: "https://api.openai.com/v1", model: "gpt-4.1-mini", secretEnv: "OPENAI_API_KEY", inputCostPerMillion: 0.4, outputCostPerMillion: 1.6, cacheReadCostPerMillion: 0.1, maxOutputTokens: 32000, maxTokensParam: "max_completion_tokens", contextWindowTokens: 128000 },
  },
}, {
  helper: helperFile,
  second: { ...agentFile, permissions: ["images.create", "dashboard.write"], connections: [images], schedules: [{
    id: "second-daily-ads", agent: "second", days: [1, 2, 3, 4, 5], time: "07:00", timezone: "America/Chicago",
    task: "Daily check: call post_card once with kind \"report\" and the title \"Daily ads check\", in 3-5 short lines. Use only numbers from tool results.",
  }] },
  third: agentFile,
});

/** A client with static approvers, a Slack team and approved phone callers. */
export const beacon: ClientConfig = compose({
  id: "beacon", name: "Beacon Studio", tokenEnv: "CLIENT_TOKEN_BEACON", userSigningEnv: "USER_SIGNING_KEY_BEACON",
  dashboardSigningEnv: "DASHBOARD_SIGNING_KEY_BEACON", approverSigningEnv: "APPROVER_SIGNING_KEY_BEACON", accessSigningEnv: "ACCESS_SIGNING_KEY_BEACON",
  approvers: ["jess", "alex", "robin"], dailyCostCapUsd: 5,
  slack: { signingSecretEnv: "BEACON_SLACK_SIGNING_SECRET", agent: "helper", channel: "C0TEST00001", people: [
    { id: "jess", name: "Jess", email: "jess@beacon.example" },
    { id: "alex", name: "Alex", email: "alex@beacon.example" },
    { id: "robin", name: "Robin", email: "robin@beacon.example" },
  ] },
  phone: { callersEnv: "BEACON_PHONE_CALLERS", spokenApprovalAgent: "helper" },
  agents: ["helper", "third"], permissions: PERMISSIONS, model: model(false),
}, { helper: { ...agentFile, connections: slack }, third: { ...agentFile, settings: { site: "", competitors: [], blogsPerMonth: 4, publishStatus: "draft" } } });

/** Registers the synthetic agents and clients once per module registry. */
export function registerDemo(): void {
  TOOLS[createRecord.name] ??= createRecord;
  TOOLS[approveRecord.name] ??= approveRecord;
  for (const tool of markers) TOOLS[tool.name] ??= tool;
  for (const agent of [helper, second, third]) {
    if (AGENTS[agent.id]) continue;
    AGENTS[agent.id] = agent;
    EDITABLE[agent.id] = agent === third ? thirdEditable : [];
    SETUP[agent.id] = agent === third ? thirdSetup : () => [];
  }
  for (const client of [acme, beacon]) if (!CLIENTS.some(existing => existing.id === client.id)) CLIENTS.push(client);
}
registerDemo();
