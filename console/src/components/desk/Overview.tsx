import { ExternalLink, Inbox } from "lucide-react";
import { LoadFailed } from "@/components/LoadFailed";
import { WorkList } from "@/components/WorkList";
import { Section, card } from "@/components/ui/Card";
import { KeyValue, KeyValueRow } from "@/components/ui/KeyValue";
import { EmptyState, Notice } from "@/components/ui/Notice";
import type { AgentData, AgentSummary, Card } from "@/lib/brain-types";
import { count } from "@/lib/employee";
import { formatAgo, formatFull } from "@/lib/format";
import { httpUrl } from "@/lib/preview";
import type { Part } from "@/lib/server/workspace";
import { TabButton } from "./Desk";
import { WebsitePanel, type WebsiteChange } from "./WebsitePanel";

/*
 The Overview: what waits on the person, what the employee last saw (the data its tools saved, for the kinds this app
 knows how to show), then its latest work. Saved data says when it was saved, because it can be old.
*/
export function Overview({ agent, clientId, decisions, data, work, site, canPublish }: { agent: AgentSummary; clientId: string; decisions: number; data: Part<AgentData>; work: Part<Card[]>; site?: string; canPublish: boolean }) {
  const snapshots = data.ok ? data.value.snapshots : {};
  return (
    <div className="flex flex-col gap-10">
      {decisions > 0 && (
        <Notice tone="warn" banner action={<TabButton tab="requests">Review {decisions === 1 ? "it" : "them"}</TabButton>}>
          {count(decisions, "request")} from {agent.name} {decisions === 1 ? "needs" : "need"} your decision.
        </Notice>
      )}
      {!data.ok && <LoadFailed title={`What ${agent.name} saved could not be loaded`} reason={data.error} />}
      {snapshots.homepage_seo && <PageCheck at={snapshots.homepage_seo.at} data={snapshots.homepage_seo.data} />}
      {agent.id === "iris" && site && data.ok && (
        <Section
          title="Website"
          meta={snapshots.site_copy && (snapshots.site_copy.data as { publishedAt?: number })?.publishedAt ? <Saved verb="Published" at={(snapshots.site_copy.data as { publishedAt: number }).publishedAt} /> : undefined}
        >
          <WebsitePanel clientId={clientId} agentId={agent.id} site={site} changes={websiteChanges(snapshots.site_copy?.data)} canPublish={canPublish} />
        </Section>
      )}
      <Section title="Latest work">
        {!work.ok ? (
          <LoadFailed title="Recent work could not be loaded" reason={work.error} />
        ) : work.value.length ? (
          <WorkList cards={work.value} agents={[agent]} clientId={clientId} showAgent={false} />
        ) : (
          <EmptyState icon={Inbox} title="No work yet">
            Reports, finished work and problems from {agent.name} show here, newest first.
          </EmptyState>
        )}
      </Section>
    </div>
  );
}

const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** "Checked 3 h ago", "Approved yesterday", "Approved on Sat", "Checked on Oct 30". */
function Saved({ verb, at }: { verb: string; at: number }) {
  const ago = formatAgo(at);
  const words = ago === "Just now" || ago === "Yesterday" ? ago.toLowerCase() : ago.endsWith("ago") ? ago : `on ${ago}`;
  return (
    <span>
      {verb}{" "}
      <time dateTime={new Date(at).toISOString()} title={formatFull(at)}>
        {words}
      </time>
    </span>
  );
}

function Wording({ text }: { text: string }) {
  return text ? (
    <span>
      {text} <span className="ml-1 font-mono text-meta whitespace-nowrap text-ink-3">{text.length} characters</span>
    </span>
  ) : (
    <span className="text-ink-3">None on the page</span>
  );
}

/** Iris's last look at the live homepage (review_site_page's saved result). */
function PageCheck({ at, data }: { at: number; data: unknown }) {
  const d = (data ?? {}) as Record<string, unknown>;
  const url = httpUrl(str(d.url));
  const headings = Array.isArray(d.h1) ? d.h1.map(str).filter(Boolean) : [];
  return (
    <Section title="Homepage, as last checked" meta={<Saved verb="Checked" at={at} />}>
      <div className={card}>
        <KeyValue>
          {url && (
            <KeyValueRow label="Page">
              <a href={url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1.5 break-all text-accent-text underline decoration-accent-text/40 underline-offset-4 hover:decoration-accent-text">
                {url}
                <ExternalLink className="size-3.5" aria-hidden="true" />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </KeyValueRow>
          )}
          <KeyValueRow label="Title">
            <Wording text={str(d.title)} />
          </KeyValueRow>
          <KeyValueRow label="Meta description">
            <Wording text={str(d.description)} />
          </KeyValueRow>
          <KeyValueRow label={headings.length > 1 ? "Main headings" : "Main heading"}>
            {headings.length ? headings.join(" · ") : <span className="text-ink-3">None on the page</span>}
          </KeyValueRow>
        </KeyValue>
      </div>
    </Section>
  );
}

/** The website's waiting changes (the site_copy snapshot: Live, and approved changes on Preview), newest first. */
function websiteChanges(data: unknown): WebsiteChange[] {
  const pending = ((data ?? {}) as { pending?: Record<string, Record<string, { text?: unknown; replaces?: unknown; approvedAt?: unknown }>> }).pending ?? {};
  return Object.entries(pending)
    .flatMap(([path, fields]) => Object.entries(fields ?? {}).map(([field, change]) => ({ path, field, text: str(change?.text), replaces: str(change?.replaces), at: Number(change?.approvedAt) || 0 })))
    .filter(change => change.text && (change.field === "title" || change.field === "description"))
    .sort((a, b) => b.at - a.at)
    .map(({ path, field, text, replaces }) => ({ path, field, text, replaces }));
}
