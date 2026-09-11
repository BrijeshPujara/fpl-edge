import {
  expectedPointsOverHorizon,
  type FixtureContext,
  type GameweekSample,
  type PlayerModelInput,
} from "@/lib/engine/expected-points";
import { FORM_WINDOW } from "@/lib/engine/constants";
import { readNewsSignal } from "@/lib/engine/news-signal";
import type { PriorSeasonRates } from "@/lib/engine/expected-points";
import type { PriorSeasonWorkload } from "@/lib/engine/prior-season";
import type { PositionId } from "@/lib/rules";
import type { FixtureLike, PlayerLike, StatLike } from "./view";

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

/**
 * One club's fitted rating, as `team_ratings` stores it.
 *
 * Structural rather than the generated row type, for the same reason every
 * other `*Like` here is: this module stays testable with literals.
 */
export interface TeamRatingLike {
  team_id: number;
  /** Goals scored relative to league average. Higher is better. */
  attack: number;
  /** Goals CONCEDED relative to league average. Higher is WORSE. */
  defence: number;
}

/**
 * Per-club strength plus the league distribution to normalise it against.
 *
 * Both numbers are in STRENGTH convention — higher is stronger — which is what
 * `FixtureContext` documents and what `opponentAdjustment` assumes. Converting
 * once, here, is what keeps that assumption true at every call site.
 */
export interface FixtureRatings {
  byTeam: Map<number, { attack: number; defence: number }>;
  attack: RatingStats | null;
  defence: RatingStats | null;
  /** False when nothing usable was supplied and every fixture reads neutral. */
  usable: boolean;
}

/**
 * League mean and spread of a rating.
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

/**
 * Fixture strengths, from the ratings this project fits itself.
 *
 * WHY NOT THE API'S OWN STRENGTH FIELDS, which this used to read. FPL has
 * served `strength_attack_home`, `strength_attack_away`, `strength_defence_home`
 * and `strength_defence_away` as ZERO for all twenty clubs for the whole of
 * 2026/27 — verified against the live bootstrap, not inferred. They parse, the
 * schema is satisfied, and `ratingStats` then discards them as pre-season
 * zeros and hands back null. The model dutifully answered "no opponent
 * information" for every fixture in the season: Haaland away at Man United and
 * Haaland at home to Hull projected identically, and the term is worth ±1.2
 * points a gameweek on him. Nothing threw. 627 tests stayed green.
 *
 * `team_ratings` is the fix and was already sitting there — a Dixon-Coles fit
 * over played matches blended toward three prior seasons, refitted by the sync,
 * and until now read only by the scoreline model. One rating per club rather
 * than a home and an away one, deliberately: venue is applied once, by
 * `HOME_ADVANTAGE` inside `expectedGoalsAgainst`, and carrying it in the
 * ratings as well would count it twice.
 *
 * THE SIGN. `attack` already means what `FixtureContext` wants — higher is
 * better — but `defence` is a concession factor, so higher is WORSE, the exact
 * opposite of the FPL field it replaces. Passed through unconverted the model
 * would rate every fixture backwards, which is worse than the zeros it
 * replaces. The reciprocal puts it back: a side conceding at 0.7x the league
 * rate is 1/0.7 as hard to score against.
 *
 * Mirroring around the mean (`2 * mean - defence`), the idiom used for attack
 * in `expectedGoalsAgainst`, was tried first and rejected: it goes non-positive
 * for a defence worse than twice the league average, and `opponentAdjustment`
 * silently returns neutral for a non-positive rating — muting the league's
 * worst defence precisely where the adjustment matters most. A reciprocal
 * cannot, and composes the way a rate factor should.
 */
export function fixtureRatings(rows: TeamRatingLike[]): FixtureRatings {
  const byTeam = new Map<number, { attack: number; defence: number }>();

  for (const row of rows) {
    // A non-positive fit is not a rating; skipping beats dividing by it.
    if (!(row.attack > 0) || !(row.defence > 0)) continue;
    byTeam.set(row.team_id, { attack: row.attack, defence: 1 / row.defence });
  }

  const values = [...byTeam.values()];
  const attack = ratingStats(values.map((v) => v.attack));
  const defence = ratingStats(values.map((v) => v.defence));

  return {
    byTeam,
    attack,
    defence,
    usable: attack !== null && defence !== null,
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
  ratings: FixtureRatings,
  gameweeks: number[],
): FixtureContext[] {
  const wanted = new Set(gameweeks);
  const team = ratings.byTeam.get(teamId);

  return fixtures
    .filter(
      (f) =>
        f.gw !== null &&
        wanted.has(f.gw) &&
        (f.home_team === teamId || f.away_team === teamId),
    )
    .map((f) => {
      const isHome = f.home_team === teamId;
      const opponent = ratings.byTeam.get(isHome ? f.away_team : f.home_team);
      return {
        gw: f.gw as number,
        isHome,
        teamDefence: team?.defence ?? null,
        opponentAttack: opponent?.attack ?? null,
        leagueMeanAttack: ratings.attack?.mean ?? null,
        leagueStdAttack: ratings.attack?.std ?? null,
        opponentDefence: opponent?.defence ?? null,
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
  priorSeason: PriorSeasonRates | null = null,
  priorWorkload: PriorSeasonWorkload | null = null,
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
      priorSeason: priorWorkload,
    },
    recent: recentSamplesFor(history),
    priorSeason,
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
  priorSeason: PriorSeasonRates | null = null,
  priorWorkload: PriorSeasonWorkload | null = null,
): ProjectionResult {
  const input = modelInputFor(player, history, priorSeason, priorWorkload);
  const discounted = expectedPointsOverHorizon(input, fixtures, gameweeks);

  const perGameweek = gameweeks.map((gw) => {
    const inGw = fixtures.filter((f) => f.gw === gw);
    const undiscounted = expectedPointsOverHorizon(input, inGw, [gw]);
    return { gw, ep: undiscounted.total, fixtures: inGw.length };
  });

  return { total: discounted.total, perGameweek };
}
