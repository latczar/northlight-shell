import type { Metadata } from "next";
import { requireViewer } from "@/lib/server/session";
import { PasswordForm } from "./PasswordForm";

export const metadata: Metadata = { title: "Your account" };

/* The signed-in person's own account: who they are signed in as, and their password. */
export default async function AccountPage() {
  const viewer = await requireViewer("/account");
  return (
    <div className="flex max-w-md flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-display text-ink">Your account</h1>
        <p className="text-body text-ink-2">
          Signed in as <span className="font-medium break-all text-ink">{viewer.email}</span>.
        </p>
      </header>
      <PasswordForm />
    </div>
  );
}
