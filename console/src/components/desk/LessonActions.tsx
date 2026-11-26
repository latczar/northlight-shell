"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { decideLessonAction } from "@/app/(app)/c/[client]/[agent]/actions";
import { announce } from "@/components/ui/Announcer";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";

/**
 * Keep or remove something an employee learned. Removing an active lesson asks once, in place: the employee stops using it
 * from its next piece of work, and it cannot be brought back here.
 */
export function LessonActions({ clientId, agentId, lessonId, proposed, agentName }: { clientId: string; agentId: string; lessonId: string; proposed: boolean; agentName: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [doing, setDoing] = useState<"approve" | "remove" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function decide(decision: "approve" | "remove") {
    setDoing(decision);
    setError(null);
    start(async () => {
      const result = await decideLessonAction(clientId, agentId, lessonId, decision);
      if (!result.ok) {
        setError(result.error);
        setDoing(null);
        return;
      }
      announce(decision === "approve" ? `${agentName} keeps this lesson.` : "Removed.");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-start gap-2">
      {error && <Notice tone="danger">{error}</Notice>}
      {proposed ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" busy={pending && doing === "approve"} busyLabel="Keeping" onClick={() => decide("approve")}>
            Keep it
          </Button>
          <Button size="sm" busy={pending && doing === "remove"} busyLabel="Removing" onClick={() => decide("remove")}>
            Don&apos;t keep it
          </Button>
        </div>
      ) : confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-small text-ink-2">{agentName} stops using it. Remove?</span>
          <Button size="sm" variant="danger" busy={pending && doing === "remove"} busyLabel="Removing" onClick={() => decide("remove")}>
            Remove
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
          Remove
        </Button>
      )}
    </div>
  );
}
