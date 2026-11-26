import type { Metadata } from "next";
import { CircleCheck, Inbox } from "lucide-react";
import { LoadFailed } from "@/components/LoadFailed";
import { NeedsYouList } from "@/components/NeedsYouList";
import { TeamOrbit } from "@/components/TeamOrbit";
import { WorkList } from "@/components/WorkList";
import { Section } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/Notice";
import { count, employeeState } from "@/lib/employee";
import { decisionRight } from "@/lib/requests";
import { requireClient, requireViewer } from "@/lib/server/session";
import { loadTeam } from "@/lib/server/workspace";

export const metadata: Metadata = { title: "Your team" };

/*
 The team page answers the design's one question: what did my team do, and what needs me? The orbit shows who is on the
 team and how each is doing; beside it, the requests that wait on a decision, then the latest work.
*/
export default async function TeamPage({ params }: { params: Promise<{ client: string }> }) {
  const { client: clientId } = await params;
  const viewer = await requireViewer(`/c/${clientId}`);
  const client = requireClient(viewer, clientId);
  const team = await loadTeam(viewer, client);
  const agents = team.agents.ok ? team.agents.value : [];
  const requests = team.requests.ok ? team.requests.value : [];
  const decisions = requests.filter(r => decisionRight(r, client.id, viewer) === "decide");
  const states = Object.fromEntries(agents.map(a => [a.id, employeeState(a, decisions.filter(r => r.agent === a.id).length)]));

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-display text-balance text-ink">Your team</h1>
        <p className="text-body text-ink-2">
          {client.name}
          {team.agents.ok && ` · ${count(agents.length, "AI employee")}`}
          {team.requests.ok && ` · ${decisions.length ? `${count(decisions.length, "request")} ${decisions.length === 1 ? "needs" : "need"} you` : "nothing needs you"}`}
        </p>
        {client.site && (
          <a href={client.site} target="_blank" rel="noopener noreferrer" className="self-start text-small font-medium text-ink underline">
            Visit the {client.name} website<span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
      </header>

      <div className="grid items-start gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,25rem)_minmax(0,1fr)]">
        <div className="lg:sticky lg:top-24">
          {!team.agents.ok ? (
            <LoadFailed title="Your team could not be loaded" reason={team.agents.error} />
          ) : agents.length ? (
            <TeamOrbit clientId={client.id} agents={agents} states={states} />
          ) : (
            <EmptyState icon={Inbox} title="No AI employees here yet">
              Once Northlight sets up an employee for {client.name} and gives you access, it appears here.
            </EmptyState>
          )}
        </div>

        <div className="flex flex-col gap-10">
          <Section title="Needs you" meta={team.requests.ok && requests.length ? count(requests.length, "request") : undefined}>
            {!team.requests.ok ? (
              <LoadFailed title="Requests could not be loaded" reason={team.requests.error} />
            ) : requests.length ? (
              <NeedsYouList requests={requests} agents={agents} clientId={client.id} who={viewer} names={team.names} />
            ) : (
              <EmptyState icon={CircleCheck} title="Nothing needs you right now">
                When an employee asks you to decide something, it shows here.
              </EmptyState>
            )}
          </Section>

          <Section title="Recent work">
            {!team.work.ok ? (
              <LoadFailed title="Recent work could not be loaded" reason={team.work.error} />
            ) : team.work.value.length ? (
              <WorkList cards={team.work.value} agents={agents} clientId={client.id} />
            ) : (
              <EmptyState icon={Inbox} title="No work yet">
                Reports, finished work and problems from your employees show here, newest first.
              </EmptyState>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
