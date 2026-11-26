import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { browserCallsOn } from "@/lib/server/iris-voice";
import { requireAgent, requireViewer } from "@/lib/server/session";
import { VoiceCall } from "./VoiceCall";

export const metadata: Metadata = { title: "Talk to Iris" };

/** A browser call with Iris, for staff who may use Iris, when browser calls are switched on. */
export default async function TalkPage({ params }: { params: Promise<{ client: string; agent: string }> }) {
  const { client, agent } = await params;
  const desk = "/c/" + encodeURIComponent(client) + "/" + encodeURIComponent(agent);
  const viewer = await requireViewer(desk + "/talk");
  requireAgent(viewer, client, agent);
  if (client !== "kestrel" || agent !== "iris" || !browserCallsOn()) notFound();
  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <Link href={desk} className="self-start text-small font-medium text-ink underline">Back to Iris</Link>
      <header className="flex flex-col gap-2">
        <h1 className="text-display text-ink">Talk to Iris</h1>
        <p className="max-w-[60ch] text-ink-2">
          Speak to Iris through your microphone. Ask about a page, its title or description, or how the site is doing.
          Iris reads a change back before filing it, and anything that changes the site still waits for approval on the desk.
        </p>
        <p className="text-small text-ink-2">A call ends after 5 minutes. Use headphones if Iris hears itself.</p>
      </header>
      <VoiceCall client={client} agent={agent} historyHref={desk + "/calls"} />
    </section>
  );
}
