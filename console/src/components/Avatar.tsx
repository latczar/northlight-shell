/** An AI employee's avatar, the design's way: a single initial on a dark surface. Never a photo, a face or an emoji. */
export function Avatar({ name, size = "md", className = "" }: { name: string; size?: "sm" | "md" | "lg" | "xl"; className?: string }) {
  const box = { sm: "size-8 text-small", md: "size-10 text-title", lg: "size-13 text-heading", xl: "size-14 text-heading" }[size];
  // "Dr. Iris" is I: a title before the name is not the person
  const initial = (name.replace(/^(mr|mrs|ms|dr)\.?\s*/i, "").match(/\p{L}/u)?.[0] ?? "?").toUpperCase();
  return (
    <span aria-hidden="true" className={`grid shrink-0 place-items-center rounded-full bg-avatar font-semibold text-avatar-ink ${box} ${className}`}>
      {initial}
    </span>
  );
}
