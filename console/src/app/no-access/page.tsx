import type { Metadata } from "next";
import { NorthlightMark } from "@/components/NorthlightMark";
import { lookupViewer } from "@/lib/server/session";

export const metadata: Metadata = { title: "No access" };

/** Signed in, but no AI employee has been given to this person yet. */
export default async function NoAccess() {
  const found = await lookupViewer();
  const email = found.state === "no-access" ? found.email : null;
  return (
    <div className="grid min-h-dvh place-items-center bg-ground px-6">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <NorthlightMark size={56} />
        <h1 className="text-display text-ink">No AI employees yet</h1>
        <p className="text-body text-pretty text-ink-2">
          {email ? <>You are signed in as <span className="font-medium break-all text-ink">{email}</span>, but </> : "Your account is signed in, but "}
          nobody has given it access to an AI employee. Ask your Northlight contact to add you on the People page.
        </p>
        <form action="/auth/sign-out" method="post">
          <button type="submit" className="mt-2 inline-flex h-10 items-center rounded-full border border-rule-strong px-4 text-small font-semibold text-ink hover:bg-ink/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus pointer-coarse:h-11">
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
