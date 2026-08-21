import "server-only";

import type { Db } from "./client";
import type { MatchResult } from "@/lib/engine/team-ratings";

/**
 * This season's played matches, as the rating fit wants them.
 *
 * The pieces are already in the database and have been since the first sync:
 * `fixtures` carries the score, `player_gw_stats` carries per-player expected
 * goals with the fixture and the side each player was on. Summing xG per side
 * per fixture recovers team xG, which is what the fit actually wants — over
 * 280 held-out matches, xG-fitted ratings beat goals-fitted ones.
 *
 * Keyed on team id, not team name. The historical cache the seed reads is
 * keyed on name because that is all a CSV has; nothing here needs to go
 * through a name at all, and it should not.
 */
export async function getPlayedMatches(
  db: Db,
): Promise<MatchResult<number>[]> {
  const { data: fixtures, error } = await db
    .from("fixtures")
    .select("id, home_team, away_team, home_score, away_score")
    .eq("finished", true)
    .not("home_score", "is", null)
    .not("away_score", "is", null);

  if (error) throw new Error(`Failed to read fixtures: ${error.message}`);
  if (!fixtures || fixtures.length === 0) return [];

  const xg = await sumExpectedGoals(db);

  return fixtures.map((f) => {
    const key = (home: boolean) => `${f.id}:${home}`;
    return {
      home: f.home_team,
      away: f.away_team,
      homeGoals: f.home_score!,
      awayGoals: f.away_score!,
      // A finished fixture with no stats rows yet falls back to the goals it
      // actually produced, rather than to zero — which would tell the fit both
      // sides created nothing and drag their attack ratings down.
      homeXg: xg.get(key(true)) ?? f.home_score!,
      awayXg: xg.get(key(false)) ?? f.away_score!,
    };
  });
}

/**
 * Team xG per fixture per side, keyed `fixtureId:wasHome`.
 *
 * Paged, because PostgREST silently caps a response at 1000 rows and a season
 * of per-player stats is far more than that. A cap hit here would not error —
 * it would return a partial sum, and every rating fitted from it would be
 * quietly wrong in a way nothing downstream could detect.
 */
async function sumExpectedGoals(db: Db): Promise<Map<string, number>> {
  const PAGE = 1000;
  const totals = new Map<string, number>();

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("player_gw_stats")
      .select("fixture_id, was_home, expected_goals")
      .range(from, from + PAGE - 1);

    if (error) {
      throw new Error(`Failed to read gameweek stats: ${error.message}`);
    }
    if (!data || data.length === 0) break;

    for (const row of data) {
      const key = `${row.fixture_id}:${row.was_home}`;
      totals.set(key, (totals.get(key) ?? 0) + Number(row.expected_goals));
    }
    if (data.length < PAGE) break;
  }
  return totals;
}

/**
 * Matches played per club — what the blend schedule is expressed in.
 *
 * Counted rather than inferred from the gameweek number, so a blank gameweek
 * or a double counts for what it actually is. The mean across clubs, because
 * they can differ by one or two mid-season and the schedule wants a single
 * number for the league.
 */
export function matchesPerTeam(matches: MatchResult<number>[]): number {
  if (matches.length === 0) return 0;
  const clubs = new Set(matches.flatMap((m) => [m.home, m.away]));
  return clubs.size === 0 ? 0 : (matches.length * 2) / clubs.size;
}
