import type { ClientConfig, Connection, JsonObject, Limits, ModelConfig, Schedule } from "../src/contracts";
import { validateClient } from "../src/connections";
import { validateAccess } from "../src/access";
import { validateSlack } from "../src/slack";
import kestrelClient from "./kestrel/client.json";
import kestrelIris from "./kestrel/iris.json";

// One folder per client: client.json holds what is shared (token, model, rules, base permissions, shared connections);
// <agent>.json holds what one agent needs for that client (permissions, schedules, settings, connections, limits and
// a non-voice model of its own when it does not use the client's).
// shortcut: clients live in git; move them to D1 or Supabase once someone other than a developer edits them.

/** A connection declared in an agent's file belongs to that agent; `agents` is filled in. */
type AgentConnection = Omit<Connection, "agents">;
interface AgentFile { permissions: string[]; schedules: Schedule[]; settings: JsonObject; connections?: AgentConnection[]; model?: ModelConfig; limits?: Partial<Limits> }
type ClientFile = Omit<ClientConfig, "schedules" | "agentSettings" | "agentModels" | "agentLimits">;

export function compose(base: ClientFile, files: Record<string, AgentFile>): ClientConfig {
  for (const [agent, file] of Object.entries(files)) {
    if (!base.agents.includes(agent)) throw new Error(`Client ${base.id} has settings for ${agent}, who is not one of its agents.`);
    for (const schedule of file.schedules) {
      if (schedule.agent !== agent) throw new Error(`Schedule ${schedule.id} is in ${agent}.json but runs ${schedule.agent}.`);
    }
  }
  const agentFiles = Object.values(files);
  return {
    ...base,
    permissions: [...new Set([...base.permissions, ...agentFiles.flatMap(file => file.permissions)])],
    schedules: agentFiles.flatMap(file => file.schedules),
    agentSettings: Object.fromEntries(Object.entries(files).map(([agent, file]) => [agent, file.settings])),
    agentModels: Object.fromEntries(Object.entries(files).flatMap(([agent, file]) => file.model ? [[agent, file.model]] : [])),
    agentLimits: Object.fromEntries(Object.entries(files).flatMap(([agent, file]) => file.limits ? [[agent, file.limits]] : [])),
    connections: [
      ...(base.connections ?? []),
      ...Object.entries(files).flatMap(([agent, file]) => (file.connections ?? []).map(connection => ({ ...connection, agents: [agent] }))),
    ],
  };
}

export const CLIENTS: ClientConfig[] = [
  // JSON imports widen literals and unions; validateClient below checks the real shape at startup.
  compose(kestrelClient as ClientFile, { iris: kestrelIris } as unknown as Record<string, AgentFile>),
];
// Fails at startup on a credential value in config, an env var of another client, or a broken connection.
for (const client of CLIENTS) {
  validateClient(client, CLIENTS.filter(other => other !== client).map(other => other.id));
  validateAccess(client);
  validateSlack(client);
  if (client.phone && !/^[A-Z][A-Z0-9_]*$/.test(client.phone.callersEnv)) throw new Error(`Client ${client.id} must name its approved callers' env var.`);
}
