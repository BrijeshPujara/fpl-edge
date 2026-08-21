import {
  BONUS_POINTS,
  CAPTAIN_MULTIPLIER,
  STARTING_XI_SIZE,
  TRIPLE_CAPTAIN_MULTIPLIER,
} from "@/lib/rules";
import type { FplLiveElement } from "@/lib/fpl/schemas";

/**
 * What a squad is scoring right now.
 *
 * Pure. Everything else in this app answers "what should I do next"; this is
 * the one thing that answers "what is happening", and it exists because the
 * stored results deliberately lag reality — `syncResults` only touches a
 * gameweek once the API reports both `finished` and `data_checked`, which is
 * typically the Monday after. That lag is correct for a decision journal,
 * where a provisional number would corrupt the record, and useless while you
 * are watching a match.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO, both matching what FPL itself
 * shows live rather than what the final table will say:
 *
 *   * No autosubs. A starter who does not play is replaced by a bench player
 *     only after every match in the gameweek has ended, so applying them now
 *     would show a total nobody else can see and that may not survive.
 *   * No vice-captain promotion, for the same reason — it resolves at the same
 *     moment autosubs do.
 *
 * The number here is therefore what the official site shows while the football
 * is on, which is the number worth agreeing with.
 */

export interface LivePick {
  playerId: number;
  /** 1-11 start, 12-15 bench, in FPL's own ordering. */
  position: number;
  isCaptain: boolean;
  isVice: boolean;
}

export interface LivePlayer {
  playerId: number;
  /** Points before the captain multiplier, including any provisional bonus. */
  points: number;
  /** 2 for the captain, 1 for a starter, 0 for the bench. */
  multiplier: number;
  /** Points as they actually count toward the total. */
  counted: number;
  minutes: number;
  /**
   * Bonus this player is on course for but has not been awarded.
   *
   * Non-zero only while a fixture is unfinished. Once it ends FPL awards the
   * real bonus and folds it into `total_points`, so carrying our own estimate
   * past that point would double it.
   */
  provisionalBonus: number;
  /** True once at least one of this player's fixtures has kicked off. */
  started: boolean;
}

export interface LiveSquad {
  players: LivePlayer[];
  /** What the starting eleven have scored, captain doubled. */
  total: number;
  /** Bench points, for reference. They do not count without a bench boost. */
  benchTotal: number;
  /** True while any part of the total rests on unawarded bonus. */
  provisional: boolean;
  /** Squad members yet to kick off. */
  toPlay: number;
}

export interface LiveInput {
  picks: LivePick[];
  elements: FplLiveElement[];
  /**
   * Fixture ids that have kicked off.
   *
   * Required, and it has to come from the fixtures endpoint because the live
   * feed cannot answer it. Every one of the 600 elements carries an `explain`
   * entry for its fixture from the moment the gameweek opens, zero-filled and
   * indistinguishable from a player who has actually featured — so "has this
   * player's match started" is not derivable from the live payload alone.
   * Treating a populated `explain` as evidence of play showed every unplayed
   * player as having scored nothing, rather than as yet to come.
   */
  startedFixtures: Set<number>;
  /** A played chip, which changes who counts. */
  chip?: string | null;
}

/**
 * Fixtures whose bonus FPL has already awarded.
 *
 * Read from the data rather than from a fixture's `finished` flag, because
 * those two do not move together — caught against the live feed rather than
 * reasoned about. Arsenal v Coventry, an hour after full time:
 *
 *     fixture 1: started=true  finished=FALSE  finished_provisional=true
 *     three players already carrying bonus of 3, 2 and 1 inside total_points
 *
 * Gating on `finished` would therefore have computed a provisional bonus for a
 * match that already had a real one and added it on top — silently inflating
 * exactly the three players whose bonus everyone is watching. The identifier
 * in `explain` is per fixture, so it stays right through a double gameweek
 * where one match has finished and the other has not.
 */
function fixturesWithBonusAwarded(elements: FplLiveElement[]): Set<number> {
  const awarded = new Set<number>();
  for (const element of elements) {
    for (const fixture of element.explain) {
      const bonus = fixture.stats.find((s) => s.identifier === "bonus");
      if (bonus && bonus.value > 0) awarded.add(fixture.fixture);
    }
  }
  return awarded;
}

/**
 * Provisional bonus for every player in a fixture, from the BPS standings.
 *
 * FPL's tie rules are not "top three players" but "top three SCORES", which
 * behaves differently and visibly: two players tied at the top both get 3 and
 * the next gets 1, so four players can share bonus in a single match. Ranking
 * players rather than distinct scores would quietly hand out the wrong number
 * in exactly the matches people argue about.
 */
export function provisionalBonus(
  bpsByPlayer: Map<number, number>,
): Map<number, number> {
  const distinct = [...new Set(bpsByPlayer.values())]
    .filter((bps) => bps > 0)
    .sort((a, b) => b - a)
    .slice(0, BONUS_POINTS.length);

  const awarded = new Map<number, number>();
  for (const [playerId, bps] of bpsByPlayer) {
    const rank = distinct.indexOf(bps);
    if (rank >= 0) awarded.set(playerId, BONUS_POINTS[rank]);
  }
  return awarded;
}

/** The squad's live score. */
export function liveSquad(input: LiveInput): LiveSquad {
  const byId = new Map(input.elements.map((e) => [e.id, e]));
  const bonusAwarded = fixturesWithBonusAwarded(input.elements);

  // BPS standings per fixture, across every player in the game rather than
  // just this squad — bonus is decided by the whole match, and ranking only
  // the players someone happens to own would invent it.
  const bpsByFixture = new Map<number, Map<number, number>>();
  for (const element of input.elements) {
    for (const fixture of element.explain) {
      if (bonusAwarded.has(fixture.fixture)) continue;
      const table = bpsByFixture.get(fixture.fixture) ?? new Map();
      table.set(element.id, element.stats.bps);
      bpsByFixture.set(fixture.fixture, table);
    }
  }
  const bonusByFixture = new Map(
    [...bpsByFixture].map(([fixture, table]) => [
      fixture,
      provisionalBonus(table),
    ]),
  );

  const benchBoost = input.chip === "bboost";
  const tripleCaptain = input.chip === "3xc";

  const players: LivePlayer[] = input.picks.map((pick) => {
    const element = byId.get(pick.playerId);
    const stats = element?.stats;

    // Provisional bonus only from fixtures still running; a finished one has
    // already had its real bonus folded into total_points.
    let provisional = 0;
    for (const fixture of element?.explain ?? []) {
      provisional += bonusByFixture.get(fixture.fixture)?.get(pick.playerId) ?? 0;
    }

    const starting = pick.position <= STARTING_XI_SIZE;
    const multiplier = !starting && !benchBoost
      ? 0
      : pick.isCaptain
        ? tripleCaptain
          ? TRIPLE_CAPTAIN_MULTIPLIER
          : CAPTAIN_MULTIPLIER
        : 1;

    const points = (stats?.total_points ?? 0) + provisional;

    return {
      playerId: pick.playerId,
      points,
      multiplier,
      counted: points * multiplier,
      minutes: stats?.minutes ?? 0,
      provisionalBonus: provisional,
      started: (element?.explain ?? []).some((f) =>
        input.startedFixtures.has(f.fixture),
      ),
    };
  });

  return {
    players,
    total: players.reduce((sum, p) => sum + p.counted, 0),
    benchTotal: players
      .filter((p) => p.multiplier === 0)
      .reduce((sum, p) => sum + p.points, 0),
    provisional: players.some((p) => p.provisionalBonus > 0),
    toPlay: players.filter((p) => !p.started).length,
  };
}
