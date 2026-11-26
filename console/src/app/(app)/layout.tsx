import Link from "next/link";
import { AccountMenu } from "@/components/AccountMenu";
import { BarNav } from "@/components/BarNav";
import { NorthlightLockup } from "@/components/NorthlightMark";
import { Announcer } from "@/components/ui/Announcer";
import { lookupViewer } from "@/lib/server/session";

/*
 The signed-in shell: the charcoal bar (charcoal sits in the bar and the avatars only) over the light ground.
 Pages check the session themselves and redirect; the bar only shows what the session already says.
*/
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const found = await lookupViewer();
  const viewer = found.state === "ok" ? found.viewer : null;
  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-full focus:bg-raised focus:px-4 focus:py-2 focus:text-small focus:text-ink">
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-bar-rule bg-bar">
        <div className="mx-auto flex h-14 max-w-[1264px] items-center gap-3 px-4 md:h-16 md:px-6 lg:px-8">
          <Link href="/" aria-label="Northlight home" className="-ml-1 inline-flex h-11 shrink-0 items-center rounded-lg px-1 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-[#43cfe3]">
            <NorthlightLockup />
          </Link>
          {viewer && <span aria-hidden="true" className="mx-1 hidden h-6 w-px bg-bar-rule sm:block" />}
          {viewer && <BarNav clients={viewer.clients} admin={viewer.admin} />}
          <div className="ml-auto">{viewer && <AccountMenu name={viewer.name} email={viewer.email} admin={viewer.admin} />}</div>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-[1264px] px-4 pt-8 pb-16 md:px-6 md:pt-10 lg:px-8">
        {children}
      </main>
      <Announcer />
    </>
  );
}
