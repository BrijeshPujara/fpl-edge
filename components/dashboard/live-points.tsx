import { getDb, isDbConfigured } from "@/lib/db/client";
import { getLatestSquad, getPlayersByIds, getTeams } from "@/lib/db/queries";
import { getLiveGameweek } from "@/lib/fpl/live-context";
import { liveSquad, type LivePlayer } from "@/lib/squad/live";
import { POSITION_SHORT, type PositionId } from "@/lib/rules";
import { Panel, Row, SectionLabel } from "@/components/ui/panel";
import { cn } from "@/lib/cn";

/**
 * What the squad is scoring right now.
 *
 * The one screen here that is about the present rather than the next decision,
 * and it exists because the stored results deliberately lag: `syncResults`
 * waits for the API to report both `finished` and `data_checked`, typically
 * the Monday after a weekend. That lag protects the decision journal, where a
 * provisional number would corrupt the record — but it means that between the
 * first kickoff and Monday, nothing here moved at all.
 *
 * Renders nothing before the first kickoff. There is no score to show, and a
 * row of zeros would look like a failure rather than a gameweek that has not
 * started.
 *
 * Takes the CURRENT gameweek, never the target one. Everything else on this
 * dashboard is about the gameweek being decided, and the moment GW1 kicks off
 * that becomes GW2 — so passing the usual `target` here showed nothing at all
 * the instant it mattered most. `current` is null before the first match of
 * the season and between gameweeks, which is exactly when there is no live
 * score to report.
 */
export async function LivePoints({
  entryId,
  gw,
}: {
  entryId: number;
  /** The gameweek being PLAYED. Null between gameweeks. */
  gw: number | null;
}) {
  if (gw === null || !isDbConfigured()) return null;

  const db = getDb();
  const stored = await getLatestSquad(db, entryId, gw);
  if (!stored) return null;

  // Uncached deliberately: this is the one read in the app where a cached
  // answer is the wrong answer. Shared per request with the header readout and
  // the squad pitch, which want the same thing.
  const live = await getLiveGameweek(gw);
  if (!live?.anyStarted) return null;

  const squad = liveSquad({
    picks: stored.picks.map((p) => ({
      playerId: p.player_id,
      position: p.position,
      isCaptain: p.is_captain,
      isVice: p.is_vice,
    })),
    elements: live.elements,
    startedFixtures: live.startedFixtures,
    chip: stored.squad.chip_played,
  });

  const [players, teams] = await Promise.all([
    getPlayersByIds(
      db,
      squad.players.map((p) => p.playerId),
    ),
    getTeams(db),
  ]);
  const clubOf = new Map(teams.map((t) => [t.id, t.short_name]));
  const detail = new Map(
    players.map((p) => [
      p.id,
      {
        name: p.web_name,
        club: clubOf.get(p.team_id) ?? "???",
        position: p.position as PositionId,
      },
    ]),
  );

  const starting = squad.players.filter((p) => p.multiplier > 0);
  const bench = squad.players.filter((p) => p.multiplier === 0);

  return (
    <div>
      <SectionLabel
        meta={`${live.startedFixtures.size} FIXTURES UNDER WAY`}
      >
        LIVE POINTS
      </SectionLabel>

      <Panel>
        <Row height="tall" className="flex items-baseline justify-between gap-3">
          <div className="font-mono text-micro tracking-[0.12em] text-label">
            GW{gw} SO FAR
          </div>
          <div className="flex items-baseline gap-3">
            {squad.toPlay > 0 ? (
              <span className="font-mono text-micro tracking-[0.1em] text-ghost">
                {squad.toPlay} YET TO PLAY
              </span>
            ) : null}
            <span className="font-mono text-hero font-medium tabular-nums text-accent">
              {squad.total}
            </span>
          </div>
        </Row>

        {starting.map((p) => (
          <PlayerRow key={p.playerId} player={p} detail={detail.get(p.playerId)} />
        ))}

        <Row height="table" className="flex justify-between gap-3">
          <div className="font-mono text-micro tracking-[0.12em] text-label">
            BENCH
          </div>
          <div className="font-mono text-cell tabular-nums text-dim">
            {squad.benchTotal}
          </div>
        </Row>
        {bench.map((p) => (
          <PlayerRow key={p.playerId} player={p} detail={detail.get(p.playerId)} />
        ))}
      </Panel>

      <div className="mt-2 max-w-prose text-small leading-relaxed text-dim text-pretty">
        {squad.provisional ? (
          <>
            Bonus in matches still being played is{" "}
            <span className="text-tertiary">provisional</span>, worked out from
            the BPS standings, and can change until the final whistle.{" "}
          </>
        ) : null}
        Substitutions and the vice-captain resolve only once every match in the
        gameweek has finished, so neither is applied here &mdash; this is the
        same number the official site shows while the football is on.
      </div>
    </div>
  );
}

function PlayerRow({
  player,
  detail,
}: {
  player: LivePlayer;
  detail?: { name: string; club: string; position: PositionId };
}) {
  return (
    <Row
      height="table"
      className="grid grid-cols-[1fr_auto_54px] items-center gap-2"
    >
      <div className="flex min-w-0 items-baseline gap-2 truncate">
        <span className="font-mono text-micro text-ghost">
          {detail ? POSITION_SHORT[detail.position] : "—"}
        </span>
        <span
          className={cn(
            "truncate text-small",
            player.started ? "text-primary" : "text-muted",
          )}
        >
          {detail?.name ?? `#${player.playerId}`}
        </span>
        {player.multiplier > 1 ? (
          <span className="font-mono text-micro text-accent-dim">
            ×{player.multiplier}
          </span>
        ) : null}
      </div>

      <div className="font-mono text-micro tabular-nums text-ghost">
        {player.started ? `${player.minutes}'` : "—"}
        {player.provisionalBonus > 0 ? (
          <span className="ml-1 text-accent-dim">
            +{player.provisionalBonus}?
          </span>
        ) : null}
      </div>

      <div
        className={cn(
          "text-right font-mono text-cell tabular-nums",
          player.counted > 0 ? "text-primary" : "text-muted",
        )}
      >
        {player.counted}
      </div>
    </Row>
  );
}
