import { CircleCheck, CircleDashed, CircleMinus } from "lucide-react";
import { LoadFailed } from "@/components/LoadFailed";
import { Section } from "@/components/ui/Card";
import { Notice } from "@/components/ui/Notice";
import type { AgentSetup } from "@/lib/brain-types";
import type { Part } from "@/lib/server/workspace";

/*
 What the employee needs to work, as Northlight's service reports it: each item, whether it is connected, and what it unlocks.
 Connections are set up by Northlight on the server; nothing here shows or asks for a key. Northlight admins also see the missing
 names, so they know what to set.
*/
export function SetupPanel({ setup, agentName, admin }: { setup: Part<AgentSetup>; agentName: string; admin: boolean }) {
  if (!setup.ok) return <LoadFailed title="Setup could not be loaded" reason={setup.error} />;
  const { ready, items } = setup.value;
  const blocking = items.filter(i => !i.connected && !i.optional);
  return (
    <div className="flex flex-col gap-6">
      <Notice tone={ready ? "ok" : "warn"} banner title={ready ? `${agentName} has what it needs` : `${agentName} cannot do all its work yet`}>
        {ready
          ? "Everything required is connected. Optional items add more work it can do."
          : `Missing: ${blocking.map(i => i.label).join(", ")}. Your Northlight contact sets these up.`}
      </Notice>
      <Section title="What it works with">
        <ul className="flex flex-col divide-y divide-rule rounded-lg border border-rule bg-card">
          {items.map(item => {
            const Icon = item.connected ? CircleCheck : item.optional ? CircleMinus : CircleDashed;
            const word = item.connected ? "Connected" : item.optional ? "Optional, not connected" : "Not connected";
            return (
              <li key={item.id} className="flex items-start gap-3 px-4 py-4 md:px-6">
                <span className="flex h-6 items-center">
                  <Icon className={`size-5 ${item.connected ? "text-ok" : item.optional ? "text-ink-3" : "text-warn"}`} aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-title text-ink">{item.label}</p>
                  <p className="text-small break-words text-ink-2">{item.unlocks}</p>
                  {!item.connected && admin && item.missing.length > 0 && (
                    <p className="mt-1 text-meta text-ink-3">
                      Missing {item.kind === "secret" ? "on the server" : "setting"}: <span className="font-mono break-all">{item.missing.join(", ")}</span>
                    </p>
                  )}
                </div>
                <span className="shrink-0 pt-0.5 text-label text-ink-2">{word}</span>
              </li>
            );
          })}
        </ul>
      </Section>
    </div>
  );
}
