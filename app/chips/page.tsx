import { getFixtures } from "@/lib/fpl/client";
import { getSeasonContext } from "@/lib/fpl/season";
import {
  classifyGameweek,
  countFixturesByTeam,
  type GameweekShape,
} from "@/lib/fpl/gameweek";
import { CHIP_LABEL, TOTAL_GAMEWEEKS, type ChipName } from "@/lib/rules";
import { cn } from "@/lib/cn";
import { Panel, SectionLabel } from "@/components/ui/panel";
import { Pending } from "@/components/ui/pending";

/**
 * The 38-gameweek chip timeline.
 *
 * Everything on this screen is derivable today: chip windows come from
 * `bootstrap-static.chips[]`, and blanks and doubles come from counting
 * fixtures per team per gameweek. No expected-points model is involved, which
 * is why this is the one analytical screen that works in phase 1.
 *
 * The chip advisories — which gameweek to actually play each chip — are
 * phase 4 and depend on the model.
 */
export default async function ChipsPage() {
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

  return (
    <div>
      <SectionLabel meta="B = BLANK · D = DOUBLE · WINDOWS FROM THE API">
        CHIP TIMELINE · GW1–{TOTAL_GAMEWEEKS}
      </SectionLabel>

      <Panel className="p-4 pb-3.5">
        <div className="mb-2.5 grid grid-cols-[150px_1fr] items-center gap-3.5">
          <div />
          <div
            className="grid gap-0.5"
            style={{
              gridTemplateColumns: `repeat(${TOTAL_GAMEWEEKS}, minmax(0, 1fr))`,
            }}
          >
            {gameweeks.map(({ gw, shape }) => (
              <div key={gw} className="flex flex-col items-center gap-1">
                <div
                  className={cn(
                    "font-mono text-[8px]",
                    gw === currentGw
                      ? "text-primary"
                      : gw < currentGw
                        ? "text-[#33383d]"
                        : "text-fainter",
                  )}
                >
                  {gw % 2 === 1 || gw === currentGw ? gw : ""}
                </div>
                <div
                  title={`GW${gw}${shape ? ` · ${shape}` : ""}`}
                  className={cn(
                    "flex h-4 w-full items-center justify-center font-mono text-[9px] font-semibold",
                    shape === "double" &&
                      "bg-[var(--gw-double-bg)] text-[var(--gw-double-fg)]",
                    shape === "blank" &&
                      "bg-[var(--gw-blank-bg)] text-[var(--gw-blank-fg)]",
                    shape !== "double" &&
                      shape !== "blank" &&
                      (gw === currentGw
                        ? "bg-[var(--gw-current-bg)] text-label"
                        : gw < currentGw
                          ? "bg-[var(--gw-past-bg)] text-label"
                          : "bg-[var(--gw-future-bg)] text-label"),
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
              className="grid h-[38px] grid-cols-[150px_1fr] items-center gap-3.5 border-t border-[#16191b]"
            >
              <div className="flex flex-col gap-0.5">
                <div className="text-body text-primary">{CHIP_LABEL[name]}</div>
                <div className="font-mono text-micro tracking-[0.1em] text-fainter">
                  {windows
                    .map((w) => `GW${w.startEvent}–${w.stopEvent}`)
                    .join(" · ")}
                </div>
              </div>
              <div
                className="grid gap-0.5"
                style={{
                  gridTemplateColumns: `repeat(${TOTAL_GAMEWEEKS}, minmax(0, 1fr))`,
                }}
              >
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
                        "h-3.5 border-b",
                        open
                          ? closingSoon
                            ? "bg-[#1e2124]"
                            : "bg-[#191c1f]"
                          : "bg-[#101315]",
                        open && shape === "double"
                          ? "border-[var(--gw-double-bg)]"
                          : open && shape === "blank"
                            ? "border-[var(--gw-blank-bg)]"
                            : "border-transparent",
                      )}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </Panel>

      {counts === null ? (
        <div className="mt-6">
          <Pending phase="fixture sync">
            The fixture list could not be fetched, so blanks and doubles are not
            marked above.
          </Pending>
        </div>
      ) : null}

      <div className="mt-6">
        <SectionLabel>CHIP ADVISORIES</SectionLabel>
        <Pending phase="phase 4 — chip strategy">
          Which gameweek to play each chip, with a confidence level and an
          urgency score that rises as the window closes. The windows and the
          blank/double calendar above are the inputs; the recommendation needs
          the expected-points model on top.
        </Pending>
      </div>
    </div>
  );
}
