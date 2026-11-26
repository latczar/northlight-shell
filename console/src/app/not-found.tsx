import Link from "next/link";
import { NorthlightMark } from "@/components/NorthlightMark";

/** One answer for a page that does not exist and one this person may not open: nothing here says which. */
export default function NotFound() {
  return (
    <div className="grid min-h-[70dvh] place-items-center px-6">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <NorthlightMark size={48} />
        <h1 className="text-display text-ink">Nothing here</h1>
        <p className="text-body text-pretty text-ink-2">This page does not exist, or your account does not have access to it.</p>
        <Link href="/" className="inline-flex h-10 items-center rounded-full bg-accent px-4 text-small font-semibold text-on-accent hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus pointer-coarse:h-11">
          Go to your team
        </Link>
      </div>
    </div>
  );
}
