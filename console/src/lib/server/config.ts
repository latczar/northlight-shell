import "server-only";
import { isAdmin, parseAdmins, parseClients } from "@/lib/access";

// Read on every call (cheap), so tests and restarts see the current environment.
export const configuredClients = () => parseClients(process.env.AGENT_CLIENTS);

let warnedAdminsUnset = false;
export function viewerIsAdmin(email: string): boolean {
  const admins = parseAdmins(process.env.AGENT_ADMINS);
  if (!admins.length && !warnedAdminsUnset) {
    console.warn("AGENT_ADMINS is unset; nobody can manage people or decide requests as an Northlight admin.");
    warnedAdminsUnset = true;
  }
  return isAdmin(email, admins);
}

export interface BrainCredentials {
  url: string;
  token: string;
  userKey: string;
  approverKey: string;
}

/** Per-client brain secrets; a missing one is reported by name (never by value) so the page can say what to set. */
export function brainCredentials(clientId: string): BrainCredentials | { missing: string[] } {
  const suffix = clientId.toUpperCase().replace(/-/g, "_");
  const names = {
    url: "AGENT_BRAIN_URL",
    token: `BRAIN_TOKEN_${suffix}`,
    userKey: `BRAIN_USER_SIGNING_KEY_${suffix}`,
    approverKey: `BRAIN_APPROVER_SIGNING_KEY_${suffix}`,
  };
  const values = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, process.env[name]?.trim() ?? ""]));
  const missing = Object.entries(names).filter(([key]) => !values[key]).map(([, name]) => name);
  return missing.length ? { missing } : { ...(values as unknown as BrainCredentials), url: values.url.replace(/\/+$/, "") };
}

/** `ACCESS_SIGNING_KEY_<CLIENT>`: signs the approver lists sent to the brain; the brain holds the same value. */
export function accessSigningKey(clientId: string): { name: string; key: string | undefined } {
  const name = `ACCESS_SIGNING_KEY_${clientId.toUpperCase().replace(/-/g, "_")}`;
  return { name, key: process.env[name]?.trim() || undefined };
}
