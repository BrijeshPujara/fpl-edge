import type { ReactNode } from "react";
import { getSeasonContext } from "@/lib/fpl/season";
import { Readout } from "@/components/ui/panel";
import { DeadlineCountdown } from "./deadline-countdown";
import { Tabs } from "./tabs";

/**
 * The sticky masthead: a mark, the season position, and the deadline.
 *
 * It carries only what belongs to the SEASON. It used to also show projected
 * points, bank, free transfers and rank, all hardcoded to an em dash with a
 * comment saying they would fill in once the squad synced. They could not:
 * this is the root layout, it has no entry id, and every URL under `/t/{id}`
 * names a different manager. Those four now live in the entry bar, which knows
 * whose squad is on screen — see `EntryReadouts`.
 */
export async function AppShell({ children }: { children: ReactNode }) {
  const season = await getSeasonContext();

  const gwLabel = season.available
    ? `${season.gameweek.target.name.replace("Gameweek", "GW").replace(/\s+/g, "")} · 2026/27`
    : "OFFLINE";

  return (
    <div className="min-h-screen pb-16">
      <header className="sticky top-0 z-10 border-b border-edge-strong bg-page">
        <div className="mx-auto flex max-w-[1440px] flex-col items-stretch gap-0 px-4 sm:px-6 md:h-14 md:flex-row md:justify-between md:gap-8">
          <div className="flex h-14 shrink-0 items-center gap-3.5">
            <div className="h-[9px] w-[9px] bg-accent" />
            <div className="font-mono text-small font-semibold tracking-[0.16em] text-primary">
              FPL TERMINAL
            </div>
            <div className="font-mono text-mini tracking-[0.1em] text-label">
              {gwLabel}
            </div>
          </div>

          <div className="flex items-center border-t border-edge-strong pb-2 md:border-t-0 md:pb-0">
            <Readout
              label="DEADLINE"
              tone="warn"
              className="px-0 md:border-l md:border-edge-strong md:pr-0 md:pl-5"
              value={
                season.available ? (
                  <DeadlineCountdown
                    deadline={season.gameweek.target.deadline_time}
                  />
                ) : (
                  "—"
                )
              }
            />
          </div>
        </div>
        <Tabs />
      </header>

      {!season.available ? (
        <div className="mx-auto max-w-[1440px] px-4 pt-4 sm:px-6 sm:pt-6">
          <div className="border border-[var(--warn-dim)] bg-panel px-3.5 py-2.5">
            <div className="font-mono text-tiny tracking-[0.14em] text-warn">
              UPSTREAM UNAVAILABLE
            </div>
            <div className="mt-1 text-small text-muted">
              Could not reach the FPL API. Cached data is shown where available.{" "}
              <span className="text-faint">{season.reason}</span>
            </div>
          </div>
        </div>
      ) : null}

      <main className="mx-auto max-w-[1440px] p-4 sm:p-6">{children}</main>
    </div>
  );
}
