"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ExternalLink } from "lucide-react";
import { siteCopyAction } from "@/app/(app)/c/[client]/[agent]/actions";
import { announce } from "@/components/ui/Announcer";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { card } from "@/components/ui/Card";

export type WebsiteChange = { path: string; field: string; text: string; replaces: string };

/*
 The website's two states. Approved wording goes to Preview first; Publish puts every waiting change Live at once, and
 Discard drops them. Only people who approve the employee's requests (or an admin) see the buttons.
*/
export function WebsitePanel({ clientId, agentId, site, changes, canPublish }: { clientId: string; agentId: string; site: string; changes: WebsiteChange[]; canPublish: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<"publish" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preview = new URL("?preview=1", site).href;
  const live = new URL("?preview=0", site).href;

  function act(action: "publish" | "discard") {
    setError(null);
    setBusy(action);
    start(async () => {
      try {
        const result = await siteCopyAction(clientId, agentId, action);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        announce(action === "publish" ? "Published. The live site now shows these changes." : "Discarded. Preview matches the live site again.");
        router.refresh();
      } catch {
        setError("Connection interrupted. Reconnect and try again.");
      } finally {
        setBusy(null);
      }
    });
  }

  return (
    <div className={`flex flex-col gap-4 ${card}`}>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <SiteLink href={live}>Live site</SiteLink>
        <SiteLink href={preview}>Preview</SiteLink>
      </div>
      {changes.length ? (
        <>
          <p className="text-body text-ink">
            {changes.length === 1 ? "1 approved change is" : `${changes.length} approved changes are`} on Preview, not live yet.
          </p>
          <ul className="flex flex-col gap-3">
            {changes.map(change => (
              <li key={`${change.path} ${change.field}`} className="rounded-lg border border-rule p-3">
                <p className="text-label text-ink-2">
                  {change.field === "title" ? "Page title" : "Meta description"} · <span className="font-mono">{change.path}</span>
                </p>
                <p className="mt-1 text-body text-ink">{change.text}</p>
                {change.replaces && <p className="mt-1 text-small text-ink-3">Replaces: {change.replaces}</p>}
              </li>
            ))}
          </ul>
          {error && <Notice tone="danger">{error}</Notice>}
          {canPublish ? (
            <div className="flex flex-wrap gap-3">
              <Button variant="primary" onClick={() => act("publish")} busy={pending && busy === "publish"} busyLabel="Publishing" disabled={pending}>
                Publish to live
              </Button>
              <Button variant="ghost" onClick={() => act("discard")} busy={pending && busy === "discard"} busyLabel="Discarding" disabled={pending}>
                Discard changes
              </Button>
            </div>
          ) : (
            <p className="text-small text-ink-2">Someone who approves this employee&apos;s requests can publish them.</p>
          )}
        </>
      ) : (
        <p className="text-small text-ink-2">Nothing waiting. Approved page titles and descriptions show on Preview first, then go live when someone publishes them.</p>
      )}
    </div>
  );
}

function SiteLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-body font-medium text-accent-text underline decoration-accent-text/40 underline-offset-4 hover:decoration-accent-text">
      {children}
      <ExternalLink className="size-3.5" aria-hidden="true" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
