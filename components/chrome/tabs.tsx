"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

/**
 * Primary navigation.
 *
 * Mobile-first: seven tabs do not fit a phone, so the base layout is a
 * horizontal scroller with scroll-snap and momentum, and the desktop row is the
 * enhancement. `scrollbar-none` hides the bar without disabling the scroll.
 *
 * Tap targets are 44px tall on touch — the canvas's 34px is a mouse-era number
 * and misses reliably with a thumb.
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
    <nav
      aria-label="Primary"
      className="mx-auto flex max-w-[1440px] snap-x snap-mandatory gap-0.5 overflow-x-auto border-t border-edge-faint px-4 [scrollbar-width:none] sm:px-6 md:overflow-x-visible [&::-webkit-scrollbar]:hidden"
    >
      {TABS.map((tab) => {
        const isActive =
          tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex shrink-0 snap-start items-center border-b-2 px-3.5 font-mono text-mini tracking-[0.1em] transition-colors",
              "min-h-11 md:min-h-0 md:pt-2.5 md:pb-2",
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
