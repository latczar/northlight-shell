import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { AgentSummary, Approval } from "@/lib/brain-types";
import { formatAgo, formatFull } from "@/lib/format";
import { askedBy, decisionRight, type Who } from "@/lib/requests";
import { Avatar } from "./Avatar";
import { Status } from "@/components/ui/Status";
import { ring } from "@/components/ui/ring";

/** Requests waiting on a decision, each opening its employee's Requests tab at that request. */
export function NeedsYouList({ requests, agents, clientId, who, names }: { requests: Approval[]; agents: AgentSummary[]; clientId: string; who: Who; names: Record<string, string> }) {
  const byId = Object.fromEntries(agents.map(a => [a.id, a]));
  return (
    <ul className="flex flex-col divide-y divide-rule rounded-lg border border-rule bg-card">
      {requests.map(request => {
        const agent = byId[request.agent];
        const right = decisionRight(request, clientId, who);
        const status = (className: string) => (
          <Status tone={right === "decide" ? "attention" : "quiet"} className={className}>
            {right === "decide" ? "Needs your decision" : "Waiting for an Northlight admin"}
          </Status>
        );
        return (
          <li key={request.id}>
            <Link
              href={`/c/${clientId}/${request.agent}?tab=requests#request-${request.id}`}
              className={`flex items-center gap-3 rounded-lg px-4 py-3 transition-colors hover:bg-ink/[0.03] md:px-5 ${ring}`}
            >
              <Avatar name={agent?.name ?? request.agent} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="text-title text-pretty text-ink">{request.title}</p>
                <p className="text-meta text-ink-3">
                  {agent?.name ?? request.agent} · {askedBy(request, who, names)} ·{" "}
                  <time dateTime={new Date(request.createdAt).toISOString()} title={formatFull(request.createdAt)}>
                    {formatAgo(request.createdAt)}
                  </time>
                </p>
                {status("mt-1 sm:hidden")}
              </div>
              {status("shrink-0 max-sm:hidden")}
              <ChevronRight className="size-4 shrink-0 text-ink-3" aria-hidden="true" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
