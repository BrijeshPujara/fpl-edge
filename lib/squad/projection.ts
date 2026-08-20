import {
  expectedPointsOverHorizon,
  type FixtureContext,
  type GameweekSample,
  type PlayerModelInput,
} from "@/lib/engine/expected-points";
import { FORM_WINDOW } from "@/lib/engine/constants";
import { readNewsSignal } from "@/lib/engine/news-signal";
import type { PositionId } from "@/lib/rules";
import type { FixtureLike, PlayerLike, StatLike, TeamLike } from "./view";

/**
 * Turning database rows into expected points.
 *
 * Pure, and deliberately the ONLY place that does this. Both `/squad` and the
 * optimiser screens project the same players, and if each built its own model
 * input they would drift — a player shown at 5.1 EP on one screen and 4.8 on
 * another destroys the credibility of every number in the app. There is one
 * conversion and everything uses it.
 *
 * Row types are structural, imported from `view.ts`, so this stays independent
 * of the generated Supabase types and testable with literals.
 */

export interface RatingStats {
  mean: number;
  std: number;
}

export interface LeagueRatings {
  attack: RatingStats | null;
  defence: RatingStats | null;
}

/**
 * League mean and spread of a rating, ignoring the zeros reported pre-season.
 *
 * Null when there is nothing to normalise against, which the model reads as
 * "no opponent information" and answers with a neutral adjustment. That is the
 * correct answer rather than a fallback — see `opponentAdjustment`.
 */
export function ratingStats(values: number[]): RatingStats | null {
  const real = values.filter((v) => v > 0);
  if (real.length < 2) return null;
  const mean = real.reduce((a, b) => a + b, 0) / real.length;
  const variance =
    real.reduce((sum, v) => sum + (v - mean) ** 2, 0) / real.length;
  return { mean, std: Math.sqrt(variance) };
}

export function leagueRatings(teams: TeamLike[]): LeagueRatings {
  return {
    attack: ratingStats(
      teams.flatMap((t) => [t.strength_attack_home, t.strength_attack_away]),
    ),
    defence: ratingStats(
      teams.flatMap((t) => [t.strength_defence_home, t.strength_defence_away]),
    ),
  };
}

/**
 * Every fixture a team plays across a span of gameweeks, as model input.
 *
 * Returns one context per FIXTURE, not per gameweek. A double gameweek yields
 * two, a blank yields none, and `expectedPointsOverHorizon` sums whatever it is
 * given — which is what makes doubles and blanks fall out of the arithmetic
 * instead of needing special cases at the call site.
 */
export function fixtureContextsFor(
  teamId: number,
  fixtures: FixtureLike[],
  teamsById: Map<number, TeamLike>,
  ratings: LeagueRatings,
  gameweeks: number[],
): FixtureContext[] {
  const wanted = new Set(gameweeks);
  const team = teamsById.get(teamId);

  return fixtures
    .filter(
      (f) =>
        f.gw !== null &&
        wanted.has(f.gw) &&
        (f.home_team === teamId || f.away_team === teamId),
    )
    .map((f) => {
      const isHome = f.home_team === teamId;
      const opponent = teamsById.get(isHome ? f.away_team : f.home_team);
      return {
        gw: f.gw as number,
        isHome,
        teamDefence: team
          ? isHome
            ? team.strength_defence_home
            : team.strength_defence_away
          : null,
        opponentAttack: opponent
          ? isHome
            ? opponent.strength_attack_away
            : opponent.strength_attack_home
          : null,
        leagueMeanAttack: ratings.attack?.mean ?? null,
        leagueStdAttack: ratings.attack?.std ?? null,
        opponentDefence: opponent
          ? isHome
            ? opponent.strength_defence_away
            : opponent.strength_defence_home
          : null,
        leagueMeanDefence: ratings.defence?.mean ?? null,
        leagueStdDefence: ratings.defence?.std ?? null,
      };
    })
    .sort((a, b) => a.gw - b.gw);
}

/** Recent gameweeks as model samples, most recent first. */
export function recentSamplesFor(history: StatLike[]): GameweekSample[] {
  return history.map((s) => ({
    minutes: s.minutes,
    started: s.starts > 0,
    expectedGoals: s.expected_goals,
    expectedAssists: s.expected_assists,
    defensiveContribution: s.defensive_contribution,
    bonus: s.bonus,
    goalsConceded: s.goals_conceded,
    yellowCards: s.yellow_cards,
    redCards: s.red_cards,
  }));
}

/** A player's history, newest first, trimmed to the form window. */
export function historyFor(
  playerId: number,
  byPlayer: Map<number, StatLike[]>,
): StatLike[] {
  return (byPlayer.get(playerId) ?? []).slice(0, FORM_WINDOW);
}

/** Group stats by player, newest gameweek first within each. */
export function statsByPlayer(stats: StatLike[]): Map<number, StatLike[]> {
  const byPlayer = new Map<number, StatLike[]>();
  for (const s of stats) {
    const list = byPlayer.get(s.player_id) ?? [];
    list.push(s);
    byPlayer.set(s.player_id, list);
  }
  for (const list of byPlayer.values()) list.sort((a, b) => b.gw - a.gw);
  return byPlayer;
}

export function modelInputFor(
  player: PlayerLike,
  history: StatLike[],
): PlayerModelInput {
  return {
    playerId: player.id,
    position: player.position as PositionId,
    teamId: player.team_id,
    minutes: {
      status: player.status,
      chanceOfPlayingNextRound: player.chance_of_playing_next_round,
      recentStarts: history.map((s) => s.starts > 0),
      recentMinutes: history.map((s) => s.minutes),
      newsMultiplier: readNewsSignal(player.news).multiplier,
    },
    recent: recentSamplesFor(history),
    priorSeason: null,
    setPieces: {
      penaltiesOrder: player.penalties_order ?? null,
      cornersOrder: player.corners_order ?? null,
      directFreekicksOrder: player.direct_freekicks_order ?? null,
    },
  };
}

export interface ProjectionResult {
  /** Discounted total across the horizon — what the optimiser maximises. */
  total: number;
  /** Undiscounted EP per gameweek, aligned with the requested gameweeks. */
  perGameweek: { gw: number; ep: number; fixtures: number }[];
}

/**
 * Project one player across a span of gameweeks.
 *
 * `total` carries the horizon discount, because it feeds decisions about a
 * squad that has to survive five weeks. `perGameweek` does not, because chip
 * gains are about a single week actually happening — discounting a Bench Boost
 * for being far away would make the planner systematically impatient, and the
 * chip planner has its own confidence term for exactly that job.
 */
export function projectPlayer(
  player: PlayerLike,
  history: StatLike[],
  fixtures: FixtureContext[],
  gameweeks: number[],
): ProjectionResult {
  const input = modelInputFor(player, history);
  const discounted = expectedPointsOverHorizon(input, fixtures, gameweeks);

  const perGameweek = gameweeks.map((gw) => {
    const inGw = fixtures.filter((f) => f.gw === gw);
    const undiscounted = expectedPointsOverHorizon(input, inGw, [gw]);
    return { gw, ep: undiscounted.total, fixtures: inGw.length };
  });

  return { total: discounted.total, perGameweek };
}
