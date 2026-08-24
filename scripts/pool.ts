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
  evidenceFor: (playerId: number) => Evidence | undefined;
}

export interface LoadPoolOptions {
  horizon: number;
  /**
   * Substitute overall strength into the attack and defence splits.
   *
   * Pre-season FPL leaves those splits at zero, so `ratingStats` finds nothing
   * usable and every opponent is scored league-average — the documented
   * neutral-1.0 fallback, working as designed, but it means fixture difficulty
   * contributes NOTHING to the ranking. This is an approximation, since a side
   * strong overall is assumed strong at both ends, but a far better one than
   * "every opponent is identical".
   */
  useFdr?: boolean;
}

export async function loadPool(options: LoadPoolOptions): Promise<LoadedPool> {
  const { horizon } = options;
  const season = await getSeasonContext();
  if (!season.available) throw new Error("FPL API unavailable");
  const { target } = season.gameweek;

  const db = getDb();
  const [players, teams, fixtures] = await Promise.all([
    getAllPlayers(db),
    getTeams(db),
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

  const ratedTeams = options.useFdr
    ? teams.map((t) => ({
        ...t,
        strength_attack_home: t.strength_attack_home || t.strength_overall_home,
        strength_attack_away: t.strength_attack_away || t.strength_overall_away,
        strength_defence_home:
          t.strength_defence_home || t.strength_overall_home,
        strength_defence_away:
          t.strength_defence_away || t.strength_overall_away,
      }))
    : teams;

  const pool = buildCandidatePool({
    gw: target.id,
    horizon,
    players,
    teams: ratedTeams,
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
    evidenceFor: (playerId) => evidence.get(codeOf.get(playerId) ?? -1),
  };
}
