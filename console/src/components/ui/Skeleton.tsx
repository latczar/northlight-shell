/*
 Loading, in the shape of what is coming, so nothing jumps when it lands. A highlight sweeps across on the compositor and
 stops under reduced motion. Hidden from screen readers: the region around it says what is loading.
*/

const fill =
  "relative overflow-hidden bg-rule/70 after:absolute after:inset-0 after:-translate-x-full after:animate-shimmer after:bg-linear-to-r after:from-transparent after:via-ink/6 after:to-transparent forced-colors:border forced-colors:border-[GrayText]";

export function SkeletonLine({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`my-[0.2lh] block h-[0.6lh] rounded-sm ${fill} ${className}`} />;
}
