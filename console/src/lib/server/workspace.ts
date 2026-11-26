import "server-only";
import type { Client } from "@/lib/access";
import { canUseAgent } from "@/lib/access";
import type { AgentData, AgentSetup, AgentSummary, Approval, Card, Lesson } from "@/lib/brain-types";
import { canSeeCard, canSeeLessonSource, canSeeRequest } from "@/lib/requests";
import { BrainError, getData, getSetup, listAgents, listApprovals, listCards, listLessons, listPendingApprovals } from "./brain";
import type { Viewer } from "./session";
import { supabaseAdmin } from "./supabase";

// What the team page and an employee's desk show, read on the server and scoped to the viewer before it reaches a page.
// Each part loads on its own, so one failed read says so in its place instead of failing the page.

export type Part<T> = { ok: true; value: T } | { ok: false; error: string };

async function part<T>(work: Promise<T>): Promise<Part<T>> {
  try {
    return { ok: true, value: await work };
  } catch (error) {
    if (!(error instanceof BrainError)) console.error("read failed", error instanceof Error ? error.message.slice(0, 200) : typeof error);
    return { ok: false, error: error instanceof BrainError ? error.message : "Northlight's service failed. Try again." };
  }
}

const WORK_LIMIT = 20;
// a request still waiting is listed under Needs you and Requests, so the work lists show only what happened
const done = (card: Card) => card.kind !== "needs_approval";

export interface TeamView {
  agents: Part<AgentSummary[]>;
  /** Requests waiting on a decision that this person may see. */
  requests: Part<Approval[]>;
  /** What the employees did lately, newest first. */
  work: Part<Card[]>;
  names: Record<string, string>;
}

export async function loadTeam(viewer: Viewer, client: Client): Promise<TeamView> {
  const usable = (agent: string) => canUseAgent(viewer.access, client.id, agent);
  const [agents, requests, work] = await Promise.all([
    part(listAgents(client.id).then(list => list.filter(a => usable(a.id)))),
    part(listPendingApprovals(client.id).then(list => list.filter(r => usable(r.agent) && canSeeRequest(r, viewer)))),
    part(listCards(client.id).then(list => list.filter(c => done(c) && usable(c.agent) && canSeeCard(c, viewer, client.id)).slice(0, WORK_LIMIT))),
  ]);
  return { agents, requests, work, names: await namesFor(viewer, requests.ok ? requests.value : []) };
}

export interface DeskView {
  agent: Part<AgentSummary | null>;
  pending: Part<Approval[]>;
  /** Decided requests this person may see, newest first. */
  decided: Part<Approval[]>;
  work: Part<Card[]>;
  setup: Part<AgentSetup>;
  data: Part<AgentData>;
  lessons: Part<Lesson[]>;
  names: Record<string, string>;
}

export async function loadDesk(viewer: Viewer, client: Client, agentId: string): Promise<DeskView> {
  const mine = (r: Approval) => r.agent === agentId && canSeeRequest(r, viewer);
  const [agent, pending, decided, work, setup, data, lessons] = await Promise.all([
    part(listAgents(client.id).then(list => list.find(a => a.id === agentId) ?? null)),
    part(listPendingApprovals(client.id).then(list => list.filter(mine))),
    part(listApprovals(client.id).then(list => list.filter(r => mine(r) && r.status !== "pending").slice(0, WORK_LIMIT))),
    part(listCards(client.id).then(list => list.filter(c => done(c) && c.agent === agentId && canSeeCard(c, viewer, client.id)).slice(0, WORK_LIMIT))),
    part(getSetup(client.id, agentId)),
    part(getData(client.id, agentId)),
    // a person's quoted words, and lessons still waiting, only for those who may see where they came from
    part(listLessons(client.id, agentId).then(list => list.flatMap(lesson => {
      const source = canSeeLessonSource(lesson.conversationId, viewer, client.id, agentId);
      if (lesson.status !== "active" && !source) return [];
      return [source ? lesson : { ...lesson, evidence: "" }];
    }))),
  ]);
  const requests = [...(pending.ok ? pending.value : []), ...(decided.ok ? decided.value : [])];
  return { agent, pending, decided, work, setup, data, lessons, names: await namesFor(viewer, requests) };
}

const NAME_TTL_MS = 60_000;
const nameCache = new Map<string, { name: string; at: number }>();

/**
 * Display names for the people who asked, for Northlight admins only: everyone else sees only their own requests ("Asked by
 * you"). Read with the service role after scoping, kept a minute in this server's memory, never in the shared brain cache.
 */
async function namesFor(viewer: Viewer, requests: Approval[]): Promise<Record<string, string>> {
  if (!viewer.admin) return {};
  const ids = [...new Set(requests.map(r => r.requestedBy).filter((id): id is string => !!id && id !== viewer.userId))];
  const names: Record<string, string> = {};
  await Promise.all(ids.map(async id => {
    const kept = nameCache.get(id);
    if (kept && Date.now() - kept.at < NAME_TTL_MS) {
      names[id] = kept.name;
      return;
    }
    try {
      const { data } = await supabaseAdmin().auth.admin.getUserById(id);
      // the name an admin gave (app metadata, server-written only) or the email: a person cannot rename themselves here
      const name = [data.user?.app_metadata?.full_name, data.user?.email].find((v): v is string => typeof v === "string" && v.trim() !== "");
      if (name) {
        names[id] = name.trim();
        nameCache.set(id, { name: name.trim(), at: Date.now() });
      }
    } catch {
      // A name that cannot be read shows as "someone in the app"; the request itself is still shown and decidable.
    }
  }));
  return names;
}
