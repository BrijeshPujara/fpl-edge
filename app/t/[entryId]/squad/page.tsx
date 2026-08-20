import { getSeasonContext } from "@/lib/fpl/season";
import { getDb, isDbConfigured } from "@/lib/db/client";
import {
  getFixturesFrom,
  getLatestSquad,
  getPlayersByIds,
  getRecentStats,
  getTeams,
} from "@/lib/db/queries";
import { buildSquadView } from "@/lib/squad/view";
import { notFound } from "next/navigation";
import { parseEntryId } from "@/lib/fpl/entry";
import { FORM_WINDOW } from "@/lib/engine/constants";
import { ep as formatEp, money } from "@/lib/format";
import { Panel, SectionLabel, StatRow } from "@/components/ui/panel";
import { Pending } from "@/components/ui/pending";
import { FixtureDifficultyKey } from "@/components/ui/fixture-strip";
import { Bench, Pitch } from "@/components/squad/pitch";

/**
 * The squad pitch view, rendered from the database rather than the live API.
 *
 * Note the pre-deadline case, which is not an error: picks do not exist
 * publicly until a gameweek's deadline has passed, so before the first deadline
 * there is genuinely nothing to render.
 */
export default async function SquadPage({
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
        The FPL API is unreachable, so the gameweek cannot be resolved.
      </Pending>
    );
  }

  if (!isDbConfigured()) {
    return (
      <Pending phase="configuration">
        Supabase is not configured. Set{" "}
        <code className="font-mono text-tertiary">NEXT_PUBLIC_SUPABASE_URL</code>{" "}
        and{" "}
        <code className="font-mono text-tertiary">
          SUPABASE_SERVICE_ROLE_KEY
        </code>
        .
      </Pending>
    );
  }

  const { target } = season.gameweek;
  const db = getDb();
  const stored = await getLatestSquad(db, entryId, target.id);

  if (!stored) {
    return (
      <Pending phase="the first deadline">
        No squad has been synced yet. The FPL API only publishes a manager&apos;s
        picks once a gameweek&apos;s deadline has passed, so there is nothing to
        render until <span className="text-tertiary">{target.name}</span> locks.
        Once it has, use{" "}
        <span className="text-tertiary">refresh squad</span> above to pull it
        straight away — the scheduled sync would not otherwise reach it until
        the following morning.
      </Pending>
    );
  }

  const playerIds = stored.picks.map((p) => p.player_id);
  const [players, teams, fixtures, stats] = await Promise.all([
    getPlayersByIds(db, playerIds),
    getTeams(db),
    getFixturesFrom(db, target.id, target.id + 6),
    getRecentStats(db, playerIds, Math.max(1, target.id - FORM_WINDOW)),
  ]);

  const view = buildSquadView({
    gw: target.id,
    picks: stored.picks,
    players,
    teams,
    fixtures,
    stats,
  });

  return (
    <div className="grid grid-cols-1 items-start gap-4 sm:gap-6 lg:grid-cols-[1fr_300px]">
      <div className="flex flex-col gap-4 sm:gap-6">
        <div>
          <SectionLabel
            meta={`FIXTURE DIFFICULTY GW${view.gw}–${view.gw + 4} · LEFT TO RIGHT`}
          >
            SQUAD · {view.formation} · GW{view.gw}
          </SectionLabel>
          <Pitch squad={view} />
        </div>

        <div>
          <SectionLabel meta="AUTO-SUB ORDER">BENCH</SectionLabel>
          <Bench players={view.bench} />
        </div>
      </div>

      <div className="flex flex-col gap-4 sm:gap-6">
        <div>
          <SectionLabel>SQUAD TOTALS</SectionLabel>
          <Panel>
            {view.preSeason ? (
              <StatRow label="Projections" value="AWAITING GW1" tone="warn" />
            ) : (
              <>
                <StatRow
                  label="Starting XI EP"
                  value={formatEp(view.totals.startingEp)}
                />
                <StatRow
                  label="Captain bonus"
                  value={`+${formatEp(view.totals.captainBonus)}`}
                  tone="accent"
                />
                <StatRow
                  label="Projected total"
                  value={formatEp(view.totals.projectedTotal)}
                  tone="accent"
                />
                <StatRow
                  label="Bench EP"
                  value={formatEp(view.totals.benchEp)}
                  tone="muted"
                />
              </>
            )}
            <StatRow label="Squad value" value={money(view.totals.squadValue)} />
            <StatRow
              label="Mean fixture difficulty"
              value={
                view.totals.meanDifficulty === null
                  ? "—"
                  : view.totals.meanDifficulty.toFixed(2)
              }
              tone="muted"
            />
            <StatRow
              label="Flagged players"
              value={String(view.totals.flaggedCount)}
              tone={view.totals.flaggedCount > 0 ? "warn" : "primary"}
            />
          </Panel>
        </div>

        {view.preSeason ? (
          <div>
            <SectionLabel>ON THE PROJECTIONS</SectionLabel>
            <Pending phase="gameweek 1">
              Expected points need appearance history to mean anything. Until a
              gameweek has been played the model cannot tell these players
              apart, so it shows an em dash rather than a number it has not
              earned. Names, prices, fixture difficulty and fitness flags are
              all live now.
            </Pending>
          </div>
        ) : null}

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
