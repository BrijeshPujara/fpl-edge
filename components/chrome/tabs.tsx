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
  { path: "", label: "DASHBOARD" },
  { path: "/squad", label: "SQUAD" },
  { path: "/transfers", label: "TRANSFERS" },
  { path: "/captain", label: "CAPTAIN" },
  { path: "/chips", label: "CHIPS" },
  { path: "/history", label: "HISTORY" },
  { path: "/leagues", label: "LEAGUES" },
] as const;

/**
 * The team the tabs belong to, read from the URL.
 *
 * Derived rather than passed down. Every one of these links has to carry the
 * entry id, and threading it from the root layout would mean the root layout
 * knowing about a route param it does not have — the landing page lives above
 * `/t/{id}` and has no team at all.
 */
function entryBaseFrom(pathname: string): string | null {
  const [, root, entryId] = pathname.split("/");
  if (root !== "t" || !entryId || !/^\d+$/.test(entryId)) return null;
  return `/t/${entryId}`;
}

export function Tabs() {
  const pathname = usePathname();
  const base = entryBaseFrom(pathname);

  // Nothing to navigate between until a team is chosen. The landing page and
  // the preview harness both render without a tab strip rather than with one
  // pointing at routes that would 404.
  if (base === null) return null;

  return (
    <nav
      aria-label="Primary"
      className="mx-auto flex max-w-[1440px] snap-x snap-mandatory gap-0.5 overflow-x-auto border-t border-edge-faint px-4 [scrollbar-width:none] sm:px-6 md:overflow-x-visible [&::-webkit-scrollbar]:hidden"
    >
      {TABS.map((tab) => {
        const href = `${base}${tab.path}`;
        const isActive =
          tab.path === "" ? pathname === base : pathname.startsWith(href);
        return (
          <Link
            key={tab.path}
            href={href}
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
