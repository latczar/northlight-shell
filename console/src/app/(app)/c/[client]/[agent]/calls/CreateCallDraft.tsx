"use client";
import { useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { createServicesDraft } from "./actions";

export function CreateCallDraft({ client, agent, callId }: { client: string; agent: string; callId: string }) {
  const [busy, start] = useTransition();
  const [error, setError] = useState("");
  const router = useRouter();
  const path = usePathname();
  const draftPath = `/c/${client}/${agent}/calls/${callId}/draft`;

  function openDraft() {
    start(async () => {
      setError("");
      try {
        const result = await createServicesDraft(client, agent, callId);
        if (result.error) setError(result.error);
        else if (path === draftPath) router.refresh();
        else router.push(draftPath);
      } catch {
        setError("Connection interrupted. Try again to open the same draft.");
      }
    });
  }

  return (
    <div className="mt-4">
      <Button variant="primary" busy={busy} busyLabel="Opening draft" onClick={openDraft}>Create draft</Button>
      {error && <p role="alert" className="mt-2 text-small">{error}</p>}
    </div>
  );
}
