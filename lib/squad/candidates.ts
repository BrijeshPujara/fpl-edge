import { PLAYER_STATUS, POSITION_SHORT, type PositionId } from "@/lib/rules";
import type { PlayerCandidate } from "@/lib/engine/optimiser";
import type {
  FixtureContext,
  PlayerModelInput,
  PriorSeasonRates,
} from "@/lib/engine/expected-points";
import { projectMinutes } from "@/lib/engine/minutes";
import type { PriorSeasonWorkload } from "@/lib/engine/prior-season";
import { readNewsSignal } from "@/lib/engine/news-signal";
import { MINUTES_KNOWN_GAMEWEEKS } from "@/lib/engine/constants";
import {
  fixtureContextsFor,
  historyFor,
  leagueRatings,
  modelInputFor,
  projectPlayer,
  statsByPlayer,
} from "./projection";
import type { FixtureLike, PlayerLike, StatLike, TeamLike } from "./view";

/**
 * The candidate pool — every player the optimiser is allowed to buy, with a
 * projection attached.
 *
 * Pure. `/transfers` and `/chips` both run on this, and both need more than the
 * optimiser's own `PlayerCandidate` type carries (a name, a club, a per-gameweek
 * breakdown), so `Candidate` wraps it rather than replacing it.
 */

export interface Candidate {
  id: number;
  name: string;
  club: string;
  teamId: number;
  position: PositionId;
  positionShort: string;
  /** Tenths of a million. */
  price: number;
  /** Discounted expected points across the horizon. */
  ep: number;
  /** Undiscounted EP per gameweek — what chip gains are computed from. */
  perGameweek: { gw: number; ep: number; fixtures: number }[];
  pMinutes: number;
  /** Null when fully available; otherwise what the club actually said. */
  flag: { chance: number | null; note: string } | null;
  /** True when the API says the player cannot be selected at all. */
  unavailable: boolean;
  /**
   * The model input this projection was built from, and the fixtures it was
   * built against, both for the gameweek being decided.
   *
   * Carried rather than rebuilt. The captain screen needs the full outcome
   * distribution rather than its mean, and reconstructing these would mean a
   * second assembly of the same inputs — which is exactly how two screens end
   * up disagreeing about the same player.
   */
  modelInput: PlayerModelInput;
  thisGameweek: FixtureContext[];
}

export interface CandidatePool {
  candidates: Candidate[];
  /**
   * Whether the model has anything to tell players apart with.
   *
   * The honesty gate for every ranked screen. It used to mean "a gameweek has
   * been played", which was right when the only source of rates was this
   * season — with nothing played, every projection collapsed to the same
   * positional prior and a ranked table would have been noise dressed as
   * analysis.
   *
   * Prior-season rates changed that. With them loaded the model separates
   * Haaland from a fringe forward before a ball is kicked, so refusing to rank
   * would now be the dishonest answer.
   */
  projectable: boolean;
  /**
   * What the projections currently rest on. The UI needs this to be truthful
   * about a real limitation: with no gameweek played, ATTACKING rates are
   * real but MINUTES are a flat prior for everyone, so the ordering reflects
   * quality rather than who is going to start.
   */
  basis: "none" | "prior-season" | "this-season";
  /** Distinct gameweeks with results behind them. */
  gameweeksPlayed: number;
  /**
   * Whether the model knows enough about who starts to justify a points hit.
   *
   * A VALUE rather than a condition each caller re-derives. It was
   * `basis !== "prior-season"` in three places — the journal, the transfer
   * board and a script — which is one predicate with three chances to drift,
   * and all three were wrong in the same way: `basis` flips to "this-season"
   * on the first stats row that exists, so a single gameweek satisfied it.
   *
   * See MINUTES_KNOWN_GAMEWEEKS for why one is not enough.
   */
  minutesKnown: boolean;
  /** The gameweeks projected, ascending. */
  gameweeks: number[];
}

export interface BuildCandidatePoolInput {
  /** First gameweek of the horizon — the one still being decided. */
  gw: number;
  horizon: number;
  players: PlayerLike[];
  teams: TeamLike[];
  fixtures: FixtureLike[];
  stats: StatLike[];
  /**
   * Last season's rates, by player CODE — stable across seasons, unlike id.
   *
   * Optional, and absent means the model falls back to its own priors. That is
   * what production did for every player until this was wired up, which made
   * the whole early-season shrinkage schedule inert.
   */
  priorSeasons?: Map<number, PriorSeasonRates>;
  /**
   * How much each player started last season, by CODE.
   *
   * Separate from `priorSeasons` because it survives a stricter gate: rates
   * need enough minutes to be stable, a start rate is informative from the
   * first appearance. See `workloadFromSeason`.
   */
  priorWorkloads?: Map<number, PriorSeasonWorkload>;
}

function flagFor(player: PlayerLike): Candidate["flag"] {
  if (player.status === PLAYER_STATUS.available && !player.news) return null;
  return {
    chance: player.chance_of_playing_next_round,
    note: player.news || "Unavailable",
  };
}

export function buildCandidatePool(
  input: BuildCandidatePoolInput,
): CandidatePool {
  const teamsById = new Map(input.teams.map((t) => [t.id, t]));
  const ratings = leagueRatings(input.teams);
  const byPlayer = statsByPlayer(input.stats);
  const gameweeks = Array.from(
    { length: input.horizon },
    (_, i) => input.gw + i,
  );

  // Fixture contexts are per TEAM, not per player, so building them once for
  // twenty clubs rather than once for six hundred players is the difference
  // between a fast page and a slow one.
  const contextsByTeam = new Map(
    input.teams.map((t) => [
      t.id,
      fixtureContextsFor(t.id, input.fixtures, teamsById, ratings, gameweeks),
    ]),
  );

  // This season outranks last: once real gameweeks exist the shrinkage
  // schedule is already blending them, and `basis` describes the stronger of
  // the two rather than both.
  const basis: CandidatePool["basis"] =
    input.stats.length > 0
      ? "this-season"
      : (input.priorSeasons?.size ?? 0) > 0
        ? "prior-season"
        : "none";

  // Counted from the rows rather than inferred from the gameweek number, for
  // the same reason `matchesPerTeam` is: a blank counts for what it is.
  const gameweeksPlayed = new Set(input.stats.map((stat) => stat.gw)).size;

  const candidates: Candidate[] = [];
  for (const player of input.players) {
    const history = historyFor(player.id, byPlayer);
    const contexts = contextsByTeam.get(player.team_id) ?? [];
    const projection = projectPlayer(
      player,
      history,
      contexts,
      gameweeks,
      input.priorSeasons?.get(player.code) ?? null,
      input.priorWorkloads?.get(player.code) ?? null,
    );

    // Drives the optimiser's nailed-bench constraint: a bench slot is only
    // real cover if the player in it actually plays.
    const pMinutes = projectMinutes({
      status: player.status,
      chanceOfPlayingNextRound: player.chance_of_playing_next_round,
      recentStarts: history.map((s) => s.starts > 0),
      recentMinutes: history.map((s) => s.minutes),
      newsMultiplier: readNewsSignal(player.news).multiplier,
      priorSeason: input.priorWorkloads?.get(player.code) ?? null,
    }).pAppears;

    const thisGameweek = contexts.filter((c) => c.gw === input.gw);

    candidates.push({
      id: player.id,
      name: player.web_name,
      club: teamsById.get(player.team_id)?.short_name ?? "???",
      teamId: player.team_id,
      position: player.position as PositionId,
      positionShort: POSITION_SHORT[player.position as PositionId],
      price: player.now_cost,
      ep: projection.total,
      perGameweek: projection.perGameweek,
      pMinutes,
      flag: flagFor(player),
      unavailable: player.status !== PLAYER_STATUS.available,
      modelInput: modelInputFor(
        player,
        history,
        input.priorSeasons?.get(player.code) ?? null,
        input.priorWorkloads?.get(player.code) ?? null,
      ),
      thisGameweek,
    });
  }

  return {
    candidates,
    projectable: basis !== "none",
    basis,
    gameweeksPlayed,
    minutesKnown: gameweeksPlayed >= MINUTES_KNOWN_GAMEWEEKS,
    gameweeks,
  };
}

/** The optimiser's own view of a candidate. */
export function toPlayerCandidate(
  candidate: Candidate,
  expectedPriceDelta?: number,
): PlayerCandidate {
  return {
    id: candidate.id,
    position: candidate.position,
    teamId: candidate.teamId,
    price: candidate.price,
    ep: candidate.ep,
    pMinutes: candidate.pMinutes,
    expectedPriceDelta,
  };
}
