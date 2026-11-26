import { callDate, callDay } from "@/lib/call-date";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RequestCard } from "@/components/desk/RequestCard";
import { hasServicesRequest } from "@/lib/services-call";
import { canManageAgent } from "@/lib/access";
import { canAskForRevision, copyDraft, decisionRight } from "@/lib/requests";
import { callDraft } from "@/lib/server/brain";
import { pilotCall } from "@/lib/server/iris-calls.mjs";
import { historyCaller } from "@/lib/server/pilot-call-access";
import { requireAgent, requireViewer } from "@/lib/server/session";
import { CreateCallDraft } from "../../CreateCallDraft";
import { Progress } from "./Progress";
import { RefreshReview } from "./RefreshReview";

export default async function ServicesDraft({ params }: {
  params: Promise<{ client: string; agent: string; callId: string }>;
}) {
  const { client, agent, callId } = await params;
  const history = `/c/${client}/${agent}/calls`;
  const path = `${history}/${encodeURIComponent(callId)}/draft`;
  const viewer = await requireViewer(path);
  requireAgent(viewer, client, agent);
  const caller = historyCaller(viewer.email, client, agent, viewer.userId);
  if (!caller || !canManageAgent(viewer.access, client, agent)) notFound();

  const call = await pilotCall(process.env.IRIS_CALL_HISTORY_KEY!, callId, caller);
  if (!call) notFound();
  const sourceQuery = new URLSearchParams({ source: call.id });
  if (call.time !== null) sourceQuery.set("day", callDay.format(call.time * 1000));
  const sourceHistory = history + "?" + sourceQuery + "#" + call.id;
  const result = await callDraft(client, viewer.userId, callId);
  if ((result.state === "new" || result.state === "retry") && !hasServicesRequest(call.turns)) notFound();
  const ready = result.state === "ready" ? result : null;
  if (ready && (ready.original.requestedBy !== viewer.userId ||
    ready.latest.requestedBy !== viewer.userId || ready.original.preview.sourceCall !== callId)) notFound();

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <Link href={sourceHistory} className="self-start text-small font-medium underline">Back to call history</Link>
      <header>
        <h1 className="text-display">Services draft</h1>
        {call.time !== null && <p className="text-small text-ink-2">From your {callDate.format(call.time * 1000)} call, UK time.</p>}
      </header>
      <details className="rounded-lg border border-rule px-4 py-2">
        <summary className="cursor-pointer py-1 font-medium">Source call transcript</summary>
        <ol className="mt-3 space-y-2">
          {call.turns.map((turn: { who: string; text: string }, index: number) => (
            <li key={index}><strong>{turn.who}</strong><p className="whitespace-pre-wrap break-words">{turn.text}</p></li>
          ))}
        </ol>
      </details>
      {result.state === "working" && <Progress />}
      {(result.state === "new" || result.state === "retry") && (
        <div>
          {result.state === "retry" && <p>Iris finished without a reviewable title. You can try again.</p>}
          <CreateCallDraft client={client} agent={agent} callId={callId} />
        </div>
      )}
      {ready && ["pending", "declined", "approved"].includes(ready.latest.status) && <RefreshReview />}
      {ready && (
        <RequestCard key={ready.latest.id} request={ready.latest} clientId={client} agentName="Iris"
          askedBy="Asked by you" right={decisionRight(ready.latest, client, viewer)}
          canRevise={canAskForRevision(ready.latest, client, viewer)} draft={copyDraft(ready.latest)} />
      )}
      {ready && ready.latest.id !== ready.original.id && (
        <details className="rounded-lg border border-rule px-4 py-2">
          <summary className="cursor-pointer py-1 font-medium">Original draft and feedback</summary>
          <p className="mt-2 break-words">{String(ready.original.preview.proposed)}</p>
          <p className="mt-2 break-words text-small text-ink-2">{ready.original.reason}</p>
        </details>
      )}
    </section>
  );
}
