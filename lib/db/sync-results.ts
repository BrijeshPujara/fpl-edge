import "server-only";

import { getBootstrapStatic, getEventLive } from "@/lib/fpl/client";
import type { FplLiveElement } from "@/lib/fpl/schemas";
import type { Db } from "./client";
import { resolvePredictions } from "./predictions";
import { refitRatings } from "./ratings";
import type { TablesInsert } from "./types.generated";

/**
 * Syncing played-gameweek results into `player_gw_stats`.
 *
 * This is the table the whole project exists to accumulate: the expected-points
 * model reads appearance history from it, and without this job it stays empty
 * forever and the projections never activate.
 *
 * One call to `event/{gw}/live/` returns every player's stats for a gameweek —
 * 38 calls for a season, against roughly 700 to `element-summary`.
 *
 * DOUBLE GAMEWEEKS are why this is not a straight copy. `stats` is aggregated
 * across every fixture a player featured in, but the table is keyed on
 * (player_id, fixture_id) so doubles need one row per fixture. The `explain`
 * array carries per-fixture values for everything that scores points, so those
 * are read from there. Expected goals and assists are not point-scoring and
 * appear only in the aggregate, so they are apportioned by minutes share — an
 * approximation, and the only one in this file.
 */

/** Identifiers in `explain[].stats[]`, mapped to our column names. */
const EXPLAIN_MAP: Record<string, keyof PerFixtureStats> = {
  minutes: "minutes",
  goals_scored: "goals",
  assists: "assists",
  clean_sheets: "clean_sheets",
  goals_conceded: "goals_conceded",
  yellow_cards: "yellow_cards",
  red_cards: "red_cards",
  bonus: "bonus",
  bps: "bps",
  defensive_contribution: "defensive_contribution",
  starts: "starts",
};

interface PerFixtureStats {
  minutes: number;
  starts: number;
  goals: number;
  assists: number;
  clean_sheets: number;
  goals_conceded: number;
  yellow_cards: number;
  red_cards: number;
  bonus: number;
  bps: number;
  defensive_contribution: number;
  total_points: number;
}

function emptyStats(): PerFixtureStats {
  return {
    minutes: 0, starts: 0, goals: 0, assists: 0, clean_sheets: 0,
    goals_conceded: 0, yellow_cards: 0, red_cards: 0, bonus: 0, bps: 0,
    defensive_contribution: 0, total_points: 0,
  };
}

/** Fixture metadata needed to place a row: who they played, and where. */
export interface FixtureLookup {
  id: number;
  gw: number | null;
  home_team: number;
  away_team: number;
}

export interface SyncResultsResult {
  gameweeksSynced: number[];
  gameweeksSkipped: number[];
  rowsWritten: number;
  /** Scoreline predictions scored against the results that just landed. */
  predictionsResolved: number;
  /** What the refitted ratings now rest on, or null if they were not refitted. */
  ratingBasis: string | null;
  /** How much this season now counts, 0 to 1. */
  ratingBlendWeight: number | null;
}

/**
 * Split a live element into one set of stats per fixture.
 *
 * Exported for testing — doubles are rare enough in a season that they must be
 * covered by tests rather than discovered in production.
 */
export function splitByFixture(
  element: FplLiveElement,
): Map<number, PerFixtureStats> {
  const byFixture = new Map<number, PerFixtureStats>();

  for (const entry of element.explain) {
    const stats = byFixture.get(entry.fixture) ?? emptyStats();
    for (const stat of entry.stats) {
      const column = EXPLAIN_MAP[stat.identifier];
      if (column) stats[column] = stat.value;
      stats.total_points += stat.points;
    }
    byFixture.set(entry.fixture, stats);
  }

  // A player in the squad but unused has no explain entries at all. That is a
  // real zero-minute appearance record and belongs in the history, otherwise
  // the minutes model cannot tell "did not play" from "was not in the data".
  if (byFixture.size === 0) return byFixture;

  // The aggregate is authoritative for total points; reconcile when a single
  // fixture is involved so rounding in `explain` cannot drift.
  if (byFixture.size === 1) {
    const only = [...byFixture.values()][0];
    only.total_points = element.stats.total_points;
    only.minutes = element.stats.minutes;
    only.starts = element.stats.starts;
  }

  return byFixture;
}

export async function syncResults(
  db: Db,
  options: { gameweeks?: number[]; force?: boolean } = {},
): Promise<SyncResultsResult> {
  const bootstrap = await getBootstrapStatic({ revalidate: 0 });

  // Only gameweeks the API considers finished AND checked. `finished` flips
  // when the last match ends, but bonus points and stats are provisional until
  // `data_checked` — syncing early would store numbers that later change.
  const finished = bootstrap.events
    .filter((e) => e.finished && e.data_checked)
    .map((e) => e.id);

  const wanted = options.gameweeks ?? finished;
  const targets = wanted.filter((gw) => finished.includes(gw));

  const { data: fixtureRows, error: fixtureError } = await db
    .from("fixtures")
    .select("id, gw, home_team, away_team");
  if (fixtureError) {
    throw new Error(`Failed to read fixtures: ${fixtureError.message}`);
  }
  const fixtures = new Map<number, FixtureLookup>(
    (fixtureRows ?? []).map((f) => [f.id, f]),
  );

  // Read once, not once per gameweek. Needed to resolve which side of a
  // fixture each player was on, and hence their opponent.
  const { data: playerRows, error: playerError } = await db
    .from("players")
    .select("id, team_id, now_cost");
  if (playerError) {
    throw new Error(`Failed to read players: ${playerError.message}`);
  }
  const clubOf = new Map((playerRows ?? []).map((p) => [p.id, p.team_id]));
  const costOf = new Map((playerRows ?? []).map((p) => [p.id, p.now_cost]));

  const synced: number[] = [];
  const skipped: number[] = [];
  let rowsWritten = 0;

  for (const gw of targets) {
    if (!options.force) {
      const { count } = await db
        .from("player_gw_stats")
        .select("*", { count: "exact", head: true })
        .eq("gw", gw);
      if ((count ?? 0) > 0) {
        skipped.push(gw);
        continue;
      }
    }

    const live = await getEventLive(gw, { revalidate: 0 });
    const rows: TablesInsert<"player_gw_stats">[] = [];

    for (const element of live.elements) {
      const byFixture = splitByFixture(element);
      if (byFixture.size === 0) continue;

      const totalMinutes =
        [...byFixture.values()].reduce((sum, s) => sum + s.minutes, 0) || 1;

      for (const [fixtureId, stats] of byFixture) {
        const fixture = fixtures.get(fixtureId);
        // A fixture we have no record of cannot be placed. Skipping is right:
        // guessing the opponent would poison the model's opponent adjustment.
        if (!fixture) continue;

        // Expected goals and assists exist only in the aggregate, so a double
        // gameweek apportions them by minutes share. This is the one
        // approximation in the file; every point-scoring stat is exact.
        const share = stats.minutes / totalMinutes;

        rows.push({
          player_id: element.id,
          gw,
          fixture_id: fixtureId,
          // Filled in after the player -> team join below.
          opponent_team: 0,
          was_home: false,
          minutes: stats.minutes,
          starts: stats.starts,
          goals: stats.goals,
          assists: stats.assists,
          clean_sheets: stats.clean_sheets,
          goals_conceded: stats.goals_conceded,
          yellow_cards: stats.yellow_cards,
          red_cards: stats.red_cards,
          expected_goals: element.stats.expected_goals * share,
          expected_assists: element.stats.expected_assists * share,
          expected_goals_conceded: element.stats.expected_goals_conceded * share,
          defensive_contribution: stats.defensive_contribution,
          bonus: stats.bonus,
          bps: stats.bps,
          total_points: stats.total_points,
          value: 0,
        });
      }
    }

    // Resolve opponent and venue from the player's own club.
    const placed = rows.filter((row) => {
      const teamId = clubOf.get(row.player_id);
      const fixture = fixtures.get(row.fixture_id);
      if (teamId === undefined || !fixture) return false;
      const isHome = fixture.home_team === teamId;
      row.was_home = isHome;
      row.opponent_team = isHome ? fixture.away_team : fixture.home_team;
      row.value = costOf.get(row.player_id) ?? 0;
      return true;
    });

    for (let i = 0; i < placed.length; i += 500) {
      const chunk = placed.slice(i, i + 500);
      const { error } = await db
        .from("player_gw_stats")
        .upsert(chunk, { onConflict: "player_id,fixture_id" });
      if (error) {
        throw new Error(
          `Failed to write ${chunk.length} stat rows for GW${gw}: ${error.message}`,
        );
      }
    }

    rowsWritten += placed.length;
    synced.push(gw);
  }

  /*
   * Score any scoreline predictions these results settle.
   *
   * Every finished gameweek is checked, not only the ones written above. A
   * gameweek whose stats were already stored is SKIPPED by the loop, but a
   * prediction made for it may still be unscored — the two are written by
   * different actions at different times, and tying resolution to the stats
   * write would silently leave those predictions hanging forever.
   *
   * Never allowed to fail the sync. Results are the irreplaceable part of this
   * job; a scoring pass is not, and it is idempotent, so the next run picks up
   * anything a failure here left behind.
   */
  let predictionsResolved = 0;
  // The CURRENT gameweek as well as finished ones. A prediction needs only the
  // score, which is final at the whistle — unlike bonus, which is why this job
  // waits for `data_checked` before touching player stats. Waiting for it here
  // too left a Friday result unscored until Monday.
  const current = bootstrap.events.find((e) => e.is_current)?.id;
  const toResolve = [...new Set([...targets, ...(current ? [current] : [])])];
  for (const gw of toResolve) {
    predictionsResolved += await resolvePredictions(db, gw).catch(() => 0);
  }

  /*
   * Move the team ratings toward this season, now that more of it has been
   * played. Last, and equally unable to fail the sync.
   *
   * Frozen prior-season ratings do not merely stop improving — measured over
   * 2025/26 they DECAY, from RPS 0.2166 in the opening six gameweeks to 0.2295
   * in the closing nineteen, as the league drifts away from the season they
   * describe. This is what stops that.
   */
  const refit = await refitRatings(db).catch(() => null);

  return {
    gameweeksSynced: synced,
    gameweeksSkipped: skipped,
    rowsWritten,
    predictionsResolved,
    ratingBasis: refit?.status === "refitted" ? refit.basis : null,
    ratingBlendWeight: refit?.status === "refitted" ? refit.weight : null,
  };
}
