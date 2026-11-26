"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Mic, MicOff, Phone, PhoneOff } from "lucide-react";
import type { VoiceConversation } from "@elevenlabs/client";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { startIrisCall } from "./actions";

type Line = { id: number; who: "You" | "Iris"; text: string };
type State = "idle" | "starting" | "live" | "ended";

/** Why a call failed, in words a person can act on. Browsers name a refused microphone NotAllowedError. */
function reason(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Your browser did not allow the microphone. Allow it for this site, then start the call again.";
  if (name === "NotFoundError") return "No microphone was found. Connect one, then start the call again.";
  return "The call could not connect. Check your connection and try again.";
}

/** A browser call with Iris: start, mute, hang up, and what each side said. */
export function VoiceCall({ client, agent, historyHref }: { client: string; agent: string; historyHref: string }) {
  const [state, setState] = useState<State>("idle");
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState("");
  const call = useRef<VoiceConversation | null>(null);

  // Leaving the page hangs up.
  useEffect(() => () => { void call.current?.endSession(); }, []);

  async function start() {
    setError("");
    setLines([]);
    setMuted(false);
    setState("starting");
    try {
      // Ask for the microphone first, so a refusal is explained before a call is opened with the voice service.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop());
    } catch (cause) {
      setError(reason(cause));
      setState("idle");
      return;
    }
    const opened = await startIrisCall(client, agent).catch(() => ({ error: "The call could not be started. Try again." }));
    if ("error" in opened) {
      setError(opened.error);
      setState("idle");
      return;
    }
    try {
      const { Conversation } = await import("@elevenlabs/client");
      let next = 0;
      call.current = await Conversation.startSession({
        conversationToken: opened.token,
        connectionType: "webrtc",
        textOnly: false,
        userId: opened.userId,
        customLlmExtraBody: opened.extraBody,
        onConnect: () => setState("live"),
        onDisconnect: details => {
          call.current = null;
          setSpeaking(false);
          setState("ended");
          if (details.reason === "error") setError("The call dropped. Start it again to carry on.");
        },
        onError: () => setError("Something went wrong on the call. If Iris stops answering, hang up and call again."),
        onModeChange: ({ mode }) => setSpeaking(mode === "speaking"),
        onMessage: ({ message, source }) => {
          if (message.trim()) setLines(previous => [...previous, { id: next++, who: source === "user" ? "You" : "Iris", text: message }]);
        },
      });
    } catch (cause) {
      call.current = null;
      setError(reason(cause));
      setState("idle");
    }
  }

  async function hangUp() {
    await call.current?.endSession();
    call.current = null;
    setState("ended");
  }

  function toggleMute() {
    call.current?.setMicMuted(!muted);
    setMuted(!muted);
  }

  const live = state === "live";
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        {live ? (
          <>
            <Button variant="danger" icon={<PhoneOff aria-hidden="true" />} onClick={hangUp}>Hang up</Button>
            <Button variant="secondary" icon={muted ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />} onClick={toggleMute} aria-pressed={muted}>
              {muted ? "Unmute" : "Mute"}
            </Button>
          </>
        ) : (
          <Button variant="primary" icon={<Phone aria-hidden="true" />} onClick={start} busy={state === "starting"} busyLabel="Connecting">
            {state === "ended" ? "Call again" : "Start call"}
          </Button>
        )}
        <p role="status" className="text-small text-ink-2">
          {state === "starting" ? "Connecting to Iris…" : live ? (muted ? "You are muted." : speaking ? "Iris is speaking." : "Iris is listening.") : state === "ended" ? "Call ended." : ""}
        </p>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      {lines.length > 0 && (
        <ol aria-label="What was said" className="flex flex-col gap-3 rounded-lg border border-rule p-4">
          {lines.map(line => (
            <li key={line.id}>
              <strong className="text-small">{line.who}</strong>
              <p className="whitespace-pre-wrap break-words">{line.text}</p>
            </li>
          ))}
        </ol>
      )}
      {state === "ended" && <Link href={historyHref} prefetch={false} className="self-start text-small font-medium underline">See your past calls</Link>}
    </div>
  );
}
