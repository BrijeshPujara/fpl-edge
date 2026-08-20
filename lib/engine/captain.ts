import {
  APPEARANCE_POINTS,
  ASSIST_POINTS,
  CLEAN_SHEET_POINTS,
  DEFCON_POINTS,
  DEFCON_THRESHOLD,
  GOALS_CONCEDED_PENALTY,
  GOAL_POINTS,
  POSITION,
} from "@/lib/rules";
import {
  atLeast,
  bernoulli,
  convolve,
  mean,
  mix,
  poissonPoints,
  pointMass,
  quantile,
  type Pmf,
} from "./distribution";
import {
  expectedGoalsAgainst,
  expectedPoints,
  type FixtureContext,
  type PlayerModelInput,
} from "./expected-points";
import { projectMinutes } from "./minutes";
import { CAPTAIN_HAUL_THRESHOLD, CAPTAIN_BLANK_THRESHOLD } from "./constants";

/**
 * Captaincy.
 *
 * The rest of the engine maximises expected points, which is correct for
 * buying a squad: fifteen means add up. Captaincy is a different question
 * wearing the same clothes.
 *
 * Doubling one player's return does not change which player has the highest
 * expected score — that is a property of the mean, and doubling is linear. So
 * "who has the highest EP" is the right answer to "who should I captain" ONLY
 * if you are indifferent to risk, and almost nobody is. A manager defending a
 * mini-league lead wants the highest floor; one chasing wants the fattest
 * tail; and the two can be different players with the same mean.
 *
 * So this builds the whole distribution rather than its centre, and reports
 * the shape. See `distribution.ts` for the machinery.
 */

export interface CaptainCandidate {
  playerId: number;
  /** Expected points — the same number the rest of the engine uses. */
  ep: number;
  /** The score beaten half the time. Usually well below the mean. */
  median: number;
  /** P(returning a haul), by the threshold in constants. */
  pHaul: number;
  /** P(a blank — the outcome that loses a gameweek). */
  pBlank: number;
  /** P(not appearing at all). Part of pBlank, and the part you can foresee. */
  pNoShow: number;
  /** Fixtures this gameweek. Two is a double; zero is a blank. */
  fixtures: number;
  /**
   * The 90th-percentile score: the good week, not the average one. What a
   * chasing manager is actually buying.
   */
  ceiling: number;
  /** The 10th-percentile score. What a leading manager is protecting. */
  floor: number;
  distribution: Pmf;
}

/**
 * The distribution of a single player's score in a single fixture.
 *
 * Built by conditioning on minutes first, because minutes gate everything: a
 * player who does not appear scores exactly zero, and a player who plays under
 * an hour cannot earn a clean sheet. Treating those as independent of the
 * attacking terms would put mass on impossible outcomes — a clean sheet for
 * someone who never came on.
 */
export function pointsDistribution(
  player: PlayerModelInput,
  fixture: FixtureContext,
): Pmf {
  const minutes = projectMinutes(player.minutes);
  if (minutes.pAppears <= 0) return pointMass(0);

  // Reuse the mean model for the rates rather than recomputing them. It
  // already applies the opponent adjustment, the prior-season blend and the
  // set-piece credit, and a second implementation of any of that would drift.
  const ep = expectedPoints(player, fixture);
  const { position } = player;

  const goalPoints = GOAL_POINTS[position];
  const lambdaGoals = goalPoints > 0 ? ep.goals / goalPoints : 0;
  const lambdaAssists = ep.assists / ASSIST_POINTS;

  const lambdaAgainst = expectedGoalsAgainst(fixture);
  const pCleanSheet = Math.exp(-lambdaAgainst);

  const attacking = convolve(
    poissonPoints(lambdaGoals, goalPoints),
    poissonPoints(lambdaAssists, ASSIST_POINTS),
  );

  // Defensive contributions and bonus are modelled as their own small
  // Bernoullis around the mean the model already computed. Cruder than the
  // attacking terms, and deliberately so: both are bounded and neither drives
  // the tail that captaincy turns on.
  const defconThreshold = DEFCON_THRESHOLD[position];
  const defcon =
    defconThreshold === null || ep.defcon <= 0
      ? pointMass(0)
      : bernoulli(
          Math.min(1, ep.defcon / DEFCON_POINTS / minutes.pAppears),
          DEFCON_POINTS,
        );

  const bonus = bonusDistribution(ep.bonus / Math.max(minutes.pAppears, 0.01));

  const concedes = position === POSITION.GK || position === POSITION.DEF;

  /** Everything that does not depend on reaching the hour. */
  const common = convolve(convolve(attacking, defcon), bonus);

  const playedFull = convolve(
    convolve(
      pointMass(APPEARANCE_POINTS.over60),
      bernoulli(pCleanSheet, CLEAN_SHEET_POINTS[position]),
    ),
    concedes ? concededPenalty(lambdaAgainst) : pointMass(0),
  );

  // Under an hour: no clean sheet, and the concession penalty is far less
  // likely to have been earned. Approximated as absent rather than modelled,
  // because a sub who plays twenty minutes rarely ships two.
  const playedShort = pointMass(APPEARANCE_POINTS.under60);

  return mix([
    { weight: 1 - minutes.pAppears, pmf: pointMass(0) },
    { weight: minutes.pSixty, pmf: convolve(common, playedFull) },
    { weight: minutes.pShort, pmf: convolve(common, playedShort) },
  ]);
}

/**
 * Bonus, modelled the way it is actually awarded.
 *
 * Two questions rather than one: does this player get bonus at all, and if so
 * which of the three. Most players get none in a given match; those who do are
 * spread across one, two and three fairly evenly, averaging two.
 *
 * So P(any bonus) = mean / 2, and the conditional is uniform over {1, 2, 3}.
 * Above a mean of two that would need a probability greater than one, so the
 * player is instead treated as certain to get bonus and the conditional shifts
 * up the ladder toward three.
 *
 * The first version of this spread `mean / 6` onto each of 3, 2 and 1 and put
 * the remainder on zero. That is fine up to a mean of two and silently broken
 * above it: the three weights alone sum past one, the clamped remainder cannot
 * go negative to compensate, and the whole distribution ends up summing to as
 * much as 1.5. It surfaced as a captain with a blank probability of MINUS 26%.
 */
function bonusDistribution(expected: number): Pmf {
  const mean = Math.max(0, Math.min(3, expected));
  if (mean === 0) return pointMass(0);

  if (mean <= 2) {
    const any = mean / 2;
    return mix([
      { weight: any / 3, pmf: pointMass(1) },
      { weight: any / 3, pmf: pointMass(2) },
      { weight: any / 3, pmf: pointMass(3) },
      { weight: 1 - any, pmf: pointMass(0) },
    ]);
  }

  // Certain to score bonus; the only question left is how much.
  return mix([
    { weight: 3 - mean, pmf: pointMass(2) },
    { weight: mean - 2, pmf: pointMass(3) },
  ]);
}

/** Goals conceded, as the one-point-per-two-shipped penalty it really is. */
function concededPenalty(lambda: number): Pmf {
  const parts: { weight: number; pmf: Pmf }[] = [];
  let mass = Math.exp(-lambda);
  for (let k = 0; k <= 8; k++) {
    if (k > 0) mass = (mass * lambda) / k;
    parts.push({
      weight: mass,
      pmf: pointMass(Math.floor(k / 2) * GOALS_CONCEDED_PENALTY),
    });
  }
  return mix(parts);
}

/**
 * A player's score across every fixture in a gameweek.
 *
 * Convolved rather than summed, because two fixtures produce a distribution
 * with a genuinely different shape from one — the mean doubles, but the
 * ceiling grows faster and the chance of a total blank falls sharply. That is
 * the whole reason a double gameweek is when captaincy matters most, and a
 * model that took only the first fixture would miss it precisely there.
 *
 * No fixtures is a blank gameweek: all mass on zero, which is the truth.
 */
export function gameweekDistribution(
  player: PlayerModelInput,
  fixtures: FixtureContext[],
): Pmf {
  if (fixtures.length === 0) return pointMass(0);

  return fixtures
    .map((fixture) => pointsDistribution(player, fixture))
    .reduce((total, next) => convolve(total, next));
}

/**
 * Rank a squad for the armband.
 *
 * Ordered by expected points, which is the risk-neutral answer and the right
 * default. The shape columns are what make the screen worth looking at: they
 * are how you decide to deviate from that default, and in which direction.
 */
export function rankCaptains(
  players: {
    playerId: number;
    input: PlayerModelInput;
    fixtures: FixtureContext[];
  }[],
): CaptainCandidate[] {
  return players
    .map(({ playerId, input, fixtures }) => {
      const distribution = gameweekDistribution(input, fixtures);
      const minutes = projectMinutes(input.minutes);

      return {
        playerId,
        ep: mean(distribution),
        median: quantile(distribution, 0.5),
        pHaul: atLeast(distribution, CAPTAIN_HAUL_THRESHOLD),
        pBlank: 1 - atLeast(distribution, CAPTAIN_BLANK_THRESHOLD + 1),
        // Across a double gameweek, "no show" means appearing in neither.
        pNoShow: Math.pow(1 - minutes.pAppears, Math.max(fixtures.length, 1)),
        fixtures: fixtures.length,
        ceiling: quantile(distribution, 0.9),
        floor: quantile(distribution, 0.1),
        distribution,
      };
    })
    .sort((a, b) => b.ep - a.ep);
}
