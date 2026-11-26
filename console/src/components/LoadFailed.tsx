"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { ErrorState } from "@/components/ui/Notice";

/** A read that failed, in its place: what failed and Try again, which reloads the page's data. */
export function LoadFailed({ title, reason, className }: { title: string; reason: string; className?: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  return (
    <ErrorState title={title} busy={busy} onRetry={() => start(() => router.refresh())} className={className}>
      {reason}
    </ErrorState>
  );
}
