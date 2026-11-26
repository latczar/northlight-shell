import type { ReactNode } from "react";

/*
 Label and value rows as a description list: keys in a 9rem column, values from one shared edge, aligned on their first
 baseline. In a container narrower than 30rem each key sits over its value.
*/
export function KeyValue({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`@container ${className}`}>
      <dl className="flex flex-col gap-2 @max-[30rem]:gap-3">{children}</dl>
    </div>
  );
}

export function KeyValueRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_minmax(0,1fr)] items-baseline gap-x-3 @max-[30rem]:grid-cols-1 @max-[30rem]:gap-y-0.5">
      <dt className="text-label text-ink-3">{label}</dt>
      <dd className="min-w-0 max-w-[65ch] text-small break-words text-ink">{children}</dd>
    </div>
  );
}
