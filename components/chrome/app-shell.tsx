import type { ReactNode } from "react";
import Link from "next/link";
import { getSeasonContext, type SeasonContext } from "@/lib/fpl/season";
import { cn } from "@/lib/cn";
import { DeadlineCountdown } from "./deadline-countdown";
import { SidebarNav } from "./sidebar-nav";

/**
 * The frame around every screen: a sidebar with the mark, the navigation and
 * the deadline; the content beside it.
 *
 * It carries only what belongs to the SEASON — the deadline is the same for
 * everyone. A manager's own numbers live in the entry layout, which knows whose
 * squad is on screen; this is the root layout and does not.
 *
 * On a phone the sidebar becomes a bar across the top: the mark and the
 * deadline on one line, the navigation scrolling beneath.
 */
export async function AppShell({ children }: { children: ReactNode }) {
  const season = await getSeasonContext();

  return (
    <div className="min-h-screen md:grid md:grid-cols-[232px_minmax(0,1fr)]">
      <aside className="bg-sidebar text-sidebar-text md:sticky md:top-0 md:h-screen">
        <div className="flex h-full flex-col gap-3 px-4 py-3 md:gap-6 md:py-6">
          <div className="flex items-center justify-between gap-3">
            <Link
              href="/"
              className="flex items-center gap-2.5 text-sidebar-text hover:text-sidebar-text"
            >
              <span className="grid size-8 place-items-center bg-signal font-display text-base font-bold text-signal-ink">
                E
              </span>
              <span className="font-display text-lg font-bold tracking-wide uppercase">
                FPL Edge
              </span>
            </Link>
            {season.available ? (
              <Deadline season={season} className="md:hidden" compact />
            ) : null}
          </div>

          <SidebarNav />

          {season.available ? (
            <Deadline season={season} className="mt-auto hidden md:flex" />
          ) : null}
        </div>
      </aside>

      <div className="min-w-0">
        {!season.available ? (
          <div className="mx-auto max-w-[1200px] px-4 pt-5 sm:px-6">
            <div className="rounded-xl border border-warn-dim bg-panel px-4 py-3">
              <div className="text-sm font-semibold text-warn">
                FPL is unreachable
              </div>
              <div className="mt-0.5 text-sm text-muted">
                Cached data is shown where available.{" "}
                <span className="text-faint">{season.reason}</span>
              </div>
            </div>
          </div>
        ) : null}

        <main className="mx-auto max-w-[1200px] px-4 py-5 sm:px-6 sm:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}

function Deadline({
  season,
  compact = false,
  className,
}: {
  season: SeasonContext;
  compact?: boolean;
  className?: string;
}) {
  const { target } = season.gameweek;

  if (compact) {
    return (
      <div className={cn("flex-col items-end text-right", className)}>
        <div className="text-[11px] font-medium text-sidebar-muted">
          {target.name} deadline
        </div>
        <div className="font-display text-base font-bold text-signal">
          <DeadlineCountdown deadline={target.deadline_time} />
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex-col gap-1 bg-signal px-3.5 py-3 text-signal-ink",
        className,
      )}
    >
      <div className="text-[11px] font-semibold tracking-wide text-signal-ink/70 uppercase">
        Next deadline
      </div>
      <div className="font-display text-2xl font-bold">
        <DeadlineCountdown deadline={target.deadline_time} />
      </div>
      <div className="text-xs font-medium text-signal-ink/70">{target.name}</div>
    </div>
  );
}
