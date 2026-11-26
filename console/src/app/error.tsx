"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/ui/Notice";

/** A page that failed to render: what happened and what to do, in the design's careful voice. */
export default function PageError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error("page failed", error.digest ?? error.message.slice(0, 120));
  }, [error]);
  return (
    <div className="mx-auto max-w-xl px-6 py-16">
      <ErrorState title="This page could not be shown" onRetry={retry}>
        Something failed while loading it. Try again; if it keeps failing, tell your Northlight contact{error.digest ? ` and mention code ${error.digest}` : ""}.
      </ErrorState>
    </div>
  );
}
