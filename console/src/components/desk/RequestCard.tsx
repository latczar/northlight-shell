"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { Check, ExternalLink, RotateCw, X } from "lucide-react";
import { decideRequest } from "@/app/(app)/c/[client]/[agent]/actions";
import { announce } from "@/components/ui/Announcer";
import { Button } from "@/components/ui/Button";
import { card } from "@/components/ui/Card";
import { Textarea } from "@/components/ui/Field";
import { KeyValue, KeyValueRow } from "@/components/ui/KeyValue";
import { Notice } from "@/components/ui/Notice";
import { Status, type Tone } from "@/components/ui/Status";
import type { Approval } from "@/lib/brain-types";
import { formatAgo, formatFull } from "@/lib/format";
import { previewFields } from "@/lib/preview";
import type { CopyDraft } from "@/lib/requests";

const STATE: Record<Approval["status"], { tone: Tone; word: string }> = {
  pending: { tone: "attention", word: "Needs a decision" },
  approved: { tone: "live", word: "Approved, being carried out" },
  done: { tone: "ok", word: "Done" },
  declined: { tone: "quiet", word: "Declined" },
  failed: { tone: "error", word: "Did not go through" },
  uncertain: { tone: "error", word: "Not confirmed" },
};

/*
 One request: what the employee wants to do, in the words it proposed, and the decision in place. Approve is the one
 primary action; Decline asks what should change (the employee gets the reason). A declined copy draft can go back for a
 new draft with that feedback. Success is shown only after the brain recorded the decision.
*/
export function RequestCard({
  request,
  clientId,
  agentName,
  askedBy,
  right,
  canRevise,
  draft,
}: {
  request: Approval;
  clientId: string;
  agentName: string;
  askedBy: string;
  right: "decide" | "waiting" | "none";
  canRevise: boolean;
  draft: CopyDraft | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [doing, setDoing] = useState<"approve" | "decline" | "revise" | null>(null);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();
  const state = request.status === "pending" && right === "waiting" ? { tone: "attention" as Tone, word: "Waiting for an Northlight admin" } : STATE[request.status];

  function decide(decision: "approve" | "decline" | "revise" | "requestChanges") {
    const rewrite = decision === "requestChanges";
    const first = decision === "requestChanges" ? "decline" : decision;
    setDoing(rewrite ? "revise" : first);
    setError(null);
    start(async () => {
      try {
        const result = await decideRequest(clientId, request.agent, request.id, first, first === "decline" ? reason : "");
        if (!result.ok) {
          setError(result.error);
          setDoing(null);
          router.refresh();
          return;
        }
        if (rewrite) {
          const revision = await decideRequest(clientId, request.agent, request.id, "revise", "");
          if (!revision.ok) {
            setError(revision.error);
            setDoing(null);
            router.refresh();
            return;
          }
        }
        announce(first === "revise" || rewrite ? `${agentName} wrote a new draft.` : first === "approve" ? "Approved." : "Declined.");
        setDeclining(false);
        router.refresh();
      } catch {
        setDoing(null);
        setError("The connection was interrupted. Reopen this request to check its decision before trying again.");
      }
    });
  }

  return (
    <article id={`request-${request.id}`} aria-labelledby={`${request.id}-title`} className={`flex scroll-mt-28 flex-col gap-3 ${card}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Status tone={state.tone}>{state.word}</Status>
        <span className="ml-auto text-meta text-ink-3">
          {askedBy} ·{" "}
          <time dateTime={new Date(request.createdAt).toISOString()} title={formatFull(request.createdAt)}>
            {formatAgo(request.createdAt)}
          </time>
        </span>
      </div>
      <h3 id={`${request.id}-title`} className="text-title text-pretty text-ink">
        {request.title}
      </h3>

      {draft ? <CopyCompare draft={draft} /> : <Preview request={request} />}

      {request.status !== "pending" && request.reason && (
        <p className="text-small text-ink-2">
          <span className="font-medium text-ink">Reason given: </span>
          {request.reason}
        </p>
      )}

      {draft && request.status === "pending" && (
        <p className="text-small text-pretty text-ink-2">Approval saves this wording. Publishing is a separate step.</p>
      )}

      {error && <Notice tone="danger">{error}</Notice>}

      {right === "decide" && request.status === "pending" && !declining && (
        <div className="flex flex-wrap items-stretch gap-2 pt-1">
          <Button className={draft ? "max-sm:flex-1" : undefined} variant="primary" icon={<Check aria-hidden="true" />} busy={pending && doing === "approve"} busyLabel="Approving" onClick={() => decide("approve")}>
            {draft ? "Approve this copy" : "Approve"}
          </Button>
          <Button className={draft ? "max-sm:flex-1" : undefined} disabled={pending} icon={draft ? <RotateCw aria-hidden="true" /> : <X aria-hidden="true" />} onClick={() => setDeclining(true)}>
            {draft ? "Request changes" : "Decline"}
          </Button>
        </div>
      )}
      {right === "decide" && request.status === "pending" && declining && (
        <form
          className="flex flex-col gap-3 rounded-lg border border-rule bg-inset p-4"
          onSubmit={e => {
            e.preventDefault();
            decide(draft ? "requestChanges" : "decline");
          }}
        >
          <Textarea
            id={reasonId}
            label={draft ? `What should ${agentName} change?` : "Why not? (optional)"}
            hint={draft ? "Your feedback stays with this draft." : `${agentName} sees the reason. Up to 500 characters.`}
            maxLength={500}
            rows={2}
            value={reason}
            onChange={e => setReason(e.target.value)}
            autoFocus
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant={draft ? "primary" : "danger"} disabled={pending || Boolean(draft && !reason.trim())} busy={pending} busyLabel={draft ? "Requesting changes" : "Declining"}>
              {draft ? "Send feedback" : "Decline"}
            </Button>
            {draft && <Button variant="link" disabled={pending} onClick={() => decide("decline")}>Decline without a rewrite</Button>}
            <Button variant="ghost" disabled={pending} onClick={() => setDeclining(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {right === "waiting" && request.status === "pending" && (
        <p className="text-small text-ink-2">You asked for this; an Northlight admin approves it for you.</p>
      )}
      {canRevise && (
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button icon={<RotateCw aria-hidden="true" />} busy={pending && doing === "revise"} busyLabel={`${agentName} is rewriting`} onClick={() => decide("revise")}>
            Ask for a new draft
          </Button>
          <span className="text-small text-ink-2">{agentName} rewrites it with your feedback. It can take a minute.</span>
        </div>
      )}
    </article>
  );
}

/** Show the proposed copy first. The current and previous versions are available for comparison. */
function CopyCompare({ draft }: { draft: CopyDraft }) {
  return (
    <div className="flex flex-col gap-3">
      {draft.url && (
        <a href={draft.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1.5 self-start text-small break-all text-accent-text underline decoration-accent-text/40 underline-offset-4 hover:decoration-accent-text">
          {draft.url}
          <ExternalLink className="size-3.5" aria-hidden="true" />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      )}
      {draft.reason && (
        <p className="text-small text-pretty text-ink-2">
          {draft.reason}
        </p>
      )}
      <div className="flex flex-col gap-2 rounded-lg border border-accent-text/40 bg-tint p-4">
        <span className="text-label text-ink-2">{draft.field === "title" ? "Proposed page title" : "Proposed search description"}</span>
        <p className="text-body text-pretty break-words text-ink">{draft.proposed || "Remove the current wording."}</p>
      </div>
      <details className="rounded-lg border border-rule px-4 py-2">
        <summary className="cursor-pointer py-1 text-small font-medium text-ink">Compare with the live page</summary>
        <p className="break-words py-2 text-body text-ink">{draft.current || "No wording on the page yet."}</p>
      </details>
      {draft.previous && (
        <details className="group rounded-lg border border-rule px-4 py-2">
          <summary className="cursor-pointer py-1 text-small font-medium text-ink">The earlier draft you declined</summary>
          <div className="flex flex-col gap-1 pb-2 text-small text-ink-2">
            <p className="break-words">{draft.previous.proposed}</p>
            {draft.previous.feedback && <p><span className="font-medium text-ink">Your feedback: </span>{draft.previous.feedback}</p>}
          </div>
        </details>
      )}
    </div>
  );
}

/** Any other request: its summary and the details the employee attached, as labelled fields (never raw data). */
function Preview({ request }: { request: Approval }) {
  const fields = previewFields(request.preview);
  return (
    <div className="flex flex-col gap-3">
      {request.summary && <p className="max-w-[65ch] text-small text-pretty text-ink-2">{request.summary}</p>}
      {fields.length > 0 && (
        <KeyValue>
          {fields.map(field => (
            <KeyValueRow key={field.label} label={field.label}>
              {field.kind === "link" ? (
                <a href={field.href} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-accent-text underline decoration-accent-text/40 underline-offset-4">
                  {field.text}
                </a>
              ) : field.kind === "list" ? (
                <span>
                  {field.items.map(item => item.text).join(", ")}
                  {field.more > 0 && ` and ${field.more} more`}
                </span>
              ) : (
                <span className="whitespace-pre-line">{field.text}</span>
              )}
            </KeyValueRow>
          ))}
        </KeyValue>
      )}
    </div>
  );
}
