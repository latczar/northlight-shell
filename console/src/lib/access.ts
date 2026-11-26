// Who may see and do what. Pure functions, so the rules are tested without a server.

export interface Client {
  id: string;
  name: string;
  /** The business's public website, when AGENT_CLIENTS gives one (https only) */
  site?: string;
}

export interface Grant {
  clientId: string;
  agentId: string;
  canApprove: boolean;
  /** May change this employee's settings and run its manager-only work. Never implied by `canApprove`. */
  canManage: boolean;
}

/** What one person may do: exactly their grants. Nobody, Northlight admins included, gets an employee automatically. */
export interface Access {
  grants: Grant[];
}

/** One `agent_access` row as read from Supabase. */
export interface AccessRow {
  client_id: string;
  agent_id: string;
  can_approve: boolean;
  can_manage: boolean;
  revoked_at: string | null;
}

export const CLIENT_ID = /^[a-z0-9-]{1,64}$/;
export const AGENT_ID = /^[a-z0-9-]{1,32}$/;

/** Northlight admins manage people and may decide any request, but gain no employee by being admins. */
export const parseAdmins = (raw: string | undefined): string[] =>
  [...new Set((raw ?? "").split(",").map(email => email.trim().toLowerCase()).filter(Boolean))];

export const isAdmin = (email: string, admins: string[]): boolean =>
  !!email.trim() && admins.includes(email.trim().toLowerCase());

/** `AGENT_CLIENTS`: `[{ "id": "kestrel", "name": "Kestrel Garage" }]`. Bad entries are dropped, never guessed. */
export function parseClients(raw: string | undefined): Client[] {
  const list = parseJson(raw, "AGENT_CLIENTS");
  if (!Array.isArray(list)) return [];
  return list.flatMap(item =>
    item && typeof item.id === "string" && CLIENT_ID.test(item.id) && typeof item.name === "string" && item.name.trim()
      ? [{ id: item.id, name: item.name.trim(), ...(typeof item.site === "string" && /^https:\/\/[^\s"'<>]+$/.test(item.site) ? { site: item.site } : {}) }]
      : []);
}

/** Active rows only: revoked and malformed rows grant nothing. */
export function accessFromRows(rows: AccessRow[]): Access {
  const access: Access = { grants: [] };
  for (const row of rows) {
    if (!row.revoked_at && CLIENT_ID.test(row.client_id) && AGENT_ID.test(row.agent_id)) {
      access.grants.push({ clientId: row.client_id, agentId: row.agent_id, canApprove: row.can_approve === true, canManage: row.can_manage === true });
    }
  }
  return access;
}

export const hasAccess = (access: Access) => access.grants.length > 0;

export const canUseAgent = (access: Access, clientId: string, agentId: string): boolean =>
  access.grants.some(g => g.clientId === clientId && g.agentId === agentId);

export const canApproveAgent = (access: Access, clientId: string, agentId: string): boolean =>
  access.grants.some(g => g.clientId === clientId && g.agentId === agentId && g.canApprove);

export const canManageAgent = (access: Access, clientId: string, agentId: string): boolean =>
  access.grants.some(g => g.clientId === clientId && g.agentId === agentId && g.canManage);

/** The configured clients this person may open (they may use at least one employee there), in configured order. */
export const visibleClients = (access: Access, clients: Client[]): Client[] =>
  clients.filter(c => access.grants.some(g => g.clientId === c.id));

export const canSeeClient = (access: Access, clients: Client[], clientId: string): Client | undefined =>
  visibleClients(access, clients).find(c => c.id === clientId);

function parseJson(raw: string | undefined, name: string): unknown {
  if (!raw?.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    console.error(`${name} is not valid JSON; nobody gets access until it is fixed.`);
    return undefined;
  }
}
