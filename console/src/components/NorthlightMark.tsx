/*
 The Northlight mark: a four-point north star on a 32-unit square. `onDark` is the mark's own teal for the charcoal top
 bar and the sign-in panel; otherwise it follows the theme's spark (teal on light, bright teal on dark). `stepping` adds
 a slow twinkle with long rests (the brand's one signature move); still under reduced motion.
*/

const STAR = "M16 2 19 13 30 16 19 19 16 30 13 19 2 16 13 13Z";

export function NorthlightMark({ size = 28, onDark, stepping, className = "" }: { size?: number; onDark?: boolean; stepping?: boolean; className?: string }) {
  const fill = onDark ? "fill-[#14b8a6]" : "fill-spark";
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" className={`shrink-0 overflow-visible ${className}`}>
      <path
        d={STAR}
        className={`${fill} forced-colors:fill-[CanvasText] ${stepping ? "star-twinkle" : ""}`}
        style={{ transformOrigin: "16px 16px" }}
      />
    </svg>
  );
}

/** The horizontal lockup for the top bar: the star, then the wordmark. */
export function NorthlightLockup() {
  return (
    <span className="inline-flex items-center gap-2">
      <NorthlightMark size={24} onDark />
      <span className="font-display text-[1.25rem] leading-none font-bold tracking-[-0.02em] text-bar-ink">Northlight</span>
    </span>
  );
}
