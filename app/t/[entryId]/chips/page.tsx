import { notFound } from "next/navigation";
import { getFixtures } from "@/lib/fpl/client";
import { parseEntryId } from "@/lib/fpl/entry";
import { getSeasonContext } from "@/lib/fpl/season";
import {
  classifyGameweek,
  countFixturesByTeam,
  type GameweekShape,
} from "@/lib/fpl/gameweek";
import { CHIP_LABEL, TOTAL_GAMEWEEKS, type ChipName } from "@/lib/rules";
import { cn } from "@/lib/cn";
import { PageHeader, Panel, SectionLabel } from "@/components/ui/panel";
import { Pending } from "@/components/ui/pending";
import { ChipAdvisories } from "@/components/chips/advisories";

/**
 * The 38-gameweek chip timeline.
 *
 * Everything on this screen is derivable today: chip windows come from
 * `bootstrap-static.chips[]`, and blanks and doubles come from counting
 * fixtures per team per gameweek. No expected-points model is involved, which
 * is why this is the one analytical screen that works in phase 1.
 *
 * The advisories below it — which gameweek to actually play each chip — are
 * solved rather than triggered, and depend on the expected-points model. See
 * `components/chips/advisories.tsx`.
 */
export default async function ChipsPage({
  params,
}: {
  params: Promise<{ entryId: string }>;
}) {
  const entryId = parseEntryId((await params).entryId);
  if (entryId === null) notFound();

  const season = await getSeasonContext();
  if (!season.available) {
    return (
      <Pending phase="upstream recovery">
        The FPL API is unreachable, so chip windows and fixture counts cannot be
        resolved.
      </Pending>
    );
  }

  const fixtures = await getFixtures().catch(() => null);
  const teamIds = season.teams.map((t) => t.id);
  const counts =
    fixtures === null ? null : countFixturesByTeam(fixtures, teamIds);

  const currentGw = season.gameweek.target.id;

  const gameweeks = Array.from({ length: TOTAL_GAMEWEEKS }, (_, i) => {
    const gw = i + 1;
    const shape: GameweekShape | null =
      counts === null ? null : classifyGameweek(counts.get(gw));
    return { gw, shape };
  });

  const chipNames: ChipName[] = ["wildcard", "freehit", "3xc", "bboost"];
  const columns = {
    gridTemplateColumns: `repeat(${TOTAL_GAMEWEEKS}, minmax(0, 1fr))`,
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Chips"
        subtitle="When each chip can be played, where the blanks and doubles fall, and the week to play it"
      />

      <section>
        <SectionLabel meta="Windows from FPL · blanks and doubles from the fixture list">
          Season timeline
        </SectionLabel>

        {/*
          The 38-column timeline cannot compress to a phone without becoming
          unreadable, so it scrolls horizontally inside its panel at a minimum
          legible width. The page body itself never scrolls sideways.
        */}
        <Panel className="overflow-x-auto px-4 pt-4 pb-3">
          <div className="min-w-[760px]">
            <div className="mb-2 grid grid-cols-[150px_1fr] items-end gap-4">
              <div />
              <div className="grid gap-0.5" style={columns}>
                {gameweeks.map(({ gw, shape }) => (
                  <div key={gw} className="flex flex-col items-center gap-1">
                    <div
                      className={cn(
                        "font-display text-[11px]",
                        gw === currentGw
                          ? "font-bold text-primary"
                          : gw < currentGw
                            ? "text-ghost"
                            : "text-muted",
                      )}
                    >
                      {gw % 2 === 1 || gw === currentGw ? gw : ""}
                    </div>
                    <div
                      title={`GW${gw}${shape ? ` · ${shape}` : ""}`}
                      className={cn(
                        "flex h-5 w-full items-center justify-center font-display text-[11px] font-bold",
                        shape === "double"
                          ? "bg-[var(--gw-double-bg)] text-[var(--gw-double-fg)]"
                          : shape === "blank"
                            ? "bg-[var(--gw-blank-bg)] text-[var(--gw-blank-fg)]"
                            : gw === currentGw
                              ? "bg-signal text-signal-ink"
                              : gw < currentGw
                                ? "bg-[var(--gw-past-bg)]"
                                : "bg-[var(--gw-future-bg)]",
                      )}
                    >
                      {shape === "double" ? "D" : shape === "blank" ? "B" : ""}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {chipNames.map((name) => {
              const windows = season.chipWindows.filter((w) => w.name === name);
              if (windows.length === 0) return null;
              return (
                <div
                  key={name}
                  className="grid h-11 grid-cols-[150px_1fr] items-center gap-4 border-t border-edge-subtle"
                >
                  <div className="flex flex-col">
                    <div className="text-sm font-semibold text-primary">
                      {CHIP_LABEL[name]}
                    </div>
                    <div className="text-xs text-muted">
                      {windows
                        .map((w) => `GW${w.startEvent}–${w.stopEvent}`)
                        .join(" · ")}
                    </div>
                  </div>
                  <div className="grid gap-0.5" style={columns}>
                    {gameweeks.map(({ gw, shape }) => {
                      const open = windows.some(
                        (w) => gw >= w.startEvent && gw <= w.stopEvent,
                      );
                      const closingSoon =
                        open &&
                        windows.some(
                          (w) =>
                            gw >= w.startEvent &&
                            gw <= w.stopEvent &&
                            w.stopEvent - currentGw <= 6 &&
                            currentGw >= w.startEvent,
                        );
                      return (
                        <div
                          key={gw}
                          className={cn(
                            "h-4 border-b-2",
                            open
                              ? closingSoon
                                ? // Salmon, not yellow: yellow already marks
                                  // this gameweek, and two yellows in one
                                  // timeline read as the same thing.
                                  "bg-[var(--fdr-4-bg)]"
                                : gw < currentGw
                                  ? "bg-track"
                                  : "bg-track-strong"
                              : "bg-sunken",
                            open && shape === "double"
                              ? "border-[var(--fdr-1-bg)]"
                              : open && shape === "blank"
                                ? "border-[var(--fdr-5-bg)]"
                                : "border-transparent",
                          )}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          <Key className="bg-signal" label="This gameweek" />
          <Key className="bg-track-strong" label="Window open" />
          <Key className="bg-[var(--fdr-4-bg)]" label="Window closing soon" />
          <Key className="bg-[var(--gw-double-bg)]" label="Double gameweek (D)" />
          <Key className="bg-[var(--gw-blank-bg)]" label="Blank gameweek (B)" />
        </div>
      </section>

      {counts === null ? (
        <Pending phase="the fixture list">
          The fixture list could not be fetched, so blanks and doubles are not
          marked above.
        </Pending>
      ) : null}

      <ChipAdvisories entryId={entryId} />
    </div>
  );
}

function Key({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("size-2.5", className)} />
      {label}
    </span>
  );
}
