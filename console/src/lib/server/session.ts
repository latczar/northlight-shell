import "server-only";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { accessFromRows, canSeeClient, canUseAgent, hasAccess, visibleClients, type Access, type AccessRow, type Client } from "@/lib/access";
import { configuredClients, viewerIsAdmin } from "./config";
import { supabaseServer } from "./supabase";

export interface Viewer {
  userId: string;
  email: string;
  name: string;
  /** An Northlight admin (AGENT_ADMINS): manages people and may decide any request on the desks they can open. */
  admin: boolean;
  access: Access;
  /** Clients this person may open (they may use at least one employee there). */
  clients: Client[];
}

type Lookup = { state: "signed-out" } | { state: "no-access"; email: string } | { state: "ok"; viewer: Viewer };

/**
 * Checks the session once per request by verifying the access token (`getClaims`), never trusting the cookie alone.
 * Access is read from the person's own `agent_access` rows on every request, so a revoked row is refused on the next one.
 * shortcut: a sign-out on another device applies only when the token expires (up to 1 hour); use getUser() to make it instant.
 */
export const lookupViewer = cache(async (): Promise<Lookup> => {
  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.getClaims();
  const claims = error ? null : data?.claims;
  if (!claims?.sub || typeof claims.email !== "string" || !claims.email) return { state: "signed-out" };
  // Their own rows only (RLS); revoked rows come back too and grant nothing.
  const { data: rows, error: rowsError } = await supabase.from("agent_access").select("client_id, agent_id, can_approve, can_manage, revoked_at").eq("user_id", claims.sub);
  if (rowsError) throw new Error(`Reading agent_access failed: ${rowsError.code ?? rowsError.message}`);
  const access = accessFromRows((rows ?? []) as AccessRow[]);
  const admin = viewerIsAdmin(claims.email);
  if (!hasAccess(access) && !admin) return { state: "no-access", email: claims.email };
  // the name an Northlight admin gave (app metadata), else one the person set for themselves; only ever shown to them
  const given = (claims.app_metadata ?? {}) as Record<string, unknown>;
  const meta = (claims.user_metadata ?? {}) as Record<string, unknown>;
  const name = [given.full_name, meta.full_name, meta.name].find((v): v is string => typeof v === "string" && v.trim() !== "");
  return {
    state: "ok",
    viewer: { userId: claims.sub, email: claims.email, name: name?.trim() ?? claims.email, admin, access, clients: visibleClients(access, configuredClients()) },
  };
});

/** For pages: signed-out people go to sign-in (and come back to `path`), people without any employee to "No access". */
export async function requireViewer(path: string): Promise<Viewer> {
  const found = await lookupViewer();
  if (found.state === "signed-out") redirect(`/sign-in?next=${encodeURIComponent(path)}`);
  if (found.state === "no-access") redirect("/no-access");
  return found.viewer;
}

/** A client this person may not open looks the same as one that does not exist. */
export function requireClient(viewer: Viewer, clientId: string): Client {
  return canSeeClient(viewer.access, viewer.clients, clientId) ?? notFound();
}

/** An employee this person may not use looks the same as one that does not exist. */
export function requireAgent(viewer: Viewer, clientId: string, agentId: string): Client {
  const client = requireClient(viewer, clientId);
  if (!canUseAgent(viewer.access, clientId, agentId)) notFound();
  return client;
}

/** Cookies are SameSite=Lax already; this also refuses cross-site posts from older browsers. */
export function sameSite(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === (request.headers.get("host") ?? new URL(request.url).host);
  } catch {
    return false;
  }
}

/** For route handlers: the viewer, or the error response to send. */
export async function apiViewer(request: Request): Promise<Viewer | Response> {
  if (!sameSite(request)) return Response.json({ error: "Cross-site request refused." }, { status: 403 });
  const found = await lookupViewer();
  if (found.state === "signed-out") return Response.json({ error: "Your session ended. Sign in again." }, { status: 401 });
  if (found.state === "no-access") return Response.json({ error: "You do not have access to Northlight." }, { status: 403 });
  return found.viewer;
}

/** For server actions: the viewer or an error the form can show (actions run same-site; Next checks the origin). */
export async function actionViewer(): Promise<Viewer | { error: string }> {
  const found = await lookupViewer();
  if (found.state === "signed-out") return { error: "Your session ended. Sign in again." };
  if (found.state === "no-access") return { error: "You do not have access to Northlight." };
  return found.viewer;
}
