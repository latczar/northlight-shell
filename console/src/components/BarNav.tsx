"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import type { Client } from "@/lib/access";

/*
 The top bar's places: the business being looked at, its Team, and People for Northlight admins. The active one is bright teal
 with a line under it (never colour alone).
*/
export function BarNav({ clients, admin }: { clients: Client[]; admin: boolean }) {
  const params = useParams<{ client?: string }>();
  const path = usePathname();
  const current = clients.find(c => c.id === params.client) ?? (clients.length === 1 ? clients[0] : undefined);
  const link = (href: string, label: string, active: boolean) => (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`relative inline-flex h-11 items-center px-2 text-small font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-[#43cfe3] ${
        active ? "text-[#2dd4bf] after:absolute after:inset-x-2 after:bottom-1.5 after:h-0.5 after:rounded-full after:bg-[#2dd4bf]" : "text-bar-ink-2 hover:text-bar-ink"
      }`}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label="Main" className="flex min-w-0 items-center gap-1">
      {current && (
        <>
          <span className="hidden truncate px-2 text-small text-bar-ink-2 sm:inline" title={current.name}>
            {current.name}
          </span>
          {link(`/c/${current.id}`, "Team", path.startsWith(`/c/${current.id}`))}
        </>
      )}
      {!current && clients.length > 1 && link("/", "Businesses", path === "/")}
      {admin && link("/people", "People", path.startsWith("/people"))}
    </nav>
  );
}
