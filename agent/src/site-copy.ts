import { WorkerEntrypoint } from "cloudflare:workers";
import { CLIENTS } from "../clients";
import type { JsonObject } from "./contracts";
import type { Env } from "./conversation";

// Website copy with two states: Live, which the public site shows, and Preview, which is Live plus the changes people
// approved and nobody has published yet. Approving a submit_seo_copy draft adds it to the waiting changes; Publish makes
// them Live; Discard drops them. The site Worker reads either state through the SiteCopy entrypoint below and applies it
// to each page's title and meta description as it serves the page.

/** One page's copy: only the fields that differ from the built site. */
export type PageCopy = { title?: string; description?: string };
/** Page copy by path ("/" or "/services", never a trailing slash). */
export type CopyMap = Record<string, PageCopy>;
export interface SiteCopyState {
  live: CopyMap;
  /** Approved changes waiting to be published, with the wording each replaces. */
  pending: Record<string, Record<string, { text: string; replaces: string; approvedAt: number }>>;
  publishedAt?: number;
  publishedBy?: string;
}

export const SITE_COPY_AGENT = "iris";
export const SITE_COPY_KIND = "site_copy";
const FIELDS = ["title", "description"] as const;

export function pagePath(url: string): string {
  const path = new URL(url).pathname.replace(/\/+$/, "");
  return path || "/";
}

export function emptyState(): SiteCopyState {
  return { live: {}, pending: {} };
}

function stateFrom(value: unknown): SiteCopyState {
  const state = value && typeof value === "object" ? value as Partial<SiteCopyState> : {};
  return { ...emptyState(), ...state, live: { ...state.live }, pending: { ...state.pending } };
}

/** The snapshot merge for an approved draft ({url, field, proposed, current}): it waits in Preview until published. */
export function addPending(previous: unknown, data: JsonObject, at = Date.now()): SiteCopyState | undefined {
  const field = String(data.field);
  if (typeof data.url !== "string" || typeof data.proposed !== "string" || !FIELDS.includes(field as typeof FIELDS[number])) return undefined;
  const state = stateFrom(previous);
  const path = pagePath(data.url);
  state.pending[path] = { ...state.pending[path], [field]: { text: data.proposed.trim(), replaces: typeof data.current === "string" ? data.current : "", approvedAt: at } };
  return state;
}

/** Live with the waiting changes applied: what Preview shows. */
export function previewCopy(state: SiteCopyState): CopyMap {
  const copy: CopyMap = Object.fromEntries(Object.entries(state.live).map(([path, page]) => [path, { ...page }]));
  for (const [path, fields] of Object.entries(state.pending)) {
    for (const [field, change] of Object.entries(fields)) copy[path] = { ...copy[path], [field]: change.text };
  }
  return copy;
}

export function publish(state: SiteCopyState, person: string, at = Date.now()): SiteCopyState {
  return { live: previewCopy(state), pending: {}, publishedAt: at, publishedBy: person };
}

export function discard(state: SiteCopyState): SiteCopyState {
  return { ...state, pending: {} };
}

async function load(env: Pick<Env, "DASHBOARD">, clientId: string): Promise<SiteCopyState> {
  const raw = await env.DASHBOARD.get(env.DASHBOARD.idFromName(clientId)).snapshot(SITE_COPY_AGENT, SITE_COPY_KIND);
  return stateFrom(raw === undefined ? undefined : JSON.parse(raw));
}

/** Publishes or discards the waiting changes. Callers check the person's right first. */
export async function changeSiteCopy(env: Pick<Env, "DASHBOARD">, clientId: string, action: "publish" | "discard", person: string): Promise<SiteCopyState> {
  const current = await load(env, clientId);
  const next = action === "publish" ? publish(current, person) : discard(current);
  await env.DASHBOARD.get(env.DASHBOARD.idFromName(clientId)).saveSnapshot(SITE_COPY_AGENT, SITE_COPY_KIND, JSON.stringify(next));
  return next;
}

/**
 * For the client's website Worker, through a service binding only (an entrypoint is never reachable from the internet):
 * the copy to apply in Live or Preview. An unknown client gets nothing to apply.
 */
export class SiteCopy extends WorkerEntrypoint<Env> {
  async pages(clientId: string, mode: "live" | "preview"): Promise<CopyMap> {
    const client = CLIENTS.find(c => c.id === clientId);
    if (!client?.agents.includes(SITE_COPY_AGENT)) return {};
    const state = await load(this.env, client.id);
    return mode === "preview" ? previewCopy(state) : state.live;
  }
}
