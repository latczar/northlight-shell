"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { unstable_rethrow } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";
import { sendCode, verifyCode } from "./actions";

const RESEND_SECONDS = 60;

/*
 Two steps on one card: the email, then the code. The code step never says whether the address has access (the same
 words either way), so the form cannot be used to find out who uses Northlight. A new code can be asked for after a minute, the
 time Supabase waits between codes.
*/
export function SignInForm({ next, linkFailed }: { next: string; linkFailed: boolean }) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  // a sign-in link that failed says so once, until a code is asked for
  const [linkNotice, setLinkNotice] = useState(linkFailed);
  const [wait, setWait] = useState(0);
  const resendAt = useRef(0);
  const waiting = wait > 0;
  const [pending, start] = useTransition();
  const codeInput = useRef<HTMLInputElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  // a refusal arrives after the press; moving to its field reads the field and its error out
  const showRefusal = (message: string, field: typeof codeInput) => {
    setError(message);
    requestAnimationFrame(() => field.current?.focus());
  };

  function submitAction(field: typeof codeInput, connectionMessage: string, action: () => Promise<void>) {
    start(async () => {
      try {
        await action();
      } catch (error) {
        unstable_rethrow(error);
        showRefusal(connectionMessage, field);
      }
    });
  }

  useEffect(() => {
    if (!waiting) return;
    // Mobile tabs can miss every timer tick while the user reads their email.
    const syncWait = () => setWait(Math.max(0, Math.ceil((resendAt.current - Date.now()) / 1000)));
    const timer = window.setInterval(syncWait, 1000);
    document.addEventListener("visibilitychange", syncWait);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", syncWait);
    };
  }, [waiting]);

  function askForCode(address: string) {
    setError(null);
    setLinkNotice(false);
    const field = step === "email" ? emailInput : codeInput;
    submitAction(field, "Connection interrupted. Check your inbox before trying again.", async () => {
      const result = await sendCode(address);
      if (!result.ok) {
        showRefusal(result.error, field);
        return;
      }
      setEmail(result.email);
      setStep("code");
      if (codeInput.current) codeInput.current.value = "";
      resendAt.current = Date.now() + RESEND_SECONDS * 1000;
      setWait(RESEND_SECONDS);
      requestAnimationFrame(() => codeInput.current?.focus());
    });
  }

  return (
    <div className="w-full max-w-sm">
      <h1 className="text-display text-ink">{step === "email" ? "Sign in" : "Check your email"}</h1>
      {step === "email" ? (
        <form
          key={step}
          className="mt-6 flex flex-col gap-5"
          onSubmit={e => {
            e.preventDefault();
            const address = String(new FormData(e.currentTarget).get("email") ?? "").trim().toLowerCase();
            const submitter = (e.nativeEvent as SubmitEvent).submitter;
            if (submitter instanceof HTMLButtonElement && submitter.value === "use-existing") {
              if (address !== email) setWait(0);
              setEmail(address);
              setError(null);
              setStep("code");
              requestAnimationFrame(() => codeInput.current?.focus());
              return;
            }
            askForCode(address);
          }}
        >
          {linkNotice && <Notice tone="warn">That sign-in link did not work or has expired. Ask for a code instead.</Notice>}
          <p className="text-body text-ink-2">Use the email associated with your workspace.</p>
          <Input ref={emailInput} label="Email" type="email" name="email" autoComplete="email" required defaultValue={email} error={error ?? undefined} />
          <Button type="submit" variant="primary" busy={pending} busyLabel="Sending the code" className="w-full">
            Email me a code
          </Button>
          <Button type="submit" value="use-existing" variant="link" disabled={pending}>I already have a code</Button>
        </form>
      ) : (
        <form
          key={step}
          className="mt-6 flex flex-col gap-5"
          onSubmit={e => {
            e.preventDefault();
            const code = String(new FormData(e.currentTarget).get("code") ?? "");
            setError(null);
            submitAction(codeInput, "Couldn’t confirm sign-in. Reconnect and try again.", async () => {
              const result = await verifyCode(email, code, next);
              // on success the action redirects; only a refusal comes back
              if (result && !result.ok) showRefusal(result.error, codeInput);
            });
          }}
        >
          <p className="text-body text-pretty text-ink-2" id="code-sent">
            Enter the latest 6-digit code for <span className="font-medium break-all text-ink">{email}</span>. It expires after 10 minutes.
          </p>
          <Input
            ref={codeInput}
            label="Code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]*"
            maxLength={12}
            required
            error={error ?? undefined}
            className="[&_input]:font-mono [&_input]:tracking-[0.3em]"
          />
          <Button type="submit" variant="primary" busy={pending} busyLabel="Checking" className="w-full">
            Sign in
          </Button>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              variant="link"
              icon={<ArrowLeft aria-hidden="true" />}
              onClick={() => {
                setStep("email");
                setError(null);
              }}
            >
              Use a different email
            </Button>
            {wait > 0 ? (
              <span className="text-small text-ink-3" aria-live="off">
                Resend available in {wait}s
              </span>
            ) : (
              <Button variant="link" onClick={() => askForCode(email)}>
                Send a new code
              </Button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
