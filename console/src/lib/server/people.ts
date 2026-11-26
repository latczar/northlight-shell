import "server-only";
import { setTimeout as wait } from "node:timers/promises";
import { AGENT_ID } from "@/lib/access";
import { passwordProblem } from "@/lib/password";
import { BrainError, putApprovers, readAgents } from "./brain";
import { supabaseAdmin } from "./supabase";

// The People page's server side: who may use, approve and manage each employee of a client, and handing the result to the
// brain. Only Northlight admins reach these (the actions check first). Writes go through the SQL function set_agent_access
// (supabase/migrations), which bumps the client's version in the same transaction, so a late push never undoes a newer one.

export interface EmployeeAccess {
  agentId: string;
  canApprove: boolean;
  canManage: boolean;
}

export interface Person {
  userId: string;
  email: string;
  name: string | null;
  access: EmployeeAccess[];
  /** The newest change to this person's access here, sent back with a save so a stale page cannot overwrite a newer one. */
  changedAt: string;
}

export interface SyncState {
  wantedVersion: number;
  pushedVersion: number;
  lastError: string | null;
  updatedAt: string;
}

interface PushStateRow {
  wanted_version: number;
  pushed_version: number;
  last_error: string | null;
  updated_at: string;
  rows: { user_id: string; agent_id: string; can_approve: boolean; can_manage: boolean }[];
}

export class PeopleError extends Error {}

function fail(what: string, error: { code?: string; message?: string } | null): never {
  console.error(`${what} failed`, error?.code ?? error?.message?.slice(0, 120));
  throw new PeopleError(`Could not ${what}. Try again; if it keeps failing, tell the Northlight team.`);
}

export async function listPeople(clientId: string): Promise<Person[]> {
  const { data, error } = await supabaseAdmin().rpc("access_people", { p_client_id: clientId });
  if (error) fail("read the people of this business", error);
  const people = new Map<string, Person>();
  for (const row of (data ?? []) as { user_id: string; email: string; full_name: string | null; agent_id: string; can_approve: boolean; can_manage: boolean; changed_at: string }[]) {
    const person = people.get(row.user_id) ?? { userId: row.user_id, email: row.email, name: row.full_name?.trim() || null, access: [], changedAt: row.changed_at };
    person.access.push({ agentId: row.agent_id, canApprove: row.can_approve, canManage: row.can_manage });
    people.set(row.user_id, person);
  }
  return [...people.values()];
}

export async function syncState(clientId: string): Promise<SyncState | null> {
  const { data, error } = await supabaseAdmin().rpc("access_push_state", { p_client_id: clientId });
  if (error) fail("read whether the access list reached Northlight's service", error);
  const state = data as PushStateRow | null;
  return state ? { wantedVersion: state.wanted_version, pushedVersion: state.pushed_version, lastError: state.last_error, updatedAt: state.updated_at } : null;
}

/**
 * Sends the client's current approver and manager lists to the brain, recomputed from the saved rows (never from the
 * change that triggered it). Returns the brain's refusal in words, or null once it holds this version or a newer one.
 */
export async function pushAccess(clientId: string): Promise<string | null> {
  const admin = supabaseAdmin();
  const { data, error } = await admin.rpc("access_push_state", { p_client_id: clientId });
  if (error) fail("read the access list", error);
  const state = data as PushStateRow | null;
  if (!state || state.pushed_version >= state.wanted_version) return null;
  let refusal: string;
  try {
    // The brain refuses a list naming an employee it does not have, so rows for a retired employee stay here only.
    const agents = new Set((await readAgents(clientId)).map(a => a.id));
    const approvers: Record<string, string[]> = {};
    const managers: Record<string, string[]> = {};
    for (const row of state.rows.filter(r => agents.has(r.agent_id))) {
      if (row.can_approve) (approvers[row.agent_id] ??= []).push(row.user_id);
      if (row.can_manage) (managers[row.agent_id] ??= []).push(row.user_id);
    }
    // a brief outage or timeout is tried again twice; a refusal is not
    for (let attempt = 0; ; attempt++) {
      try {
        await putApprovers(clientId, state.wanted_version, approvers, managers);
        break;
      } catch (error) {
        if (attempt >= 2 || !(error instanceof BrainError) || ![429, 500, 502, 504].includes(error.status)) throw error;
        await wait(attempt ? 1500 : 500);
      }
    }
    const done = await admin.rpc("access_push_done", { p_client_id: clientId, p_version: state.wanted_version });
    if (done.error) fail("record that Northlight's service has the access list", done.error);
    return null;
  } catch (error) {
    if (error instanceof PeopleError) throw error;
    refusal = error instanceof BrainError ? error.message : "Northlight's service did not take the access list.";
    // skipped because a newer send from this app landed first: that send carries this change too. Its record can trail
    // its arrival at the brain by a moment, so look twice before calling this a failure.
    if (error instanceof BrainError && error.status === 409) {
      for (const pause of [0, 500]) {
        await wait(pause);
        const now = await admin.rpc("access_push_state", { p_client_id: clientId });
        if (!now.error && ((now.data as PushStateRow | null)?.pushed_version ?? 0) >= state.wanted_version) return null;
      }
    }
  }
  await admin.rpc("access_push_failed", { p_client_id: clientId, p_error: refusal });
  return refusal;
}

/** Checks the requested access against the employees the brain lists for this client now. */
async function checkedRows(clientId: string, rows: EmployeeAccess[]): Promise<EmployeeAccess[]> {
  const ids = rows.map(r => r.agentId);
  if (new Set(ids).size !== ids.length || ids.some(id => !AGENT_ID.test(id))) throw new PeopleError("Each employee can be chosen once.");
  let known: Set<string>;
  try {
    known = new Set((await readAgents(clientId)).map(a => a.id));
  } catch (error) {
    throw new PeopleError(error instanceof BrainError ? error.message : "Northlight's service did not answer. Try again in a minute.");
  }
  const unknown = ids.find(id => !known.has(id));
  if (unknown) throw new PeopleError(`This business has no employee "${unknown}".`);
  return rows.map(r => ({ agentId: r.agentId, canApprove: r.canApprove === true, canManage: r.canManage === true }));
}

/**
 * Replaces one person's access to one client (an empty list removes it), then hands the new lists to the brain.
 * `seen`: the person's `changedAt` as the page showed it (nothing is saved when their access changed since), or "new"
 * for someone being added (nothing is saved when they already have access here). Both are checked under the client's
 * lock in set_agent_access.
 */
export async function savePersonAccess(actorId: string, clientId: string, userId: string, rows: EmployeeAccess[], seen: { changedAt: string } | "new"): Promise<{ pushError: string | null }> {
  const clean = await checkedRows(clientId, rows);
  const { error } = await supabaseAdmin().rpc("set_agent_access", {
    p_actor: actorId,
    p_user_id: userId,
    p_client_id: clientId,
    p_rows: clean.map(r => ({ agent_id: r.agentId, can_approve: r.canApprove, can_manage: r.canManage })),
    p_expected: seen === "new" ? null : seen.changedAt,
    p_add: seen === "new",
  });
  if (error?.code === "40001") throw new PeopleError("Someone changed this person's access since this page loaded. Refresh to see it, then make your change again.");
  if (error?.code === "23505") throw new PeopleError("This person already has access here. Refresh, then use Change in their row.");
  if (error) fail("save the access", error);
  return { pushError: await pushAccess(clientId) };
}

/**
 * True once the brain holds this person's current access for the business. When a change of theirs is still waiting (a
 * send failed), the lists are sent again first. Callers start or resume nothing for the person while this is false, so a
 * right removed here cannot keep working through the brain's older copy. Throws when the check cannot be read.
 */
export async function brainHasAccess(userId: string, clientId: string): Promise<boolean> {
  const pending = async () => {
    const { data, error } = await supabaseAdmin().rpc("access_pending", { p_user_id: userId, p_client_id: clientId });
    if (error) fail("check whether Northlight's service has the latest access", error);
    return data === true;
  };
  if (!(await pending())) return true;
  // the send's own outcome is not the answer: a newer send from elsewhere in this app may have landed meanwhile
  await pushAccess(clientId).catch(() => null);
  return !(await pending());
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

/**
 * Gives a person access by email, with the password they will sign in with: a new sign-in account made confirmed, or their
 * existing account with its password replaced (only once the access is saved). The account records which admin added it in
 * app metadata, which only the server can write. Accounts are never deleted here.
 */
export async function addPerson(actorId: string, clientId: string, emailRaw: string, nameRaw: string, passwordRaw: string, rows: EmployeeAccess[]): Promise<{ userId: string; pushError: string | null }> {
  const email = emailRaw.trim().toLowerCase();
  const name = nameRaw.trim().slice(0, 80);
  const password = String(passwordRaw ?? "");
  if (!EMAIL.test(email)) throw new PeopleError("Enter a full email address, like alex@example.com.");
  const weak = passwordProblem(password);
  if (weak) throw new PeopleError(`Password: ${weak}`);
  if (!rows.length) throw new PeopleError("Choose at least one employee this person may use.");
  await checkedRows(clientId, rows);
  const admin = supabaseAdmin();
  const found = await admin.rpc("access_user_id_for_email", { p_email: email });
  if (found.error) fail("look up the email", found.error);
  let userId = found.data as string | null;
  // an account made here already has the password; one that existed gets it once the access is saved
  let existing = Boolean(userId);
  if (!userId) {
    const created = await admin.auth.admin.createUser({
      email, password, email_confirm: true, app_metadata: { northlight_added_by: actorId, ...(name ? { full_name: name } : {}) },
    });
    if (created.data.user) userId = created.data.user.id;
    else if (created.error?.code === "email_exists") {
      // Someone added the same email a moment ago: use that account (its password is set below, like any existing one).
      const again = await admin.rpc("access_user_id_for_email", { p_email: email });
      userId = (again.data as string | null) ?? null;
      existing = true;
    } else if (created.error?.code === "weak_password") throw new PeopleError("Password: choose a longer or less common one.");
    if (!userId) fail("create the sign-in account", created.error);
  }
  const { pushError } = await savePersonAccess(actorId, clientId, userId, rows, "new");
  if (existing) {
    try {
      await replacePassword(userId, password);
    } catch {
      throw new PeopleError(`${email} has access now, but the password was not set. Use Change in their row to set it.`);
    }
  }
  return { userId, pushError };
}

/** Sets a new password for someone with access to this client (the admin's "Forgotten password" answer). */
export async function setPersonPassword(clientId: string, userId: string, passwordRaw: string): Promise<{ pushError: string | null }> {
  const weak = passwordProblem(String(passwordRaw ?? ""));
  if (weak) throw new PeopleError(`Password: ${weak}`);
  if (!(await listPeople(clientId)).some(p => p.userId === userId)) throw new PeopleError("This person was not found. Refresh the page.");
  await replacePassword(userId, String(passwordRaw));
  return { pushError: null };
}

async function replacePassword(userId: string, password: string): Promise<void> {
  const { error } = await supabaseAdmin().auth.admin.updateUserById(userId, { password });
  if (error?.code === "weak_password") throw new PeopleError("Password: choose a longer or less common one.");
  if (error) fail("set the password", error);
}
