"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

/**
 * The design switches screens with client-side state. Here they are real
 * routes, so the active tab is derived from the pathname instead — same
 * appearance, but each screen is linkable and server-rendered.
 */

const TABS = [
  { href: "/", label: "DASHBOARD" },
  { href: "/squad", label: "SQUAD" },
  { href: "/transfers", label: "TRANSFERS" },
  { href: "/captain", label: "CAPTAIN" },
  { href: "/chips", label: "CHIPS" },
  { href: "/history", label: "HISTORY" },
  { href: "/leagues", label: "LEAGUES" },
] as const;

export function Tabs() {
  const pathname = usePathname();

  return (
    <nav className="mx-auto flex max-w-[1440px] gap-0.5 border-t border-edge-faint px-6">
      {TABS.map((tab) => {
        const isActive =
          tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "border-b-2 px-4 pt-2.5 pb-2 font-mono text-mini tracking-[0.1em] transition-colors",
              isActive
                ? "border-accent bg-active text-primary"
                : "border-transparent text-dim hover:text-primary",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
