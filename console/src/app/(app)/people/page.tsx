import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Building2 } from "lucide-react";
import { LoadFailed } from "@/components/LoadFailed";
import { PeopleManager } from "@/components/people/PeopleManager";
import { EmptyState } from "@/components/ui/Notice";
import { ring } from "@/components/ui/ring";
import { BrainError, readAgents } from "@/lib/server/brain";
import { configuredClients } from "@/lib/server/config";
import { listPeople, PeopleError, syncState } from "@/lib/server/people";
import { requireViewer } from "@/lib/server/session";

export const metadata: Metadata = { title: "People" };

async function settle<T>(work: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await work };
  } catch (error) {
    return { ok: false, error: error instanceof BrainError || error instanceof PeopleError ? error.message : "This could not be read. Try again." };
  }
}

/** Northlight admins only: who may use, approve and manage each AI employee of a business. Anyone else gets 404. */
export default async function PeoplePage({ searchParams }: { searchParams: Promise<{ client?: string }> }) {
  const viewer = await requireViewer("/people");
  if (!viewer.admin) notFound();
  const clients = configuredClients();
  const wanted = (await searchParams).client;
  const client = clients.find(c => c.id === wanted) ?? clients[0];
  if (!client) {
    return (
      <EmptyState icon={Building2} title="No business is set up in this app yet">
        Add businesses to AGENT_CLIENTS in the app&apos;s settings.
      </EmptyState>
    );
  }
  const [agents, people, sync] = await Promise.all([settle(readAgents(client.id)), settle(listPeople(client.id)), settle(syncState(client.id))]);
  const host = (await headers()).get("host") ?? "";
  const signIn = `${host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https"}://${host}/sign-in`;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-display text-ink">People</h1>
        <p className="max-w-[65ch] text-body text-pretty text-ink-2">Who may use each AI employee, approve what it asks to do, and manage it.</p>
      </header>
      {clients.length > 1 && (
        <nav aria-label="Businesses" className="flex flex-wrap gap-2">
          {clients.map(c => (
            <Link
              key={c.id}
              href={`/people?client=${c.id}`}
              aria-current={c.id === client.id ? "page" : undefined}
              className={`inline-flex h-9 items-center rounded-full border px-4 text-small font-medium pointer-coarse:h-11 ${ring} ${c.id === client.id ? "border-rule-strong bg-card text-ink" : "border-transparent text-ink-2 hover:bg-ink/5 hover:text-ink"}`}
            >
              {c.name}
            </Link>
          ))}
        </nav>
      )}
      {!agents.ok ? (
        <LoadFailed title={`${client.name}'s employees could not be read`} reason={agents.error} />
      ) : !people.ok ? (
        <LoadFailed title="The people could not be read" reason={people.error} />
      ) : (
        <PeopleManager
          key={client.id}
          clientId={client.id}
          clientName={client.name}
          agents={agents.value.map(a => ({ id: a.id, name: a.name }))}
          people={people.value}
          sync={sync.ok ? sync.value : null}
          syncError={sync.ok ? null : sync.error}
          signInAddress={signIn}
          selfId={viewer.userId}
        />
      )}
    </div>
  );
}
