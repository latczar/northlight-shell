import { irisLine } from "@/lib/server/iris-calls.mjs";
import { historyCaller } from "@/lib/server/pilot-call-access";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LoadFailed } from "@/components/LoadFailed";
import { Desk, type DeskTab } from "@/components/desk/Desk";
import { LearnedPanel } from "@/components/desk/LearnedPanel";
import { Overview } from "@/components/desk/Overview";
import { RequestsPanel } from "@/components/desk/RequestsPanel";
import { SetupPanel } from "@/components/desk/SetupPanel";
import { canApproveAgent, canSeeClient, canUseAgent } from "@/lib/access";
import { employeeState } from "@/lib/employee";
import { decisionRight } from "@/lib/requests";
import { listAgents } from "@/lib/server/brain";
import { lookupViewer, requireAgent, requireViewer } from "@/lib/server/session";
import { loadDesk } from "@/lib/server/workspace";

const TABS: DeskTab[] = ["overview", "requests", "setup", "learned"];

/** The employee's name in the browser tab, only for someone who may use the employee (the same check as the page). */
export async function generateMetadata({ params }: { params: Promise<{ client: string; agent: string }> }): Promise<Metadata> {
  const { client: clientId, agent: agentId } = await params;
  const found = await lookupViewer();
  if (found.state !== "ok" || !canSeeClient(found.viewer.access, found.viewer.clients, clientId) || !canUseAgent(found.viewer.access, clientId, agentId)) return {};
  const agent = await listAgents(clientId).then(list => list.find(a => a.id === agentId), () => undefined);
  return agent ? { title: agent.name } : {};
}

/** An employee's desk: what it did, what waits on the person, what it needs and what it learned, and the chat. */
export default async function DeskPage({ params, searchParams }: { params: Promise<{ client: string; agent: string }>; searchParams: Promise<{ tab?: string; chat?: string }> }) {
  const { client: clientId, agent: agentId } = await params;
  const query = await searchParams;
  const viewer = await requireViewer(`/c/${clientId}/${agentId}`);
  const client = requireAgent(viewer, clientId, agentId);
  const desk = await loadDesk(viewer, client, agentId);

  if (!desk.agent.ok) return <LoadFailed title="This employee's desk could not be loaded" reason={desk.agent.error} />;
  const agent = desk.agent.value;
  if (!agent) notFound();

  const pending = desk.pending.ok ? desk.pending.value : [];
  const decisions = pending.filter(r => decisionRight(r, client.id, viewer) === "decide").length;
  const canDecideLessons = canApproveAgent(viewer.access, client.id, agent.id);
  const proposedLessons = canDecideLessons && desk.lessons.ok ? desk.lessons.value.filter(l => l.status === "proposed").length : 0;
  const initialTab = TABS.find(t => t === query.tab) ?? "overview";

  return (
    <Desk
      clientId={client.id}
      clientName={client.name}
      agent={{ id: agent.id, name: agent.name, role: agent.role }}
      state={employeeState(agent, decisions)}
      decisions={decisions}
      proposedLessons={proposedLessons}
      setupReady={!desk.setup.ok || desk.setup.value.ready}
      pilotLine={historyCaller(viewer.email, client.id, agent.id, viewer.userId) ? irisLine() : null}
      initialTab={initialTab}
      initialChat={query.chat === "1"}
      panels={{
        overview: <Overview agent={agent} clientId={client.id} decisions={decisions} data={desk.data} work={desk.work} />,
        requests: <RequestsPanel pending={desk.pending} decided={desk.decided} clientId={client.id} agentName={agent.name} who={viewer} names={desk.names} />,
        setup: <SetupPanel setup={desk.setup} agentName={agent.name} admin={viewer.admin} />,
        learned: <LearnedPanel lessons={desk.lessons} clientId={client.id} agentId={agent.id} agentName={agent.name} canDecide={canDecideLessons} />,
      }}
    />
  );
}
