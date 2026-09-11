/**
 * The candidate pool, loaded once for whichever script needs it.
 *
 * Everything here mirrors `lib/db/decision-context.ts` except the part that
 * needs a squad to exist — which is exactly the part that cannot run before
 * the first deadline. Shared rather than copied, so the scripts cannot drift
 * into disagreeing about what a player is worth.
 */
import { getDb } from "@/lib/db/client";
import {
  getAllPlayers,
  getFixturesFrom,
  getRecentStats,
  getSeasonHistory,
  getTeams,
  type FixtureRow,
  type PlayerRow,
  type TeamRow,
} from "@/lib/db/queries";
import { getTeamRatingRows } from "@/lib/db/ratings";
import { getSeasonContext } from "@/lib/fpl/season";
import { buildCandidatePool, type Candidate } from "@/lib/squad/candidates";
import {
  mostRecentRates,
  mostRecentWorkload,
  ratesFromSeason,
  type PriorSeasonWorkload,
} from "@/lib/engine/prior-season";
import type { PriorSeasonRates } from "@/lib/engine/expected-points";
import { FORM_WINDOW } from "@/lib/engine/constants";

/** The season that just finished — the one whose workload proves a player plays. */
export const LAST_SEASON = "2025/26";

export interface Evidence {
  /** Which season the player's rates actually came from. */
  from: string;
  lastMinutes: number;
  lastStarts: number;
}

export interface LoadedPool {
  gw: number;
  gwName: string;
  horizon: number;
  players: PlayerRow[];
  teams: TeamRow[];
  fixtures: FixtureRow[];
  candidates: Candidate[];
  basis: "none" | "prior-season" | "this-season";
  /** Whether the opponent adjustment is live. See `CandidatePool`. */
  fixtureAware: boolean;
  evidenceFor: (playerId: number) => Evidence | undefined;
}

export interface LoadPoolOptions {
  horizon: number;
}

export async function loadPool(options: LoadPoolOptions): Promise<LoadedPool> {
  const { horizon } = options;
  const season = await getSeasonContext();
  if (!season.available) throw new Error("FPL API unavailable");
  const { target } = season.gameweek;

  const db = getDb();
  const [players, teams, teamRatings, fixtures] = await Promise.all([
    getAllPlayers(db),
    getTeams(db),
    getTeamRatingRows(db),
    getFixturesFrom(db, target.id, target.id + horizon),
  ]);
  const stats = await getRecentStats(
    db,
    players.map((p) => p.id),
    Math.max(1, target.id - FORM_WINDOW),
  );

  const history = await getSeasonHistory(
    db,
    players.map((p) => p.code),
  );
  const byCode = new Map<number, typeof history>();
  for (const row of history) {
    byCode.set(row.player_code, [...(byCode.get(row.player_code) ?? []), row]);
  }

  const priorSeasons = new Map<number, PriorSeasonRates>();
  /*
   * Workloads, and the reason they are separate from rates.
   *
   * `mostRecentRates` is gated on a minutes threshold, because a scoring rate
   * from ninety minutes of football is noise. A START RATE from those same
   * ninety minutes is not noise, it is the answer — so the workload survives a
   * looser gate and has to be collected separately.
   *
   * Omitting this is what made the scripts disagree with the app. Without a
   * workload every player fell back to the flat no-history prior of roughly 41
   * expected minutes, which is the bug 996fa39 fixed for `decision-context.ts`
   * and left here: the app projected B.Fernandes at 5.7 for GW2 while this
   * file projected 3.8, on the same data, for the same gameweek.
   */
  const priorWorkloads = new Map<number, PriorSeasonWorkload>();
  const evidence = new Map<number, Evidence>();

  for (const [code, seasons] of byCode) {
    const totals = seasons.map((s) => ({
      seasonName: s.season_name,
      minutes: s.minutes,
      starts: s.starts,
      expectedGoals: s.expected_goals,
      expectedAssists: s.expected_assists,
      bonus: s.bonus,
    }));
    const rates = mostRecentRates(totals);
    if (rates !== null) priorSeasons.set(code, rates);

    const workload = mostRecentWorkload(totals);
    if (workload !== null) priorWorkloads.set(code, workload);

    // The season the rates came from is the most recent one `ratesFromSeason`
    // accepts — recomputed here rather than returned, so the engine keeps its
    // narrow interface.
    const usable = [...totals]
      .sort((a, b) => b.seasonName.localeCompare(a.seasonName))
      .find((t) => ratesFromSeason(t) !== null);
    const last = totals.filter((t) => t.seasonName === LAST_SEASON);

    evidence.set(code, {
      from: usable?.seasonName ?? "—",
      lastMinutes: last.reduce((a, t) => a + t.minutes, 0),
      lastStarts: last.reduce((a, t) => a + t.starts, 0),
    });
  }

  /*
   * There is no `--fdr` escape hatch any more, and its absence is the point.
   *
   * It existed to substitute the coarse 1-5 `strength_overall_*` tiers into the
   * attack and defence splits, because those splits read zero and fixture
   * difficulty contributed nothing. The splits are no longer where difficulty
   * comes from — `team_ratings` is — so the flag would now be a SECOND, worse
   * projection path, and a script quietly ranking players differently from the
   * app is the failure this codebase works hardest to avoid.
   */
  const pool = buildCandidatePool({
    gw: target.id,
    horizon,
    players,
    teams,
    teamRatings,
    fixtures,
    stats,
    priorSeasons,
    priorWorkloads,
  });

  const codeOf = new Map(players.map((p) => [p.id, p.code]));

  return {
    gw: target.id,
    gwName: target.name,
    horizon,
    players,
    teams,
    fixtures,
    candidates: pool.candidates,
    basis: pool.basis,
    fixtureAware: pool.fixtureAware,
    evidenceFor: (playerId) => evidence.get(codeOf.get(playerId) ?? -1),
  };
}
