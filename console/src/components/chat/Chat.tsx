"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Check, CircleAlert, Circle, X } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { Markdown } from "@/components/Markdown";
import { announce } from "@/components/ui/Announcer";
import { Button, IconButton } from "@/components/ui/Button";
import { ErrorState, Notice } from "@/components/ui/Notice";
import { LiveDot } from "@/components/ui/Status";
import { SkeletonLine } from "@/components/ui/Skeleton";
import { ring } from "@/components/ui/ring";
import type { ChatLine, Job } from "@/lib/brain-types";
import { formatElapsed, isActive, watchJob, type JobWatcher } from "@/lib/job";
import { freshenDesk } from "@/app/(app)/c/[client]/[agent]/actions";

const MAX_TEXT = 8000;

/*
 The chat with one employee. A message becomes a background job in the agent: this panel shows the person's line at
 once, then follows the job (its real steps, as the brain reports them) until it is done, asks for a decision or fails,
 and pulls in the employee's reply. Nothing here claims progress the brain did not report. The panel stays mounted while
 closed, so a draft survives; the conversation is the person's own (web-<their id>), shared with nobody.
*/
export function Chat({
  clientId,
  agentId,
  agentName,
  open,
  onClose,
  onJob,
  onOpenRequests,
}: {
  clientId: string;
  agentId: string;
  agentName: string;
  open: boolean;
  onClose: () => void;
  onJob: (job: Job | null) => void;
  onOpenRequests: () => void;
}) {
  const base = `/api/c/${encodeURIComponent(clientId)}/agents/${encodeURIComponent(agentId)}`;
  const router = useRouter();
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState<"first" | "older" | null>("first");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [outgoing, setOutgoing] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [trouble, setTrouble] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const retry = useRef<{ id: string; text: string } | null>(null);
  const watcher = useRef<JobWatcher | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);

  const readJson = async (path: string) => {
    const response = await fetch(`${base}${path}`, { cache: "no-store" });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "Northlight's service did not answer.");
    return body;
  };

  // The newest page, merged under what is already shown (older pages loaded on demand stay). Reading it also ends a
  // failed first load.
  const showLatest = (body: { messages: ChatLine[]; more: boolean }) => {
    setLines(shown => {
      const first = body.messages[0]?.seq ?? Infinity;
      return [...shown.filter(l => l.seq < first), ...body.messages];
    });
    setMore(m => m || body.more);
    setLoadError(null);
  };
  const fetchLatest = async () => showLatest(await readJson("/messages"));
  const loadFailed = (error: unknown) => setLoadError(error instanceof Error ? error.message : "The conversation could not be loaded.");
  function loadAgain() {
    setLoading("first");
    fetchLatest().catch(loadFailed).finally(() => setLoading(null));
  }

  useEffect(() => {
    const w = watchJob({
      fetchJob: async () => (await readJson("/job") as { job: Job | null }).job,
      fetchMessages: fetchLatest,
      onJob: next => {
        setJob(next);
        onJob(next);
      },
      onEvent: (event, next) => {
        // the cached lists predate the new request or work; drop them, then redraw the desk
        freshenDesk(clientId, agentId).finally(() => router.refresh());
        if (event === "approval") announce(`${agentName} is waiting for a decision.`);
        else announce(next.status === "done" ? `${agentName} finished.` : `${agentName} could not finish.`);
      },
      onTrouble: setTrouble,
      isHidden: () => document.hidden,
    });
    watcher.current = w;
    readJson("/messages").then(showLatest).catch(loadFailed).finally(() => setLoading(null));
    w.start();
    const resume = () => w.visibilityChanged();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    return () => {
      w.stop();
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one watcher for the panel's life
  }, []);

  // the job's clock, only while it runs
  useEffect(() => {
    if (!isActive(job)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [job]);

  // newest line in view: on opening (a hidden pane cannot scroll), and on new lines while the person is at the bottom
  useEffect(() => {
    if (!open) return;
    stick.current = true;
    requestAnimationFrame(() => {
      log.current?.scrollTo({ top: log.current.scrollHeight });
      composer.current?.focus();
    });
  }, [open]);
  useEffect(() => {
    if (stick.current) log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [lines, job, outgoing]);

  async function olderLines() {
    if (!lines.length) return;
    setLoading("older");
    setOlderError(null);
    const keep = log.current ? log.current.scrollHeight - log.current.scrollTop : 0;
    try {
      const body = await readJson(`/messages?before=${lines[0].seq}`) as { messages: ChatLine[]; more: boolean };
      setLines(shown => [...body.messages, ...shown]);
      setMore(body.more);
      // keep the line the person was reading where it was
      requestAnimationFrame(() => log.current && (log.current.scrollTop = log.current.scrollHeight - keep));
    } catch (error) {
      setOlderError(error instanceof Error ? error.message : "Earlier messages could not be loaded.");
    } finally {
      setLoading(null);
    }
  }

  async function send() {
    const text = draft.trim();
    if (!text || outgoing) return;
    if (text.length > MAX_TEXT) {
      setSendError(`The message is too long: ${text.length.toLocaleString("en-GB")} of ${MAX_TEXT.toLocaleString("en-GB")} characters.`);
      return;
    }
    // A retry of the same words reuses their id, so a message that did arrive is never sent twice.
    const id = retry.current?.text === text ? retry.current.id : crypto.randomUUID();
    retry.current = { id, text };
    setOutgoing(text);
    setSendError(null);
    setDraft("");
    stick.current = true;
    try {
      const response = await fetch(`${base}/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, text }) });
      const body = await response.json().catch(() => null) as { job?: Job; error?: string } | null;
      if (!response.ok || !body?.job) throw new Error(body?.error ?? "Your message did not reach Northlight. Try again.");
      retry.current = null;
      setJob(body.job);
      onJob(body.job);
      await fetchLatest().catch(() => undefined);
      watcher.current?.start(body.job);
    } catch (error) {
      setDraft(current => current || text);
      setSendError(error instanceof Error ? error.message : "Your message did not reach Northlight. Try again.");
    } finally {
      setOutgoing(null);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  const active = isActive(job);
  const ended = job && !active && (job.status === "failed" || job.status === "stopped") ? job : null;

  return (
    <section
      aria-label={`Chat with ${agentName}`}
      onKeyDown={e => e.key === "Escape" && onClose()}
      className="flex h-full flex-col overflow-hidden border-rule bg-card lg:border-l xl:rounded-xl xl:border"
    >
      <header className="flex items-center gap-3 border-b border-rule px-4 py-3">
        <Avatar name={agentName} size="sm" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-title text-ink">{agentName}</h2>
          <p className="text-meta text-ink-3">Only you see this conversation here</p>
        </div>
        <IconButton label="Close the chat" onClick={onClose}>
          <X />
        </IconButton>
      </header>

      <div
        ref={log}
        onScroll={e => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className="relative flex-1 overflow-y-auto overscroll-contain px-4 py-4"
      >
        <div role="log" aria-label={`Messages with ${agentName}`} className="flex flex-col gap-4">
          {more && (
            <Button size="sm" variant="ghost" className="self-center" busy={loading === "older"} busyLabel="Loading" onClick={() => void olderLines()}>
              Show earlier messages
            </Button>
          )}
          {olderError && <Notice tone="danger">{`${olderError} Press Show earlier messages to try again.`}</Notice>}
          {loading === "first" && !loadError && (
            <div className="flex flex-col gap-3" aria-hidden="true">
              <SkeletonLine className="w-2/3" />
              <SkeletonLine className="w-1/2 self-end" />
              <SkeletonLine className="w-3/4" />
            </div>
          )}
          {loadError && (
            <ErrorState title="The conversation could not be loaded" onRetry={loadAgain} busy={loading === "first"}>
              {loadError}
            </ErrorState>
          )}
          {!loading && !loadError && !lines.length && !outgoing && (
            <p className="max-w-[40ch] self-center py-8 text-center text-small text-pretty text-ink-2">
              Ask {agentName} for something in plain words. It works in the background: you can close this and come back.
            </p>
          )}
          {lines.map(line => (
            <Bubble key={line.seq} mine={line.role === "user"} who={line.role === "user" ? "You" : agentName} text={line.text} />
          ))}
          {outgoing && <Bubble mine who="You" text={outgoing} sending />}
        </div>

        {/* not a live region: its clock ticks every second; approval and the end are announced on their own */}
        {(active || ended) && (
          <div className="mt-4 rounded-lg border border-rule bg-inset px-4 py-3">
            {active && job ? (
              <>
                <p className="flex items-center gap-2 text-small font-medium text-ink">
                  <LiveDot />
                  {job.status === "needs_approval" ? `${agentName} is waiting for a decision` : job.status === "waiting" ? `${agentName} will check back` : `${agentName} is working`}
                  <span className="ml-auto font-mono text-meta text-ink-3">{formatElapsed(now - job.startedAt)}</span>
                </p>
                {job.steps.length > 0 && (
                  <ol className="mt-2 flex flex-col gap-1">
                    {job.steps.map((step, i) => (
                      <li key={i} className={`flex items-start gap-2 text-small ${step.state === "pending" ? "text-ink-3" : "text-ink-2"}`}>
                        <span className="inline-flex h-lh items-center">
                          {step.state === "done" ? <Check className="size-4 text-ok" aria-hidden="true" /> : step.state === "failed" ? <CircleAlert className="size-4 text-danger" aria-hidden="true" /> : step.state === "active" ? <span className="grid size-4 place-items-center"><LiveDot /></span> : <Circle className="size-4" aria-hidden="true" />}
                        </span>
                        <span className={step.state === "active" ? "font-medium text-ink" : ""}>
                          {step.label}
                          <span className="sr-only">{{ done: ", done", failed: ", failed", active: ", now", pending: ", next" }[step.state]}</span>
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
                {job.current && !job.steps.some(s => s.state === "active" && s.label === job.current) && <p className="mt-2 text-small text-ink-2">{job.current}</p>}
                {job.status === "needs_approval" && (
                  <div className="mt-3">
                    <Button size="sm" variant="primary" onClick={onOpenRequests}>
                      Open the request
                    </Button>
                  </div>
                )}
                {job.queued > 0 && <p className="mt-2 text-small text-ink-2">{job.queued === 1 ? "1 more message waits its turn." : `${job.queued} more messages wait their turn.`}</p>}
              </>
            ) : (
              <Notice tone="danger">{ended?.error ?? `${agentName} could not finish. Ask again to retry.`}</Notice>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-rule px-4 pt-3 pb-4">
        {trouble && (
          <Notice tone="warn" className="mb-2">
            Northlight&apos;s service is not answering. The chat keeps trying.
          </Notice>
        )}
        {sendError && (
          <Notice tone="danger" className="mb-2">
            {sendError}
          </Notice>
        )}
        <form
          onSubmit={e => {
            e.preventDefault();
            void send();
          }}
          className="flex items-end gap-2"
        >
          <label htmlFor={`${agentId}-message`} className="sr-only">
            Message to {agentName}
          </label>
          <textarea
            ref={composer}
            id={`${agentId}-message`}
            rows={1}
            value={draft}
            maxLength={MAX_TEXT + 200}
            onChange={e => setDraft(e.target.value)}
            // while a message is on its way the box holds still, so a failed send can come back into it whole
            readOnly={Boolean(outgoing)}
            onKeyDown={onKeyDown}
            placeholder={active ? `Your message waits until ${agentName} finishes` : `Message ${agentName}`}
            className="field-sizing-content block max-h-40 min-h-11 w-full resize-none rounded-sm border border-rule-strong bg-inset px-3 py-2.5 text-body text-ink placeholder:text-ink-3 focus-visible:border-focus focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus"
          />
          <button
            type="submit"
            aria-label="Send"
            title="Send (Enter)"
            aria-disabled={!draft.trim() || Boolean(outgoing)}
            className={`grid size-11 shrink-0 place-items-center rounded-full bg-accent text-on-accent transition-colors hover:bg-accent-hover aria-disabled:cursor-not-allowed aria-disabled:bg-inset aria-disabled:text-ink-3 ${ring}`}
          >
            <ArrowUp className="size-5" aria-hidden="true" />
          </button>
        </form>
        <p className="mt-1.5 text-meta text-ink-3">Enter sends · Shift + Enter adds a line</p>
      </div>
    </section>
  );
}

function Bubble({ mine, who, text, sending }: { mine: boolean; who: string; text: string; sending?: boolean }) {
  return (
    <div className={`flex max-w-[92%] flex-col gap-1 ${mine ? "items-end self-end" : "items-start"}`}>
      <span className="text-label text-ink-3">
        {who}
        {sending && " · Sending"}
      </span>
      <div className={`rounded-xl px-3.5 py-2.5 text-small text-ink ${mine ? "rounded-tr-sm bg-tint" : "rounded-tl-sm border border-rule bg-card"} ${sending ? "opacity-70" : ""}`}>
        {mine ? <p className="whitespace-pre-wrap break-words">{text}</p> : <Markdown text={text} />}
      </div>
    </div>
  );
}
