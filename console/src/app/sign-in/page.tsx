import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { NorthlightMark } from "@/components/NorthlightMark";
import { Orbit } from "@/components/Orbit";
import { safeNext } from "@/lib/safe-next";
import { lookupViewer } from "@/lib/server/session";
import { SignInForm } from "./SignInForm";

export const metadata: Metadata = { title: "Sign in" };

/*
 Sign in, the one brand moment: a charcoal panel with the orbit and the mark, light everything else. The
 form asks for an email and password.
*/
export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const query = await searchParams;
  const next = safeNext(query.next);
  const found = await lookupViewer();
  if (found.state === "ok") redirect(next);

  return (
    <div className="flex min-h-dvh flex-col bg-ground lg:grid lg:grid-cols-2">
      {/* the brand cover: a dark island (its own tokens), the mark top left, the orbit to the right, words in the empty quadrant */}
      <section aria-label="Northlight" data-theme="dark" className="relative flex flex-col justify-between gap-10 overflow-hidden bg-ground px-6 py-4 text-ink sm:px-10 lg:px-14 lg:py-12">
        <div className="relative flex items-center gap-2.5">
          <NorthlightMark size={24} onDark />
          <span className="font-display text-[1.25rem] leading-none font-bold tracking-[-0.02em]">Northlight</span>
        </div>
        <div aria-hidden="true" className="pointer-events-none absolute top-[40%] left-[80%] hidden w-[min(88%,72vh)] -translate-1/2 lg:block">
          <Orbit className="w-full">
            <div className="absolute inset-0 grid place-items-center">
              <NorthlightMark size={120} onDark stepping className="h-auto w-[24%]" />
            </div>
          </Orbit>
        </div>
        <div className="relative hidden max-w-md lg:block">
          <p className="font-display text-[clamp(2rem,4.5vw,3.25rem)] leading-[1.05] font-bold tracking-[-0.03em] text-balance">Your website, looked after.</p>
          <p className="mt-4 max-w-[38ch] text-body text-pretty text-ink-2">Sign in to see what your AI website manager did, and what needs you.</p>
          <p className="mt-8 hidden text-small text-ink-3 lg:block">Northlight · AI website management for small businesses</p>
        </div>
      </section>
      <section className="flex items-start justify-center px-6 py-10 sm:px-10 lg:items-center lg:py-12">
        <SignInForm next={next} linkFailed={query.error === "link"} />
      </section>
    </div>
  );
}
