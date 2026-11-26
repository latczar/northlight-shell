import Link from "next/link";
import type { AgentSummary } from "@/lib/brain-types";
import type { Tone } from "@/components/ui/Status";
import { Status } from "@/components/ui/Status";
import { ring } from "@/components/ui/ring";
import { NorthlightMark } from "./NorthlightMark";
import { Orbit, seatPosition } from "./Orbit";
import { Avatar } from "./Avatar";

/*
 The team page's centrepiece, the Northlight mark made literal: the business is the ring, its AI employees sit on the outer
 orbit, and the spark (you) steps round the mark in the middle. Each seat opens that employee's desk. A seat's words sit
 outward from the centre, so no text crosses the rings or the mark.
*/
export function TeamOrbit({ clientId, agents, states }: { clientId: string; agents: AgentSummary[]; states: Record<string, { tone: Tone; word: string }> }) {
  return (
    // top room for the first seat's words, which sit above it; the orbit stays smaller on a phone so the requests come sooner
    <div className="px-10 pt-32 pb-10 sm:px-16 sm:pb-14">
      <Orbit className="mx-auto w-full max-w-[16rem] sm:max-w-[22rem]">
        <div aria-hidden="true" className="absolute inset-0 grid place-items-center">
          <NorthlightMark size={96} stepping className="w-[30%] h-auto" />
        </div>
        <ul aria-label="Your AI employees" className="absolute inset-0">
          {agents.map((agent, i) => {
            const at = seatPosition(i, agents.length);
            const a = -Math.PI / 2 + (i * Math.PI * 2) / agents.length;
            const [x, y] = [Math.cos(a), Math.sin(a)];
            const state = states[agent.id];
            return (
              <li key={agent.id} className="absolute" style={at}>
                <Link
                  href={`/c/${clientId}/${agent.id}`}
                  className={`group absolute -translate-1/2 rounded-full ${ring}`}
                  aria-label={`${agent.name}, ${agent.role}. ${state.word}.`}
                >
                  <Avatar
                    name={agent.name}
                    size="xl"
                    className="ring-8 ring-tint transition-[scale,box-shadow] duration-200 group-hover:ring-spark/25 motion-safe:group-hover:scale-[1.06] motion-safe:group-active:scale-[.98]"
                  />
                  <span
                    aria-hidden="true"
                    className="absolute flex w-max max-w-[11rem] flex-col items-center gap-0.5 text-center"
                    style={{ left: `calc(50% + ${x * 44}px)`, top: `calc(50% + ${y * 44}px)`, translate: `calc(-50% + ${x * 50}%) calc(-50% + ${y * 50}%)` }}
                  >
                    <span className="text-title text-ink group-hover:text-accent-text">{agent.name}</span>
                    <span className="text-label text-balance text-ink-2">{agent.role}</span>
                    <Status tone={state.tone} className="mt-0.5">{state.word}</Status>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </Orbit>
    </div>
  );
}
