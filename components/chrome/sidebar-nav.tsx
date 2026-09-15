"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeftRight,
  CalendarDays,
  Crown,
  GitCompare,
  History,
  LayoutDashboard,
  Shirt,
  Trophy,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Primary navigation: a sidebar from the medium breakpoint, a scrolling strip
 * above the content on a phone.
 *
 * Eight sections do not fit a phone's width, so the base layout scrolls
 * horizontally and the vertical list is the enhancement. Every item is at
 * least 44px tall — the minimum a thumb hits reliably.
 *
 * An item acknowledges the tap immediately. These routes render on the server
 * against a remote database, and a tap with no response for a few hundred
 * milliseconds reads as a tap that did not register.
 */

const NAV: { path: string; label: string; icon: LucideIcon }[] = [
  { path: "", label: "Dashboard", icon: LayoutDashboard },
  { path: "/squad", label: "My Team", icon: Shirt },
  { path: "/transfers", label: "Transfers", icon: ArrowLeftRight },
  { path: "/captain", label: "Captain", icon: Crown },
  { path: "/chips", label: "Chips", icon: Zap },
  { path: "/fixtures", label: "Fixtures", icon: CalendarDays },
  { path: "/leagues", label: "Leagues", icon: Trophy },
  { path: "/history", label: "History", icon: History },
  { path: "/shadow", label: "Shadow", icon: GitCompare },
];

/**
 * The team the navigation belongs to, read from the URL.
 *
 * Derived rather than passed down: every link carries the entry id, and the
 * root layout that renders the sidebar has no route param to give it — the
 * landing page lives above `/t/{id}` and has no team at all.
 */
export function entryBaseFrom(pathname: string): string | null {
  const [, root, entryId] = pathname.split("/");
  if (root !== "t" || !entryId || !/^\d+$/.test(entryId)) return null;
  return `/t/${entryId}`;
}

/** The label, which knows whether its own link is mid-navigation. */
function NavLabel({ label }: { label: string }) {
  // Only reports the status of the Link it is rendered inside, hence the split.
  const { pending } = useLinkStatus();
  return (
    <span className={cn("truncate", pending && "animate-pulse")}>{label}</span>
  );
}

export function SidebarNav() {
  const pathname = usePathname();
  const base = entryBaseFrom(pathname);

  // Nothing to navigate between until a team is chosen.
  if (base === null) return null;

  return (
    <nav
      aria-label="Primary"
      className="flex gap-1 overflow-x-auto [scrollbar-width:none] md:flex-col md:overflow-visible [&::-webkit-scrollbar]:hidden"
    >
      {NAV.map(({ path, label, icon: Icon }) => {
        const href = `${base}${path}`;
        const active = path === "" ? pathname === base : pathname.startsWith(href);
        return (
          <Link
            key={path}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-11 shrink-0 items-center gap-3 rounded-lg px-3 text-sm transition-colors",
              // Yellow means "you are here" in this theme — never green, which
              // is kept for gains.
              active
                ? "bg-signal font-semibold text-signal-ink hover:text-signal-ink"
                : "text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-text",
            )}
          >
            <Icon aria-hidden className="size-4 shrink-0" strokeWidth={active ? 2.25 : 1.75} />
            <NavLabel label={label} />
          </Link>
        );
      })}
    </nav>
  );
}
