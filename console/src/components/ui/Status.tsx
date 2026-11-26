import type { ReactNode } from "react";

/*
 State, the design's way: a dot plus a word, never colour alone. The dot takes the state's colour (the design's success,
 attention, error and neutral); the word stays in ink so it reads at 4.5:1 on every surface. LiveDot is the one moving
 glyph, for an employee at work; it is still under reduced motion and the words say what is happening.
*/

export type Tone = "ok" | "attention" | "error" | "quiet" | "live";

const DOT: Record<Tone, string> = {
  ok: "bg-ok-dot",
  attention: "bg-warn-dot",
  error: "bg-danger-dot",
  quiet: "bg-quiet-dot",
  live: "bg-spark",
};

/** The state's dot alone, for a place that sets its own word beside it; the live dot moves while something works. */
export function StateDot({ tone }: { tone: Tone }) {
  return tone === "live" ? <LiveDot /> : <span aria-hidden="true" className={`size-2 shrink-0 rounded-full forced-colors:bg-[CanvasText] ${DOT[tone]}`} />;
}

export function Status({ tone, className = "", children }: { tone: Tone; className?: string; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-2 text-label text-ink-2 ${className}`}>
      <StateDot tone={tone} />
      <span>{children}</span>
    </span>
  );
}

export function LiveDot({ className = "" }: { className?: string }) {
  const dot = "col-start-1 row-start-1 rounded-full bg-spark forced-colors:bg-[CanvasText]";
  return (
    <span aria-hidden="true" className={`inline-grid size-2 shrink-0 ${className}`}>
      <span className={`${dot} animate-live`} />
      <span className={dot} />
    </span>
  );
}
