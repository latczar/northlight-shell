"use client";

import { MessageCircle } from "lucide-react";
import { Orbit } from "@/components/Orbit";
import { StateDot, type Tone } from "@/components/ui/Status";
import { ring } from "@/components/ui/ring";

/*
 The employee's disc: a card-coloured disc with the employee's name and one state (a dot and a word), ringed by the orbit.
 The disc covers the inner ring, so no line crosses its words. The whole disc is a button that opens the chat. The state
 keeps its line, so the disc never moves when its words change; the role is in the desk's heading.
*/
export function Disc({ name, tone, word, onOpen }: { name: string; tone: Tone; word: string; onOpen: () => void }) {
  return (
    <Orbit className="@container w-full">
      <button
        type="button"
        onClick={onOpen}
        className={`group absolute inset-[17%] flex flex-col items-center justify-center gap-[clamp(4px,2.5cqw,8px)] rounded-full border border-rule bg-card px-[6cqw] text-center transition-[scale,border-color] duration-200 hover:border-rule-strong motion-safe:hover:scale-[1.03] motion-safe:active:scale-[.98] ${ring}`}
      >
        <span className="max-w-full text-[length:clamp(0.875rem,11cqw,2rem)] leading-none font-bold tracking-[-0.03em] text-balance text-ink">{name}</span>
        <span className="inline-flex min-h-5 items-center gap-1.5 text-[length:clamp(0.6875rem,5cqw,0.75rem)] font-medium text-ink-2">
          <StateDot tone={tone} />
          {word}
        </span>
        <span className="sr-only">Open chat</span>
        <MessageCircle className="size-[clamp(14px,7cqw,18px)] text-accent-text opacity-70 transition-opacity group-hover:opacity-100" aria-hidden="true" />
      </button>
    </Orbit>
  );
}
