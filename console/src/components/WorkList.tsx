import Link from "next/link";
import type { AgentSummary, Card } from "@/lib/brain-types";
import { workState } from "@/lib/employee";
import { formatAgo, formatFull } from "@/lib/format";
import { Status } from "@/components/ui/Status";
import { ring } from "@/components/ui/ring";

/*
 What the employees did, newest first, as a timeline: what kind of thing it was (a dot and a word), its title and summary,
 who did it and when. One rule between rows, no box per row.
*/
export function WorkList({ cards, agents, clientId, showAgent = true }: { cards: Card[]; agents: AgentSummary[]; clientId: string; showAgent?: boolean }) {
  const names = Object.fromEntries(agents.map(a => [a.id, a.name]));
  return (
    <ol className="flex flex-col divide-y divide-rule rounded-lg border border-rule bg-card">
      {cards.map(card => {
        const state = workState(card);
        const body = (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Status tone={state.tone}>{state.word}</Status>
              <span className="ml-auto text-meta text-ink-3">
                {showAgent && names[card.agent] ? `${names[card.agent]} · ` : ""}
                <time dateTime={new Date(card.updatedAt).toISOString()} title={formatFull(card.updatedAt)}>
                  {formatAgo(card.updatedAt)}
                </time>
              </span>
            </div>
            <p className="mt-1 text-title text-pretty text-ink">{state.title}</p>
            {card.summary && <p className="mt-0.5 line-clamp-3 max-w-[65ch] text-small text-pretty text-ink-2">{card.summary}</p>}
          </>
        );
        return (
          <li key={card.id}>
            {showAgent ? (
              <Link href={`/c/${clientId}/${card.agent}`} className={`block rounded-lg px-4 py-3 transition-colors hover:bg-ink/[0.03] md:px-5 ${ring}`}>
                {body}
              </Link>
            ) : (
              <div className="px-4 py-3 md:px-5">{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
