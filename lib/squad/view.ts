import {
  FORMATION_BOUNDS,
  PLAYER_STATUS,
  POSITION,
  POSITION_SHORT,
  type PositionId,
} from "@/lib/rules";
import {
  fixtureContextsFor,
  fixtureRatings,
  historyFor,
  projectPlayer,
  statsByPlayer,
  type TeamRatingLike,
} from "./projection";

/**
 * Assembling the squad view.
 *
 * Pure. Takes plain rows and returns something a component can render without
 * further thought, which keeps the page component free of business logic and
 * makes the shaping testable with no database.
 *
 * The row types are structural rather than imported from the generated
 * Supabase types, so this module has no dependency on the database layer and
 * can be exercised with literals.
 */

export interface PlayerLike {
  id: number;
  /**
   * `element_code` — the identity that survives between seasons. FPL renumbers
   * `id` every year, so this is the only thing that can attach last season's
   * rates to this season's player.
   */
  code: number;
  web_name: string;
  team_id: number;
  position: number;
  now_cost: number;
  status: string;
  chance_of_playing_next_round: number | null;
  news: string;
  // Optional so existing test literals and any caller selecting a narrower
  // column set keep compiling. Absent reads as "no listed duty", which is
  // correct for most players.
  penalties_order?: number | null;
  corners_order?: number | null;
  direct_freekicks_order?: number | null;
}

/**
 * A club, for names and crests only.
 *
 * It used to carry `strength_attack_*` and `strength_defence_*` as well, and
 * the projection read fixture difficulty straight out of them. FPL has served
 * those four as zero all season, so they are gone from here rather than left
 * to be re-wired by someone who reasonably assumes a field that exists is a
 * field that means something. Difficulty comes from `team_ratings` now — see
 * `fixtureRatings`.
 */
export interface TeamLike {
  id: number;
  short_name: string;
}

export interface FixtureLike {
  gw: number | null;
  home_team: number;
  away_team: number;
  home_difficulty: number;
  away_difficulty: number;
}

export interface PickLike {
  player_id: number;
  position: number;
  is_captain: boolean;
  is_vice: boolean;
}

export interface StatLike {
  player_id: number;
  gw: number;
  minutes: number;
  starts: number;
  goals: number;
  assists: number;
  expected_goals: number;
  expected_assists: number;
  defensive_contribution: number;
  bonus: number;
  goals_conceded: number;
  yellow_cards: number;
  red_cards: number;
}

export interface FixtureCellView {
  opponent: string;
  difficulty: number;
  isHome: boolean;
}

export interface PlayerTileView {
  playerId: number;
  name: string;
  club: string;
  position: PositionId;
  positionShort: string;
  /** Tenths of a million. Format at the render boundary. */
  price: number;
  ep: number;
  /** Null when there is no history to project from — do not render a number. */
  epIsProjectable: boolean;
  isCaptain: boolean;
  isVice: boolean;
  /** null when fully available. */
  flag: { chance: number | null; note: string } | null;
  fixtures: FixtureCellView[];
}

export interface SquadView {
  gw: number;
  formation: string;
  rows: { position: PositionId; label: string; players: PlayerTileView[] }[];
  bench: PlayerTileView[];
  totals: {
    startingEp: number;
    benchEp: number;
    captainBonus: number;
    projectedTotal: number;
    squadValue: number;
    meanDifficulty: number | null;
    flaggedCount: number;
  };
  /** True when no gameweek has been played, so EP carries no information yet. */
  preSeason: boolean;
}

const ORDER: PositionId[] = [
  POSITION.GK,
  POSITION.DEF,
  POSITION.MID,
  POSITION.FWD,
];

/** The next N fixtures for a team, from a gameweek forward. */
export function fixtureStripFor(
  teamId: number,
  fixtures: FixtureLike[],
  teams: Map<number, TeamLike>,
  fromGw: number,
  length: number,
): FixtureCellView[] {
  return fixtures
    .filter(
      (f) =>
        f.gw !== null &&
        f.gw >= fromGw &&
        (f.home_team === teamId || f.away_team === teamId),
    )
    .sort((a, b) => (a.gw ?? 0) - (b.gw ?? 0))
    .slice(0, length)
    .map((f) => {
      const isHome = f.home_team === teamId;
      const opponentId = isHome ? f.away_team : f.home_team;
      return {
        opponent: teams.get(opponentId)?.short_name ?? "???",
        difficulty: isHome ? f.home_difficulty : f.away_difficulty,
        isHome,
      };
    });
}

/**
 * A player is flagged when the API says anything other than "fully available".
 * The news string is what the club actually said, which is more useful than a
 * percentage on its own.
 */
function flagFor(player: PlayerLike): PlayerTileView["flag"] {
  if (player.status === PLAYER_STATUS.available && !player.news) return null;
  if (player.status === PLAYER_STATUS.available && player.news) {
    // Available but with news attached — usually a resolved knock.
    return { chance: player.chance_of_playing_next_round, note: player.news };
  }
  return {
    chance: player.chance_of_playing_next_round,
    note: player.news || "Unavailable",
  };
}

export interface BuildSquadViewInput {
  gw: number;
  picks: PickLike[];
  players: PlayerLike[];
  teams: TeamLike[];
  fixtures: FixtureLike[];
  stats: StatLike[];
  stripLength?: number;
  /**
   * Projections computed elsewhere, by player id.
   *
   * The screens that rank players build their projections through
   * `buildCandidatePool`, which blends in last season's rates. This view had
   * its own path that did not, so before any gameweek was played it projected
   * nothing and every tile read "—" while the same player showed a real number
   * on the dashboard. Two projection paths for one player is the failure this
   * codebase works hardest to avoid, and this is the seam it slipped through.
   *
   * Optional so the view still stands alone — the preview harness renders it
   * with no context — but every real page passes it.
   */
  epByPlayer?: Map<number, number>;
  /**
   * Fitted team ratings, for the opponent adjustment. Same contract as
   * `BuildCandidatePoolInput.teamRatings` — absent means neutral fixtures.
   */
  teamRatings?: TeamRatingLike[];
}

export function buildSquadView(input: BuildSquadViewInput): SquadView {
  const stripLength = input.stripLength ?? 5;
  const teamsById = new Map(input.teams.map((t) => [t.id, t]));
  const playersById = new Map(input.players.map((p) => [p.id, p]));

  const ratings = fixtureRatings(input.teamRatings ?? []);
  const byPlayer = statsByPlayer(input.stats);
  const anyHistory = input.stats.length > 0;

  const tiles: PlayerTileView[] = [];
  for (const pick of input.picks) {
    const player = playersById.get(pick.player_id);
    if (!player) continue;

    const history = historyFor(player.id, byPlayer);

    const strip = fixtureStripFor(
      player.team_id,
      input.fixtures,
      teamsById,
      input.gw,
      stripLength,
    );

    const team = teamsById.get(player.team_id);

    // Every fixture in the target gameweek, not just the first. A double
    // gameweek is two fixtures and should project as two — taking only the
    // first understated it by half.
    const contexts = fixtureContextsFor(player.team_id, input.fixtures, ratings, [
      input.gw,
    ]);

    const supplied = input.epByPlayer?.get(player.id);
    const ep = projectPlayer(player, history, contexts, [input.gw]);

    tiles.push({
      playerId: player.id,
      name: player.web_name,
      club: team?.short_name ?? "???",
      position: player.position as PositionId,
      positionShort: POSITION_SHORT[player.position as PositionId],
      price: player.now_cost,
      ep: supplied ?? ep.total,
      // A supplied projection is projectable by definition: whoever computed
      // it had more to work with than this view does.
      epIsProjectable: supplied !== undefined || anyHistory,
      isCaptain: pick.is_captain,
      isVice: pick.is_vice,
      flag: flagFor(player),
      fixtures: strip,
    });
  }

  const byPlayerId = new Map(tiles.map((t) => [t.playerId, t]));
  // Positions 1-11 start, 12-15 are the bench in order.
  const starting = input.picks
    .filter((p) => p.position <= 11)
    .map((p) => byPlayerId.get(p.player_id))
    .filter((t): t is PlayerTileView => t !== undefined);
  const bench = input.picks
    .filter((p) => p.position > 11)
    .map((p) => byPlayerId.get(p.player_id))
    .filter((t): t is PlayerTileView => t !== undefined);

  const rows = ORDER.map((position) => ({
    position,
    label: POSITION_SHORT[position],
    players: starting.filter((t) => t.position === position),
  })).filter((r) => r.players.length > 0);

  const counts = ORDER.map(
    (p) => starting.filter((t) => t.position === p).length,
  );
  // Formation is conventionally quoted without the goalkeeper.
  const formation = counts.slice(1).join("-");

  const startingEp = starting.reduce((sum, t) => sum + t.ep, 0);
  const benchEp = bench.reduce((sum, t) => sum + t.ep, 0);
  const captain = starting.find((t) => t.isCaptain);
  const captainBonus = captain?.ep ?? 0;

  const allDifficulties = starting.flatMap((t) =>
    t.fixtures.map((f) => f.difficulty),
  );

  return {
    gw: input.gw,
    formation,
    rows,
    bench,
    totals: {
      startingEp,
      benchEp,
      captainBonus,
      projectedTotal: startingEp + captainBonus,
      squadValue: [...starting, ...bench].reduce((sum, t) => sum + t.price, 0),
      meanDifficulty:
        allDifficulties.length > 0
          ? allDifficulties.reduce((a, b) => a + b, 0) / allDifficulties.length
          : null,
      flaggedCount: [...starting, ...bench].filter((t) => t.flag !== null)
        .length,
    },
    preSeason: !anyHistory,
  };
}

export { FORMATION_BOUNDS };
