import { AGENT_TOOLS, SETUP } from "../agents";
import { CLIENTS } from "../clients";
import type { JobProgress, JsonObject, ToolDefinition } from "../src/contracts";
import { ToolError } from "../src/errors";
import { BACKGROUND_TOOL, CHECK_BACK_MAX_SECONDS, CHECK_BACK_MIN_SECONDS, PROPOSE_TOOL } from "../src/jobs";
import { isReady } from "../src/setup";
import { currentTime, forget, imageTool, postCard, readPage, recall, remember, updateCard, webSearch } from "../src/tools";

// The tool catalog: shared tools plus every agent's own tools (agents/<id>/index.ts).
// Add HTTP or MCP tools with `httpTool({...})` / `mcpTool({...})` from src/tools.ts.
// Mark `parallelSafe: true` only after checking the tool has no rate-limit or ordering concerns.

/** What the calling agent has connected for this client: the same list the dashboard's Setup panel shows. Names only, never values. */
export const mySetup: ToolDefinition = {
  name: "my_setup",
  label: "Checking what is connected",
  description: "Your own setup for this client: which accounts and settings are connected, what is missing (by name) and what each unlocks. Call it before saying you are set up, connected or ready.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  permission: "setup.read",
  effect: "read",
  parallelSafe: true,
  timeoutMs: 2_000,
  async execute(context) {
    const has = (name: string) => context.hasSecret(name);
    // The same connections the dashboard's setup route passes, so an agent that names its credentials by connection agrees with it.
    const connections = CLIENTS.find(client => client.id === context.clientId)?.connections?.filter(connection => connection.agents.includes(context.agentId));
    const items = SETUP[context.agentId]?.({ clientId: context.clientId, settings: context.settings, has, connections }) ?? [];
    return { data: { ready: isReady(items), items: items.map(({ id, label, connected, missing, unlocks, optional }) => ({ id, label, connected, missing, unlocks, ...(optional ? { optional } : {}) })) } };
  },
};

/** Job-only: never offered on a call, where there is nothing to show progress in (the model still called it, an extra step each time). */
export const updateProgress: ToolDefinition = {
  name: "update_progress",
  notOnCalls: true,
  label: "Updating progress",
  description: "Show the person how the job is going, in plain words (no tool names, no code). Call it first in every job with `steps`: 3 to 7 short steps in the order you will do them. Call it again with `done` (how many steps are finished) and, when it helps, `current` (what you are doing now) as the work moves on.",
  parameters: {
    type: "object",
    properties: {
      steps: { type: "array", items: { type: "string", minLength: 1, maxLength: 120 }, minItems: 1, maxItems: 12 },
      done: { type: "integer", minimum: 0, maximum: 12 },
      current: { type: "string", maxLength: 120 },
    },
    additionalProperties: false,
  },
  permission: "jobs.run",
  effect: "read",
  parallelSafe: true,
  timeoutMs: 2_000,
  async execute(context, args) {
    context.job?.update(args as JobProgress);
    return { data: { saved: context.job !== undefined } };
  },
};

export const checkBackIn: ToolDefinition = {
  name: "check_back_in",
  notOnCalls: true,
  label: "Waiting a little",
  description: `End this part of the job and come back after \`seconds\` (${CHECK_BACK_MIN_SECONDS} to ${CHECK_BACK_MAX_SECONDS}), when something you started needs time (a build, a deployment, DNS). The job resumes with a note saying why. Use it instead of replying while work is still running; reply normally only when the job is finished, or needs the person.`,
  parameters: {
    type: "object",
    properties: {
      seconds: { type: "integer", minimum: CHECK_BACK_MIN_SECONDS, maximum: CHECK_BACK_MAX_SECONDS },
      reason: { type: "string", minLength: 1, maxLength: 200, description: "What you will check when you come back" },
    },
    required: ["seconds", "reason"],
    additionalProperties: false,
  },
  permission: "jobs.run",
  effect: "read",
  parallelSafe: true,
  timeoutMs: 2_000,
  async execute(context, args) {
    if (!context.job) throw new ToolError("There is no background job here to wait in. Tell the person what to check and when.", true);
    context.job.checkBack(Number(args.seconds), String(args.reason));
    return { data: { scheduled: true, instruction: `This part of the job ends now; it resumes in ${args.seconds} seconds.` } };
  },
};

/** Phone calls only: the call does not wait for the work. Runs only the change the caller confirmed (see propose_change); the loop supplies its task. */
export const startInBackground: ToolDefinition = {
  name: BACKGROUND_TOOL,
  label: "Starting the work",
  description: "On a call: start the change the caller just confirmed, as read back with propose_change, as a background job (in its own conversation, so the call stays free), and carry on talking. Takes no arguments: it runs exactly what was read back, and only after the caller's plain yes to that read-back. The job starts after your reply to the caller; then tell them it is started and will be done in a couple of minutes.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  permission: "jobs.run",
  effect: "read",
  parallelSafe: false,
  voiceOnly: true,
  timeoutMs: 2_000,
  async execute(context, args) {
    if (!context.startInBackground) throw new ToolError("There is no call to hand work over from here.", true);
    context.startInBackground(String(args.task));
    return { data: { started: true, instruction: "The job starts right after your reply. Tell the caller it is started and will be done in a couple of minutes." } };
  },
};

/** Phone calls only: records exactly what will be read back; start_in_background and the approval tools run only this, and only after the caller's yes to it. */
export const proposeChange: ToolDefinition = {
  name: PROPOSE_TOOL,
  label: "Preparing the read-back",
  description: "On a call: before anything that changes something or needs a person's approval, record exactly what you will do and get the sentence to read back. `task` is the full change in plain words (one short sentence). For a tool that needs approval also give `tool` and its exact `args`; the tool will then run only with those args. Say the returned sentence to the caller word for word and wait for their yes.",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", minLength: 1, maxLength: 500, description: "What will change, in full, as one short sentence. The job starts in a fresh conversation, so name the site, page, values and anything else it needs" },
      tool: { type: "string", description: "Only for a tool that needs approval: its name" },
      args: { type: "object", description: "Only with tool: the exact arguments you will call it with" },
    },
    required: ["task"],
    additionalProperties: false,
  },
  permission: "jobs.run",
  effect: "read",
  parallelSafe: false,
  voiceOnly: true,
  timeoutMs: 2_000,
  async execute(context, args) {
    if (!context.proposeChange) throw new ToolError("There is no call to read a change back on.", true);
    const sentence = context.proposeChange({ task: String(args.task), ...(args.tool ? { tool: String(args.tool) } : {}), ...(args.args ? { args: args.args as JsonObject } : {}) });
    return { data: { readBack: sentence, instruction: "Your whole reply now is exactly this question, then stop and wait for the caller's answer. Add nothing after it (no \"anything else?\"), do not repeat it, and if you already read this change back, never repeat that longer read-back. Do not start anything yet." } };
  },
};

const SHARED = [currentTime, webSearch, readPage, imageTool(), remember, recall, forget, postCard, updateCard, mySetup, updateProgress, checkBackIn, proposeChange, startInBackground];

export const TOOLS: Record<string, ToolDefinition> = {};
for (const tool of [...SHARED, ...AGENT_TOOLS]) {
  // Two tools with one name would make the model's choice ambiguous; fail at startup instead.
  if (TOOLS[tool.name]) throw new Error(`Two tools are named "${tool.name}".`);
  TOOLS[tool.name] = tool;
}
