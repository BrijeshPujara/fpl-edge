import { getSeasonContext } from "@/lib/fpl/season";
import { getFixtures } from "@/lib/fpl/client";
import {
  classifyGameweek,
  countFixturesByTeam,
  deadlineOf,
  gameweeksUntilExpiry,
} from "@/lib/fpl/gameweek";
import { CHIP_LABEL, type ChipName } from "@/lib/rules";
import { deadlineStamp } from "@/lib/format";
import { loadDecisionContext } from "@/lib/db/decision-context";
import { DEFAULT_HORIZON } from "@/lib/engine/constants";
import { DeadlineCountdown } from "@/components/chrome/deadline-countdown";
import { FlagPanel, WeekPanels } from "@/components/dashboard/week-panels";
import { Panel, Row, SectionLabel, StatRow } from "@/components/ui/panel";
import { Pending } from "@/components/ui/pending";

export default async function DashboardPage() {
  const season = await getSeasonContext();

  if (!season.available) {
    return (
      <Pending phase="upstream recovery">
        The dashboard reads its gameweek, deadline and chip windows from the FPL
        API. It is currently unreachable, so there is nothing truthful to show.
      </Pending>
    );
  }

  const { target, isPreSeason } = season.gameweek;
  const deadline = deadlineOf(target);

  // Blank and double detection is available from day one — it needs only the
  // fixture list, no model and no squad.
  const fixtures = await getFixtures().catch(() => null);
  const shape =
    fixtures === null
      ? null
      : classifyGameweek(
          countFixturesByTeam(
            fixtures,
            season.teams.map((t) => t.id),
          ).get(target.id),
        );

  // The squad-dependent half of the screen. Everything above this point works
  // from the API alone and renders whatever happens here.
  const context = await loadDecisionContext(DEFAULT_HORIZON);
  const ready = context.state === "ready" && context.projectable;

  const chipUrgency = (["wildcard", "freehit", "3xc", "bboost"] as ChipName[])
    .map((name) => ({
      name,
      remaining: gameweeksUntilExpiry(season.chipWindows, name, target.id),
    }))
    .filter((c) => c.remaining !== null);

  return (
    <div className="grid grid-cols-1 items-start gap-4 sm:gap-6 lg:grid-cols-[1fr_340px]">
      <div className="flex flex-col gap-4 sm:gap-6">
        {ready ? (
          <WeekPanels context={context} />
        ) : (
          <div>
            <SectionLabel meta={`HORIZON ${DEFAULT_HORIZON} GW`}>
              RECOMMENDED ACTIONS
            </SectionLabel>
            {context.state === "no-db" ? (
              <Pending phase="configuration">
                Supabase is not configured, so there is no squad to advise on.
              </Pending>
            ) : context.state === "no-squad" ? (
              <Pending phase="the first deadline">
                The engine is built and waiting. FPL only publishes a
                manager&apos;s picks once a gameweek deadline has passed, so
                there is no squad to advise on until{" "}
                <span className="text-tertiary">{target.name}</span> locks.
              </Pending>
            ) : (
              <Pending phase="gameweek 1">
                The engine is built and your squad is loaded, but no gameweek
                has been played. Expected points need appearance history, and
                without it every player projects the same — so a ranked list of
                actions would be an ordering of nothing.
                <br />
                <br />
                To watch the screen work before then, run{" "}
                <code className="font-mono text-tertiary">npm run backtest</code>{" "}
                once and open{" "}
                <code className="font-mono text-tertiary">/preview</code> in
                development.
              </Pending>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-4 sm:gap-6">
        <div>
          <SectionLabel>DEADLINE PRESSURE</SectionLabel>
          <Panel padded>
            <div className="font-mono text-hero font-medium tracking-[-0.02em] text-warn sm:text-display">
              <DeadlineCountdown deadline={target.deadline_time} />
            </div>
            <div className="mt-2 font-mono text-tiny tracking-[0.1em] text-label">
              {deadlineStamp(deadline)}
            </div>
            <div className="mt-3.5 flex flex-col gap-2">
              <PressureRow label="Gameweek" value={String(target.id)} />
              <PressureRow
                label="Gameweek shape"
                value={shape ? shape.toUpperCase() : "—"}
                tone={shape === "normal" || shape === null ? "muted" : "warn"}
              />
              <PressureRow
                label="Season state"
                value={isPreSeason ? "PRE-SEASON" : "IN PROGRESS"}
              />
            </div>
          </Panel>
        </div>

        <div>
          <SectionLabel meta="FROM BOOTSTRAP-STATIC">CHIP WINDOWS</SectionLabel>
          <Panel>
            {chipUrgency.length === 0 ? (
              <Row className="flex" height="table">
                <div className="text-small text-muted">
                  No chip window is open for {target.name}.
                </div>
              </Row>
            ) : (
              chipUrgency.map((chip) => (
                <StatRow
                  key={chip.name}
                  label={CHIP_LABEL[chip.name]}
                  value={`${chip.remaining} GW left`}
                  tone={
                    chip.remaining !== null && chip.remaining <= 4
                      ? "warn"
                      : "primary"
                  }
                />
              ))
            )}
          </Panel>
        </div>

        <div>
          <SectionLabel>FLAGS</SectionLabel>
          {context.state === "ready" ? (
            <FlagPanel squad={context.squad} />
          ) : (
            <Pending phase="the first deadline">
              Fitness flags for your own fifteen. Needs a synced squad, which
              needs a deadline to have passed.
            </Pending>
          )}
        </div>
      </div>
    </div>
  );
}

function PressureRow({
  label,
  value,
  tone = "primary",
}: {
  label: string;
  value: string;
  tone?: "primary" | "warn" | "muted";
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-edge pt-2">
      <div className="text-small text-muted">{label}</div>
      <div
        className={
          "font-mono text-small " +
          (tone === "warn"
            ? "text-warn"
            : tone === "muted"
              ? "text-muted"
              : "text-primary")
        }
      >
        {value}
      </div>
    </div>
  );
}
