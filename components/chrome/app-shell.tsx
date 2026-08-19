import type { ReactNode } from "react";
import { getSeasonContext } from "@/lib/fpl/season";
import { Readout } from "@/components/ui/panel";
import { DeadlineCountdown } from "./deadline-countdown";
import { Tabs } from "./tabs";

/**
 * The sticky masthead: a mark, the season position, and a strip of readouts
 * separated by hairlines. Everything in it is live data or an em dash — no
 * placeholder numbers reach production.
 *
 * The bank / free-transfer / overall-rank readouts stay blank until the squad
 * sync lands, because those come from the manager's entry rather than from
 * bootstrap-static.
 */
export async function AppShell({ children }: { children: ReactNode }) {
  const season = await getSeasonContext();

  const gwLabel = season.available
    ? `${season.gameweek.target.name.replace("Gameweek", "GW").replace(/\s+/g, "")} · 2026/27`
    : "OFFLINE";

  return (
    <div className="min-h-screen pb-16">
      <header className="sticky top-0 z-10 border-b border-edge-strong bg-page">
        <div className="mx-auto flex h-14 max-w-[1440px] items-stretch justify-between gap-8 px-6">
          <div className="flex items-center gap-3.5">
            <div className="h-[9px] w-[9px] bg-accent" />
            <div className="font-mono text-small font-semibold tracking-[0.16em] text-primary">
              FPL TERMINAL
            </div>
            <div className="font-mono text-mini tracking-[0.1em] text-label">
              {gwLabel}
            </div>
          </div>

          <div className="flex items-center">
            <Readout
              label="DEADLINE"
              tone="warn"
              className="border-l border-edge-strong"
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
            <Readout
              label="PROJ. EP"
              value="—"
              className="border-l border-edge-strong"
            />
            <Readout
              label="BANK"
              value="—"
              className="border-l border-edge-strong"
            />
            <Readout
              label="FT"
              value="—"
              className="border-l border-edge-strong"
            />
            <Readout
              label="OR"
              value="—"
              className="border-l border-edge-strong pr-0"
            />
          </div>
        </div>
        <Tabs />
      </header>

      {!season.available ? (
        <div className="mx-auto max-w-[1440px] px-6 pt-6">
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

      <main className="mx-auto max-w-[1440px] p-6">{children}</main>
    </div>
  );
}
