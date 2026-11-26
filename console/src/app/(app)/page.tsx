import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { ring } from "@/components/ui/ring";
import { requireViewer } from "@/lib/server/session";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Your businesses" };

/** Home: straight to the person's team when they have one business; a choice when they have several. */
export default async function Home() {
  const viewer = await requireViewer("/");
  if (viewer.clients.length === 1) redirect(`/c/${viewer.clients[0].id}`);
  // an Northlight admin with no employee of their own manages people
  if (!viewer.clients.length) redirect("/people");
  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="text-display text-ink">Your businesses</h1>
        <p className="text-body text-ink-2">Choose whose team to open.</p>
      </header>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {viewer.clients.map(client => (
          <li key={client.id}>
            <Link href={`/c/${client.id}`} className={`flex items-center justify-between gap-3 rounded-lg border border-rule bg-card p-6 transition-colors hover:border-rule-strong ${ring}`}>
              <span className="text-title text-ink">{client.name}</span>
              <ChevronRight className="size-4 text-ink-3" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
