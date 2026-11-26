"use server";

import { revalidatePath } from "next/cache";
import { configuredClients } from "@/lib/server/config";
import { passwordProblem } from "@/lib/password";
import { addPerson, PeopleError, pushAccess, savePersonAccess, setPersonPassword, type EmployeeAccess } from "@/lib/server/people";
import { actionViewer } from "@/lib/server/session";

export type PeopleResult = { ok: true; pushError: string | null } | { ok: false; error: string };

/** Every People action: an Northlight admin, a configured business, and errors in words. */
async function asAdmin(clientId: string, work: (actorId: string) => Promise<{ pushError: string | null }>): Promise<PeopleResult> {
  const viewer = await actionViewer();
  if ("error" in viewer) return { ok: false, error: viewer.error };
  if (!viewer.admin) return { ok: false, error: "Only Northlight admins change who has access." };
  if (!configuredClients().some(c => c.id === clientId)) return { ok: false, error: "This business is not set up in this app." };
  try {
    const { pushError } = await work(viewer.userId);
    revalidatePath("/people");
    return { ok: true, pushError };
  } catch (error) {
    if (error instanceof PeopleError) return { ok: false, error: error.message };
    console.error("people action failed", error instanceof Error ? error.message.slice(0, 160) : typeof error);
    return { ok: false, error: "Something failed while saving. Refresh to see what was saved, then try again." };
  }
}

const rowsOf = (raw: unknown): EmployeeAccess[] =>
  Array.isArray(raw)
    ? raw.filter((r): r is EmployeeAccess => !!r && typeof r === "object" && typeof (r as EmployeeAccess).agentId === "string")
        .map(r => ({ agentId: r.agentId, canApprove: r.canApprove === true, canManage: r.canManage === true }))
    : [];

export async function addPersonAction(clientId: string, email: string, name: string, password: string, rows: EmployeeAccess[]): Promise<PeopleResult> {
  return asAdmin(clientId, actorId => addPerson(actorId, clientId, String(email ?? ""), String(name ?? ""), String(password ?? ""), rowsOf(rows)));
}

// The person's changedAt as the page showed it, so a stale page refuses instead of undoing a newer change.
const seenAt = (raw: unknown): string | undefined => (typeof raw === "string" && !Number.isNaN(Date.parse(raw)) ? raw : undefined);

/** Saves one person's access and, when `password` is filled in, gives them that new password (checked before anything is saved). */
export async function savePersonAction(clientId: string, userId: string, rows: EmployeeAccess[], changedAt: string, password = ""): Promise<PeopleResult> {
  const expected = seenAt(changedAt);
  if (!/^[0-9a-f-]{36}$/i.test(String(userId)) || !expected) return { ok: false, error: "This person was not found. Refresh the page." };
  const newPassword = String(password ?? "");
  const weak = newPassword ? passwordProblem(newPassword) : null;
  if (weak) return { ok: false, error: `New password: ${weak}` };
  return asAdmin(clientId, async actorId => {
    const saved = await savePersonAccess(actorId, clientId, userId, rowsOf(rows), { changedAt: expected });
    if (newPassword) await setPersonPassword(clientId, userId, newPassword);
    return saved;
  });
}

export async function removePersonAction(clientId: string, userId: string, changedAt: string): Promise<PeopleResult> {
  const expected = seenAt(changedAt);
  if (!/^[0-9a-f-]{36}$/i.test(String(userId)) || !expected) return { ok: false, error: "This person was not found. Refresh the page." };
  return asAdmin(clientId, actorId => savePersonAccess(actorId, clientId, userId, [], { changedAt: expected }));
}

export async function resendAction(clientId: string): Promise<PeopleResult> {
  return asAdmin(clientId, async () => ({ pushError: await pushAccess(clientId) }));
}
