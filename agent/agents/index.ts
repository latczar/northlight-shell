import type { AgentTemplate, EditableSetting, SetupInput, SetupItem, ToolDefinition } from "../src/contracts";
import * as iris from "./iris";

// One folder per agent: agents/<id>/index.ts exports its `template` and its own `tools`.
// A new agent is a new folder plus one line below. Shared rules live in src/prompts.ts.
const FOLDERS = [iris];

export const AGENTS: Record<string, AgentTemplate> = Object.fromEntries(FOLDERS.map(folder => [folder.template.id, folder.template]));

/** What staff may change in the app, per agent (agents/<id>/setup.ts). */
export const EDITABLE: Record<string, EditableSetting[]> = Object.fromEntries(FOLDERS.map(folder => [folder.template.id, folder.editable]));

/** What each agent still needs before it is fully useful (agents/<id>/setup.ts). */
export const SETUP: Record<string, (input: SetupInput) => SetupItem[]> = Object.fromEntries(FOLDERS.map(folder => [folder.template.id, folder.setup]));

/** Every agent's own tools, for the catalog in tools/index.ts. */
export const AGENT_TOOLS: ToolDefinition[] = FOLDERS.flatMap(folder => folder.tools);
