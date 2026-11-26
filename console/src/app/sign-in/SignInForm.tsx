"use client";

import { useRef, useState, useTransition } from "react";
import { unstable_rethrow } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";
import { signIn } from "./actions";

/*
 Email and password on one card. A refusal never says whether the address has an account (the same words either way), so
 the form cannot be used to find out who uses Northlight. What was typed stays put after a refusal or a lost connection.
*/
export function SignInForm({ next, linkFailed }: { next: string; linkFailed: boolean }) {
  const [error, setError] = useState<string | null>(null);
  // a sign-in link that failed says so once, until the form is sent
  const [linkNotice, setLinkNotice] = useState(linkFailed);
  const [pending, start] = useTransition();
  const passwordInput = useRef<HTMLInputElement>(null);
  // a refusal arrives after the press; moving to the password field reads the field and its error out
  const showRefusal = (message: string) => {
    setError(message);
    requestAnimationFrame(() => passwordInput.current?.focus());
  };

  return (
    <div className="w-full max-w-sm">
      <h1 className="text-display text-ink">Sign in</h1>
      <form
        className="mt-6 flex flex-col gap-5"
        onSubmit={e => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const email = String(form.get("email") ?? "");
          const password = String(form.get("password") ?? "");
          setError(null);
          setLinkNotice(false);
          start(async () => {
            try {
              const result = await signIn(email, password, next);
              // on success the action redirects; only a refusal comes back
              if (result && !result.ok) showRefusal(result.error);
            } catch (error) {
              unstable_rethrow(error);
              showRefusal("Connection interrupted. Reconnect and try again.");
            }
          });
        }}
      >
        {linkNotice && <Notice tone="warn">That sign-in link did not work or has expired. Sign in with your password instead.</Notice>}
        <p className="text-body text-ink-2">Use the email associated with your workspace.</p>
        <Input label="Email" type="email" name="email" autoComplete="username" required />
        <Input ref={passwordInput} label="Password" type="password" name="password" autoComplete="current-password" required error={error ?? undefined} />
        <Button type="submit" variant="primary" busy={pending} busyLabel="Signing in" className="w-full">
          Sign in
        </Button>
        <p className="text-small text-ink-3">Forgotten your password? Ask a Northlight admin to set a new one.</p>
      </form>
    </div>
  );
}
