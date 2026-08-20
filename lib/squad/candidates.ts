import { PLAYER_STATUS, POSITION_SHORT, type PositionId } from "@/lib/rules";
import type { PlayerCandidate } from "@/lib/engine/optimiser";
import { projectMinutes } from "@/lib/engine/minutes";
import { readNewsSignal } from "@/lib/engine/news-signal";
import {
  fixtureContextsFor,
  historyFor,
  leagueRatings,
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
}

export interface CandidatePool {
  candidates: Candidate[];
  /**
   * Whether ANY gameweek history exists to project from.
   *
   * This is the honesty gate for both screens. With an empty
   * `player_gw_stats` the model has nothing to tell players apart with, so
   * every projection collapses toward the same positional prior and a ranked
   * transfer table would be pure noise dressed as analysis. Callers must check
   * this and render an explanation instead of a table.
   */
  projectable: boolean;
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

  const candidates: Candidate[] = [];
  for (const player of input.players) {
    const history = historyFor(player.id, byPlayer);
    const contexts = contextsByTeam.get(player.team_id) ?? [];
    const projection = projectPlayer(player, history, contexts, gameweeks);

    // Drives the optimiser's nailed-bench constraint: a bench slot is only
    // real cover if the player in it actually plays.
    const pMinutes = projectMinutes({
      status: player.status,
      chanceOfPlayingNextRound: player.chance_of_playing_next_round,
      recentStarts: history.map((s) => s.starts > 0),
      recentMinutes: history.map((s) => s.minutes),
      newsMultiplier: readNewsSignal(player.news).multiplier,
    }).pAppears;

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
    });
  }

  return {
    candidates,
    projectable: input.stats.length > 0,
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
