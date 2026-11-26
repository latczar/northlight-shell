"use client";

import Link from "next/link";
import { KeyRound, LogOut } from "lucide-react";
import { ThemeSwitch } from "@/components/ui/ThemeSwitch";
import { ring } from "@/components/ui/ring";

/*
 The account menu: who is signed in, the theme, Change password and Sign out. A native popover: it opens in the top layer, Escape and a
 click outside close it, and focus returns to the button.
*/
export function AccountMenu({ name, email, admin }: { name: string; email: string; admin: boolean }) {
  const initial = (name.match(/\p{L}/u)?.[0] ?? "?").toUpperCase();
  return (
    <>
      <button
        type="button"
        popoverTarget="account-menu"
        aria-label={`Account: ${name}`}
        className={`grid size-11 place-items-center rounded-full ${ring} focus-visible:outline-[#2dd4bf]`}
      >
        <span aria-hidden="true" className="grid size-8 place-items-center rounded-full border border-white/40 text-small font-semibold text-bar-ink transition-colors hover:border-white/80">
          {initial}
        </span>
      </button>
      <div
        id="account-menu"
        popover="auto"
        className="fixed inset-auto top-16 right-4 m-0 w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-rule bg-raised p-4 text-ink opacity-0 transition-[opacity,translate,overlay,display] transition-discrete duration-150 open:opacity-100 starting:open:opacity-0 motion-safe:-translate-y-1 motion-safe:open:translate-y-0 motion-safe:starting:open:-translate-y-1 md:top-[4.5rem] md:right-6"
      >
        <p className="text-title break-words">{name}</p>
        <p className="text-small break-words text-ink-2">{email}</p>
        {admin && <p className="mt-1 text-label text-ink-3">Northlight admin</p>}
        <div className="mt-4 border-t border-rule pt-4">
          <p className="mb-2 text-label text-ink-2">Theme</p>
          <ThemeSwitch />
        </div>
        <div className="mt-4 border-t border-rule pt-3">
          <Link
            href="/account"
            onClick={() => document.getElementById("account-menu")?.hidePopover()}
            className={`-mx-2 flex h-10 w-[calc(100%+1rem)] items-center gap-2 rounded-lg px-2 text-small font-medium text-ink hover:bg-ink/5 pointer-coarse:h-11 ${ring}`}
          >
            <KeyRound className="size-4 text-ink-2" aria-hidden="true" />
            Change password
          </Link>
        </div>
        <form action="/auth/sign-out" method="post" className="mt-1">
          <button type="submit" className={`-mx-2 flex h-10 w-[calc(100%+1rem)] items-center gap-2 rounded-lg px-2 text-small font-medium text-ink hover:bg-ink/5 pointer-coarse:h-11 ${ring}`}>
            <LogOut className="size-4 text-ink-2" aria-hidden="true" />
            Sign out
          </button>
        </form>
      </div>
    </>
  );
}
