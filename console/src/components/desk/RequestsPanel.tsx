import { CircleCheck } from "lucide-react";
import { LoadFailed } from "@/components/LoadFailed";
import { Section } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/Notice";
import { askedBy, canAskForRevision, copyDraft, decisionRight, type Who } from "@/lib/requests";
import type { Part } from "@/lib/server/workspace";
import type { Approval } from "@/lib/brain-types";
import { RequestCard } from "./RequestCard";

/** Waiting requests first (the person's decision), then the ones decided lately. Only the person's own, or all for admins. */
export function RequestsPanel({ pending, decided, clientId, agentName, who, names }: { pending: Part<Approval[]>; decided: Part<Approval[]>; clientId: string; agentName: string; who: Who; names: Record<string, string> }) {
  // a declined draft that already has its new draft offers no second one (the brain would hand back the same one)
  const revised = new Set([...(pending.ok ? pending.value : []), ...(decided.ok ? decided.value : [])].map(r => r.preview?.revisionOf));
  const card = (request: Approval) => (
    <RequestCard
      key={request.id}
      request={request}
      clientId={clientId}
      agentName={agentName}
      askedBy={askedBy(request, who, names)}
      right={decisionRight(request, clientId, who)}
      canRevise={canAskForRevision(request, clientId, who) && !revised.has(request.id)}
      draft={copyDraft(request)}
    />
  );
  return (
    <div className="flex flex-col gap-10">
      <Section title="Waiting for a decision">
        {!pending.ok ? (
          <LoadFailed title="Requests could not be loaded" reason={pending.error} />
        ) : pending.value.length ? (
          <div className="flex flex-col gap-4">{pending.value.map(card)}</div>
        ) : (
          <EmptyState icon={CircleCheck} title="Nothing waits for a decision">
            When {agentName} asks before doing something, the request shows here with Approve and Decline.
          </EmptyState>
        )}
      </Section>
      {(!decided.ok || decided.value.length > 0) && (
        <Section title="Decided lately">
          {!decided.ok ? <LoadFailed title="Decided requests could not be loaded" reason={decided.error} /> : <div className="flex flex-col gap-4">{decided.value.map(card)}</div>}
        </Section>
      )}
    </div>
  );
}
