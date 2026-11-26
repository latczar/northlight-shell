import type { CSSProperties, ReactNode } from "react";

/*
 The orbit: three faint rings with a few nodes drifting at their own speeds (one compositor layer per ring), around
 whatever sits in the middle. It is the app's one piece of theatre: the brand's orbit imagery, used for the team page and
 an employee's disc. Nodes are neutral, so the only full teal on screen stays the north star. Still under reduced motion.
*/

const RINGS = [
  { r: 0.47, drift: "70s", reverse: false, nodes: [0.6, 3.7] },
  { r: 0.38, drift: "95s", reverse: true, nodes: [2.1] },
  { r: 0.29, drift: "52s", reverse: false, nodes: [4.4] },
];

export function Orbit({ className = "", children }: { className?: string; children?: ReactNode }) {
  return (
    <div className={`relative aspect-square ${className}`}>
      <svg viewBox="0 0 100 100" aria-hidden="true" className="absolute inset-0 size-full overflow-visible">
        {RINGS.map((ring, i) => (
          <circle key={i} cx={50} cy={50} r={ring.r * 100} fill="none" vectorEffect="non-scaling-stroke" strokeWidth={1} className="stroke-ink" strokeOpacity={[0.22, 0.14, 0.1][i]} />
        ))}
      </svg>
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        {RINGS.map((ring, i) => (
          <div
            key={i}
            className="orbit-drift absolute inset-0"
            style={{ "--drift": ring.drift, "--drift-direction": ring.reverse ? "reverse" : "normal" } as CSSProperties}
          >
            {ring.nodes.map(angle => (
              <span
                key={angle}
                className="absolute aspect-square w-[2.4%] -translate-1/2 rounded-full bg-ink-3"
                style={{ left: `${(50 + Math.cos(angle) * ring.r * 100).toFixed(3)}%`, top: `${(50 + Math.sin(angle) * ring.r * 100).toFixed(3)}%` }}
              />
            ))}
          </div>
        ))}
      </div>
      {children}
    </div>
  );
}

/** Where a seat sits on the outer ring: the first at twelve o'clock, the rest evenly clockwise. */
export function seatPosition(index: number, count: number) {
  const a = -Math.PI / 2 + (index * Math.PI * 2) / Math.max(1, count);
  return { left: `${(50 + Math.cos(a) * 47).toFixed(3)}%`, top: `${(50 + Math.sin(a) * 47).toFixed(3)}%` };
}
