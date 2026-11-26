import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, Info, RotateCw, TriangleAlert, type LucideIcon } from "lucide-react";
import { Button } from "./Button";

/*
 Messages in three sizes. Notice is a line or a banner about one thing (role alert for an error, status otherwise).
 EmptyState fills a list that has nothing yet and says what will appear there; ErrorState fills one that failed to load,
 with Try again, so an outage never looks like an empty list. Bad news follows DESIGN.md: what happened, then what happens
 next, in plain sentences. No "use client": server pages pass EmptyState an icon component, which can't cross into a
 client module; ErrorState's onRetry only ever comes from a client component.
*/

export type NoticeTone = "info" | "ok" | "warn" | "danger";

const ICON: Record<NoticeTone, LucideIcon> = { info: Info, ok: CircleCheck, warn: TriangleAlert, danger: CircleAlert };
const TEXT: Record<NoticeTone, string> = { info: "text-ink-2", ok: "text-ok", warn: "text-warn", danger: "text-danger" };
const BANNER: Record<NoticeTone, string> = {
  info: "border-rule bg-inset",
  ok: "border-ok/40 bg-ok/6",
  warn: "border-warn/40 bg-warn-dot/10",
  danger: "border-danger/40 bg-danger/6",
};

export function Notice({
  tone,
  banner,
  title,
  action,
  className = "",
  children,
}: {
  tone: NoticeTone;
  banner?: boolean;
  title?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const Icon = ICON[tone];
  const role = tone === "danger" ? "alert" : "status";
  if (!banner) {
    return (
      <div role={role} className={`flex items-start gap-2 text-small font-medium ${TEXT[tone]} ${className}`}>
        <span className="inline-flex h-lh shrink-0 items-center">
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">{children}</div>
      </div>
    );
  }
  return (
    <div role={role} className={`rounded-lg border px-4 py-3 text-small text-ink ${BANNER[tone]} ${className}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-60 items-start gap-3">
          <span className={`inline-flex h-lh shrink-0 items-center ${TEXT[tone]}`}>
            <Icon className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            {title && <p className="font-semibold">{title}</p>}
            <div className="max-w-[60ch] text-pretty">{children}</div>
          </div>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </div>
  );
}

export function EmptyState({ icon: Icon, title, action, className = "", children }: { icon: LucideIcon; title: ReactNode; action?: ReactNode; className?: string; children?: ReactNode }) {
  return (
    <div className={`flex items-start gap-3 rounded-lg border border-dashed border-rule-strong/60 p-5 ${className}`}>
      <span className="flex h-6 shrink-0 items-center">
        <Icon className="size-5 text-ink-3" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className="text-title text-pretty text-ink">{title}</p>
        {children && <p className="mt-1 max-w-[60ch] text-small text-pretty text-ink-2">{children}</p>}
        {action && <div className="mt-4">{action}</div>}
      </div>
    </div>
  );
}

export function ErrorState({ title, onRetry, busy, className = "", children }: { title: ReactNode; onRetry?: () => void; busy?: boolean; className?: string; children?: ReactNode }) {
  return (
    <div role="alert" className={`flex items-start gap-3 rounded-lg border border-danger/40 bg-danger/6 p-5 ${className}`}>
      <span className="flex h-6 shrink-0 items-center">
        <CircleAlert className="size-5 text-danger" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className="text-title text-pretty text-ink">{title}</p>
        {children && <p className="mt-1 max-w-[60ch] text-small text-pretty text-ink">{children}</p>}
        {onRetry && (
          <div className="mt-4">
            <Button size="sm" icon={<RotateCw aria-hidden="true" />} busy={busy} busyLabel="Trying again" onClick={onRetry}>
              Try again
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
