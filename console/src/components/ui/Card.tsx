import { useId, type ReactNode } from "react";

/*
 Surfaces, the design's way: no shadows, elevation is surface colour. A card is white on the ground (a step up from charcoal in
 dark) with a hairline rule and an 8px radius, 16px in (24px from md). A Section groups cards or a list under a heading;
 sections stack 40px apart, more space above a heading than below it.
*/

export const card = "rounded-lg border border-rule bg-card p-4 md:p-6";

export function Section({
  title,
  meta,
  className = "",
  children,
}: {
  title: ReactNode;
  /** at the heading's end: a count, a time, one action */
  meta?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={`flex flex-col gap-3 ${className}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={id} className="text-heading text-balance text-ink">
          {title}
        </h2>
        {meta && <div className="text-small text-ink-3">{meta}</div>}
      </div>
      {children}
    </section>
  );
}
