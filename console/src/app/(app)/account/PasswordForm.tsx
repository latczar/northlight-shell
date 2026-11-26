"use client";

import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";
import { MIN_PASSWORD } from "@/lib/password";
import { changePassword } from "./actions";

/* Set a new password: typed twice, checked on the server, and the fields clear once it is saved. */
export function PasswordForm() {
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const passwordInput = useRef<HTMLInputElement>(null);
  const confirmInput = useRef<HTMLInputElement>(null);

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={e => {
        e.preventDefault();
        const form = e.currentTarget;
        const data = new FormData(form);
        setErrors({});
        setSaved(false);
        start(async () => {
          try {
            const result = await changePassword(String(data.get("password") ?? ""), String(data.get("confirm") ?? ""));
            if (result.ok) {
              form.reset();
              setSaved(true);
              return;
            }
            setErrors({ [result.field]: result.error });
            const field = result.field === "confirm" ? confirmInput : passwordInput;
            requestAnimationFrame(() => field.current?.focus());
          } catch {
            setErrors({ password: "Connection interrupted. Reconnect and try again." });
          }
        });
      }}
    >
      <h2 className="text-title text-ink">Change your password</h2>
      {saved && <Notice tone="ok">Password changed. Use it next time you sign in.</Notice>}
      <Input
        ref={passwordInput}
        label="New password"
        type="password"
        name="password"
        autoComplete="new-password"
        required
        hint={`At least ${MIN_PASSWORD} characters.`}
        error={errors.password}
      />
      <Input ref={confirmInput} label="Type it again" type="password" name="confirm" autoComplete="new-password" required error={errors.confirm} />
      <Button type="submit" variant="primary" busy={pending} busyLabel="Saving" className="self-start">
        Save password
      </Button>
    </form>
  );
}
