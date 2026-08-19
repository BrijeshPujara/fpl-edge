import { getSeasonContext } from "@/lib/fpl/season";
import { getEntryPicksIfAvailable } from "@/lib/fpl/client";
import { Panel, SectionLabel } from "@/components/ui/panel";
import { Pending } from "@/components/ui/pending";
import { FixtureDifficultyKey } from "@/components/ui/fixture-strip";

/**
 * The squad pitch view.
 *
 * Note the pre-deadline case: `entry/{id}/event/{gw}/picks/` does not exist
 * until a gameweek's deadline has passed, so before GW1 there is genuinely no
 * public squad to render. That is a state to explain, not an error.
 */
export default async function SquadPage() {
  const season = await getSeasonContext();
  const teamId = process.env.FPL_TEAM_ID;

  if (!season.available) {
    return (
      <Pending phase="upstream recovery">
        The FPL API is unreachable, so the squad cannot be resolved.
      </Pending>
    );
  }

  if (!teamId) {
    return (
      <Pending phase="configuration">
        Set <code className="font-mono text-tertiary">FPL_TEAM_ID</code> in your
        environment — it is the number in your FPL team URL, e.g.{" "}
        <code className="font-mono text-tertiary">
          /entry/1234567/event/1
        </code>
        .
      </Pending>
    );
  }

  const { target, previous } = season.gameweek;
  // Picks only exist for gameweeks whose deadline has passed.
  const settledGw = previous?.id ?? (season.gameweek.current?.id ?? null);
  const picks =
    settledGw === null
      ? null
      : await getEntryPicksIfAvailable(Number(teamId), settledGw);

  return (
    <div className="grid grid-cols-1 items-start gap-4 sm:gap-6 lg:grid-cols-[1fr_300px]">
      <div>
        <SectionLabel meta="FIXTURE DIFFICULTY · LEFT TO RIGHT">
          SQUAD · {target.name.toUpperCase()}
        </SectionLabel>
        {picks === null ? (
          <Pending phase="the first deadline">
            No squad is published for this team yet. The FPL API only exposes a
            manager&apos;s picks once a gameweek&apos;s deadline has passed, so
            there is nothing to render until{" "}
            <span className="text-tertiary">{target.name}</span> locks. The
            sync will pick it up automatically after that.
          </Pending>
        ) : (
          <Pending phase="phase 1 — pitch view">
            {picks.picks.length} picks retrieved for gameweek{" "}
            {picks.entry_history.event}. The pitch view renders these once the
            player reference data is in the database.
          </Pending>
        )}
      </div>

      <div className="flex flex-col gap-4 sm:gap-6">
        <div>
          <SectionLabel>SQUAD TOTALS</SectionLabel>
          <Pending phase="phase 2 — expected points">
            Starting XI EP, captain bonus and bench waste. Needs the EP model.
          </Pending>
        </div>
        <div>
          <SectionLabel>DIFFICULTY KEY</SectionLabel>
          <Panel>
            <FixtureDifficultyKey />
          </Panel>
        </div>
      </div>
    </div>
  );
}
