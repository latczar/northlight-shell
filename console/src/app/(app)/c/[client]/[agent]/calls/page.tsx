import { callDate, callDay } from "@/lib/call-date";
import { hasServicesRequest } from "@/lib/services-call";
import { canManageAgent } from "@/lib/access";
import { CreateCallDraft } from "./CreateCallDraft";
import Link from "next/link";
import { notFound } from "next/navigation";
import { pilotCall, pilotCalls } from "@/lib/server/iris-calls.mjs";
import { historyCaller } from "@/lib/server/pilot-call-access";
import { requireAgent, requireViewer } from "@/lib/server/session";

type Call = { id: string; time: number | null; turns: { who: string; text: string }[]; endedBy?: "iris" | "phone" };
function searchText(text: string) {
  return text.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim();
}

export default async function PilotCallHistory({ params, searchParams }: {
  params: Promise<{ client: string; agent: string }>;
  searchParams: Promise<{ source?: string | string[]; cursor?: string | string[]; topic?: string | string[]; day?: string | string[] }>;
}) {
  const { client, agent } = await params;
  const desk = '/c/' + encodeURIComponent(client) + '/' + encodeURIComponent(agent);
  const path = desk + "/calls";
  const { source, cursor, topic = "", day = "" } = await searchParams;
  if (typeof topic !== "string" || topic.length > 120 || typeof day !== "string" ||
      (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) ||
      (cursor !== undefined && (typeof cursor !== "string" || cursor.length > 2048))) notFound();
  if (source !== undefined && (typeof source !== "string" || source.length > 125 || !source || cursor || topic.trim())) notFound();
  if (day) {
    const midnight = Date.parse(day + "T00:00:00Z");
    if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== day) notFound();
  }
  const sourceId = source;
  const searchTopic = topic.trim();
  const searchDay = day;
  const phrase = searchText(searchTopic);
  const searching = Boolean(phrase || day);
  function historyUrl(after?: string | null) {
    const parts = [];
    if (sourceId) parts.push("source=" + encodeURIComponent(sourceId));
    if (searchTopic) parts.push("topic=" + encodeURIComponent(searchTopic));
    if (searchDay) parts.push("day=" + encodeURIComponent(searchDay));
    if (after) parts.push("cursor=" + encodeURIComponent(after));
    return path + (parts.length ? "?" + parts.join("&") : "");
  }
  const currentPath = historyUrl(cursor);
  const viewer = await requireViewer(currentPath);
  requireAgent(viewer, client, agent);
  const caller = historyCaller(viewer.email, client, agent, viewer.userId);
  if (!caller) notFound();

  const found = new Map<string, Call>();
  const seen = new Set<string>();
  let after = cursor || null;
  let warning = "";
  let retryCursor = after;
  let completedBatches = 0;
  try {
    // Limit work per request. A retry resumes at the batch that failed.
    for (let i = 0; i < (searching ? 8 : 1); i++) {
      retryCursor = after;
      if (after) seen.add(after);
      let batch;
      if (source) {
        const call = await pilotCall(process.env.IRIS_CALL_HISTORY_KEY!, source, caller);
        batch = { records: call ? [call] : [], cursor: null, incomplete: false };
      } else {
        batch = await pilotCalls(process.env.IRIS_CALL_HISTORY_KEY!, after, caller, fetch, day);
      }
      for (const call of batch.records as Call[]) {
        if (day && (call.time === null || callDay.format(call.time * 1000) !== day)) continue;
        if (phrase && !call.turns.some(turn => searchText(turn.text).includes(phrase))) continue;
        found.set(call.id, call);
      }
      after = batch.cursor && !seen.has(batch.cursor) ? batch.cursor : null;
      if (batch.incomplete) {
        warning = "Some transcripts could not be loaded.";
        break;
      }
      completedBatches++;
      if (!after) break;
    }
  } catch {
    after = null;
    warning = completedBatches ? "Some older calls could not be loaded." : "Call history could not be loaded.";
  }
  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <Link href={desk} className="self-start text-small font-medium text-ink underline">Back to Iris</Link>
      <header>
        <h1 className="text-display text-ink">Call history</h1>
        <p className="text-small text-ink-2">Your calls to Iris. Times shown in UK time.</p>
      </header>
      <form action={path} className="flex flex-col gap-3 sm:flex-row sm:items-end" role="search" aria-label="Search call history">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-small font-medium">Topic
          <input type="search" name="topic" defaultValue={topic} maxLength={120} placeholder="e.g. Services" className="min-w-0 rounded-md border border-rule bg-card px-3 py-2 text-body" />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-small font-medium">Call date
          <input type="date" name="day" defaultValue={day} className="min-w-0 rounded-md border border-rule bg-card px-3 py-2 text-body" />
        </label>
        <button className="rounded-md bg-ink px-4 py-2 font-medium text-ground">Search calls</button>
      </form>
      {source && <Link href={day ? path + "?day=" + encodeURIComponent(day) : path} prefetch={false} className="self-start text-small underline">
        {day ? "Show calls from this day" : "Show all calls"}
      </Link>}
      {!source && searching && <Link href={path} className="self-start text-small underline">Clear search</Link>}
      {warning && (
        <p role="alert">
          {warning}{" "}
          <a href={historyUrl(retryCursor)} className="underline">Try again</a>
        </p>
      )}
      {!warning && !found.size && <p>{source ? "This call is unavailable." : searching ? (after ? "No matches in this group of calls." : "No matching calls in this range.") : "No calls on this page."}</p>}
      {Array.from(found.values(), call => (
        <details open={source === call.id} id={call.id} key={call.id} className="scroll-mt-24 rounded-lg border border-rule p-4">
          <summary className="cursor-pointer font-medium">{call.time === null ? "Call time unavailable" : callDate.format(call.time * 1000)}{phrase && <span className="mt-1 block line-clamp-2 text-small font-normal text-ink-2">{call.turns.find(turn => searchText(turn.text).includes(phrase))?.text}</span>}</summary>
          {!call.turns.length && <p className="mt-4 text-small text-ink-2">No transcript is available for this call.</p>}
          <ol className="mt-4 space-y-3">
            {call.turns.map((turn, j) => <li key={j}><strong>{turn.who}</strong><p className="whitespace-pre-wrap break-words">{turn.text}</p></li>)}
          </ol>
          {call.endedBy === "iris" && <p className="mt-4 text-small text-ink-2">Iris ended the call.</p>}
          {call.endedBy === "phone" && <p className="mt-4 text-small text-ink-2">The caller’s phone line disconnected.</p>}
          {canManageAgent(viewer.access, client, agent) && hasServicesRequest(call.turns) && (
            source
              ? <Link href={path + "/" + call.id + "/draft"} prefetch={false} className="mt-4 inline-block font-medium underline">Open Services draft</Link>
              : <CreateCallDraft client={client} agent={agent} callId={call.id} />
          )}

        </details>
      ))}
      {after && <Link href={historyUrl(after)} prefetch={false} className="self-start underline">{searching ? "Search older calls" : "Older calls"}</Link>}
    </section>
  );
}
