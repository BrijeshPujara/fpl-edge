import {
  DIXON_COLES_RHO,
  HOME_ADVANTAGE,
  LEAGUE_MEAN_GOALS_PER_TEAM,
  MAX_GOALS,
} from "./constants";

/**
 * Match scorelines as a joint distribution over goals.
 *
 * Pure. No I/O, no database, no clock — the same inputs give the same grid
 * forever, which is what makes it testable and what makes every screen that
 * reads it agree.
 *
 * WHY THIS IS A DISTRIBUTION AND NOT A PREDICTION.
 *
 * The obvious shape for a "score predictor" is a function returning 2-1, and
 * it is the wrong shape. Measured over 280 held-out matches of 2025/26, a
 * model that knows NOTHING — league-average rate for both sides, every team
 * identical — names the exact scoreline 13.2% of the time, because it always
 * says 1-1 and 1-1 is the most common Premier League result at 12.4%. Every
 * model here that actually knows something about the teams scores WORSE on
 * that measure: it sometimes says 2-0, and 2-0 is individually rarer than 1-1
 * even when it is the better answer. Ranking by exact-score accuracy would
 * therefore select for ignorance.
 *
 * So this returns the whole grid, and callers read probabilities off it: who
 * wins, whether it is a clean sheet, whether both score, how many goals. If a
 * screen shows a single scoreline it should say "most likely" and mean it as
 * the mode of a distribution, not as a forecast.
 *
 * WHAT THE ENGINE ALREADY HAS. `expectedGoalsAgainst` in `expected-points.ts`
 * computes exactly one of the two rates this needs, because clean sheets are
 * `exp(-lambda)`. This is that calculation finished: both sides at once, and
 * the joint distribution rather than a single marginal. With the low-score
 * correction disabled the two agree exactly, which `scoreline.test.ts` pins
 * down — they are one model, not two.
 */

/**
 * A team's rate multipliers, both centred on 1.0 for a league-average side.
 *
 * `defence` is deliberately oriented so that HIGHER MEANS WORSE — it multiplies
 * what the opponent is expected to score. That reads backwards on first
 * contact and is worth the friction: both fields then multiply in the same
 * direction, so the rate is a plain product with no sign to get wrong, and a
 * team that is bad at both ends has two numbers above one.
 */
export interface TeamStrength {
  /** Goals scored, relative to league average. Higher is better. */
  attack: number;
  /** Goals conceded, relative to league average. Higher is WORSE. */
  defence: number;
}

export interface ScorelineOptions {
  /** League-average goals per team per match. */
  leagueMean?: number;
  /**
   * Half-step venue multiplier: the home side is multiplied by it and the away
   * side divided, so the ratio between them is its SQUARE. Shares the meaning
   * of `HOME_ADVANTAGE` exactly, which is why it shares the default.
   */
  homeAdvantage?: number;
  /** Dixon-Coles low-score dependence. Zero gives independent Poissons. */
  rho?: number;
}

export interface Scoreline {
  /** Expected goals for the home side. */
  lambdaHome: number;
  lambdaAway: number;
  /**
   * `grid[home][away]`, summing to one.
   *
   * Index `MAX_GOALS` means "that many or more" — see `MAX_GOALS`.
   */
  grid: number[][];
}

/**
 * Floor on a scoring rate.
 *
 * Matches the clamp in `expectedGoalsAgainst`. A rate of zero would make a
 * clean sheet a certainty, and no fixture is a certainty.
 */
const MIN_LAMBDA = 0.1;

/**
 * Expected goals for each side.
 *
 * Note the crossing: the home rate takes the home attack against the AWAY
 * defence. Multiplying a team by its own defence is the classic bug here, and
 * it is silent — the numbers stay plausible and every ranking is wrong.
 */
export function expectedGoals(
  home: TeamStrength,
  away: TeamStrength,
  options: ScorelineOptions = {},
): { home: number; away: number } {
  const leagueMean = options.leagueMean ?? LEAGUE_MEAN_GOALS_PER_TEAM;
  const venue = options.homeAdvantage ?? HOME_ADVANTAGE;

  return {
    home: rate(leagueMean * home.attack * away.defence * venue),
    away: rate((leagueMean * away.attack * home.defence) / venue),
  };
}

function rate(lambda: number): number {
  return Number.isFinite(lambda) ? Math.max(MIN_LAMBDA, lambda) : MIN_LAMBDA;
}

/** The joint distribution implied by two team strengths. */
export function scoreline(
  home: TeamStrength,
  away: TeamStrength,
  options: ScorelineOptions = {},
): Scoreline {
  const lambda = expectedGoals(home, away, options);
  return scorelineFrom(lambda.home, lambda.away, options);
}

/**
 * The joint distribution implied by two rates.
 *
 * Separate from `scoreline` so a caller that already has its rates — anything
 * built on `expectedGoalsAgainst`, or a model fitted elsewhere — can use this
 * without being forced to express itself as attack and defence multipliers.
 */
export function scorelineFrom(
  lambdaHome: number,
  lambdaAway: number,
  options: ScorelineOptions = {},
): Scoreline {
  const home = rate(lambdaHome);
  const away = rate(lambdaAway);
  const rho = options.rho ?? DIXON_COLES_RHO;

  const homeMasses = poissonMasses(home);
  const awayMasses = poissonMasses(away);

  const grid: number[][] = [];
  let total = 0;

  for (let h = 0; h <= MAX_GOALS; h++) {
    const row = new Array<number>(MAX_GOALS + 1);
    for (let a = 0; a <= MAX_GOALS; a++) {
      const joint = homeMasses[h] * awayMasses[a] * tau(h, a, home, away, rho);
      row[a] = joint;
      total += joint;
    }
    grid.push(row);
  }

  // The correction does not preserve mass, so renormalise rather than assume.
  // Skipping this leaves a grid that sums to about 1.02 and every probability
  // read off it slightly too high.
  if (total > 0) {
    for (const row of grid) {
      for (let a = 0; a <= MAX_GOALS; a++) row[a] /= total;
    }
  }

  return { lambdaHome: home, lambdaAway: away, grid };
}

/**
 * Poisson masses over 0..MAX_GOALS, with the tail folded into the top cell.
 *
 * Computed by the recurrence rather than `lambda^k / k!` — the factorial
 * overflows and the power underflows long before the mass itself stops
 * mattering.
 */
function poissonMasses(lambda: number): number[] {
  const masses = new Array<number>(MAX_GOALS + 1);
  let mass = Math.exp(-lambda);
  let cumulative = 0;

  for (let k = 0; k < MAX_GOALS; k++) {
    if (k > 0) mass = (mass * lambda) / k;
    masses[k] = mass;
    cumulative += mass;
  }

  masses[MAX_GOALS] = Math.max(0, 1 - cumulative);
  return masses;
}

/**
 * The Dixon-Coles correction, applied to the four cells where both sides
 * scored at most one.
 *
 * Everywhere else it is exactly one, which is the point: independence is a
 * good assumption for 3-2 and a bad one for 1-1.
 */
function tau(
  home: number,
  away: number,
  lambdaHome: number,
  lambdaAway: number,
  rho: number,
): number {
  if (rho === 0) return 1;

  let value: number;
  if (home === 0 && away === 0) value = 1 - lambdaHome * lambdaAway * rho;
  else if (home === 0 && away === 1) value = 1 + lambdaHome * rho;
  else if (home === 1 && away === 0) value = 1 + lambdaAway * rho;
  else if (home === 1 && away === 1) value = 1 - rho;
  else return 1;

  // Goes negative once |rho| * lambda passes one — a very high-scoring fixture
  // under an aggressive correction. Clamping costs a little accuracy in a
  // corner that barely happens; allowing negative mass would let
  // normalisation smear it across the entire grid, which is far worse and
  // much harder to notice.
  return Math.max(0, value);
}

export interface Outcomes {
  home: number;
  draw: number;
  away: number;
}

/** Win, draw and loss, from the home side's point of view. */
export function outcomeProbabilities({ grid }: Scoreline): Outcomes {
  let home = 0;
  let draw = 0;
  let away = 0;

  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      if (h > a) home += grid[h][a];
      else if (h === a) draw += grid[h][a];
      else away += grid[h][a];
    }
  }
  return { home, draw, away };
}

/** Which way a match went, from the home side's point of view. */
export type MatchOutcome = "home" | "draw" | "away";

export function outcomeOf(homeGoals: number, awayGoals: number): MatchOutcome {
  if (homeGoals > awayGoals) return "home";
  if (homeGoals < awayGoals) return "away";
  return "draw";
}

/**
 * Ranked probability score. Lower is better; 0 is perfect.
 *
 * The proper scoring rule for an ORDERED three-way outcome, and the reason it
 * is used here rather than plain accuracy: it rewards being close. A model
 * that says 60% home / 30% draw / 10% away is punished less for a draw than a
 * model that says 60% home / 10% draw / 30% away, because a draw sits between
 * the two wins. Accuracy cannot see that, and log loss — which is also
 * reported — treats the three as unordered.
 *
 * Both are stored for every scored prediction, because they disagree in
 * informative ways: log loss punishes confident errors far harder, and a model
 * that improves on RPS while worsening on log loss has become better calibrated
 * about which side wins and more reckless about how sure it is.
 */
export function rankedProbabilityScore(
  probabilities: Outcomes,
  actual: MatchOutcome,
): number {
  const predicted = [probabilities.home, probabilities.draw, probabilities.away];
  const observed = { home: [1, 0, 0], draw: [0, 1, 0], away: [0, 0, 1] }[actual];

  let cumulativePredicted = 0;
  let cumulativeObserved = 0;
  let total = 0;

  // Only the first two terms are summed: the third cumulative pair is always
  // 1 against 1, contributing nothing, and dividing by categories - 1 keeps
  // the result on [0, 1].
  for (let i = 0; i < 2; i++) {
    cumulativePredicted += predicted[i];
    cumulativeObserved += observed[i];
    total += (cumulativePredicted - cumulativeObserved) ** 2;
  }
  return total / 2;
}

/** Negative log likelihood of the outcome that happened. */
export function logLoss(
  probabilities: Outcomes,
  actual: MatchOutcome,
): number {
  // Floored, because a model that assigned exactly zero to what happened
  // would otherwise score infinity and poison every average it enters.
  return -Math.log(Math.max(probabilities[actual], 1e-12));
}

/**
 * Clean sheet for each side.
 *
 * A side keeps a clean sheet when the OTHER side fails to score, so `home` here
 * is the probability the away team is kept out.
 */
export function cleanSheetProbabilities({ grid }: Scoreline): {
  home: number;
  away: number;
} {
  let home = 0;
  let away = 0;

  for (let k = 0; k <= MAX_GOALS; k++) {
    home += grid[k][0];
    away += grid[0][k];
  }
  return { home, away };
}

/** Both teams to score. */
export function bothTeamsToScore(scoreline: Scoreline): number {
  const { home, away } = cleanSheetProbabilities(scoreline);
  // Inclusion-exclusion: neither is kept out. The 0-0 cell sits in both clean
  // sheet totals and has to come back.
  return 1 - home - away + scoreline.grid[0][0];
}

/**
 * Total goals in the match, indexed by that total.
 *
 * Length `2 * MAX_GOALS + 1`, with the top index meaning "or more" for the
 * same reason the grid's does.
 */
export function totalGoalsDistribution({ grid }: Scoreline): number[] {
  const totals = new Array<number>(2 * MAX_GOALS + 1).fill(0);
  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) totals[h + a] += grid[h][a];
  }
  return totals;
}

/**
 * Over and under a goal line.
 *
 * Half-goal lines only, so that no outcome can land exactly on the line and
 * the two sides always sum to one. A whole-goal line pushes, which is a third
 * outcome this deliberately does not model.
 */
export function overUnder(
  scoreline: Scoreline,
  line: number,
): { over: number; under: number } {
  if (Number.isInteger(line)) {
    throw new Error(
      `Goal line must be a half, got ${line} — a whole line can push.`,
    );
  }

  const totals = totalGoalsDistribution(scoreline);
  let over = 0;
  for (let goals = 0; goals < totals.length; goals++) {
    if (goals > line) over += totals[goals];
  }
  return { over, under: 1 - over };
}

export interface LikelyScore {
  home: number;
  away: number;
  probability: number;
}

/**
 * The most likely scorelines, most likely first.
 *
 * For display only, and see the note at the top of this file before treating
 * the first entry as a prediction.
 */
export function mostLikelyScores(
  { grid }: Scoreline,
  count = 5,
): LikelyScore[] {
  const scores: LikelyScore[] = [];
  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      scores.push({ home: h, away: a, probability: grid[h][a] });
    }
  }
  // Ties broken by the lower-scoring line, so the ordering is stable rather
  // than dependent on how the grid happened to be walked.
  scores.sort(
    (x, y) =>
      y.probability - x.probability ||
      x.home + x.away - (y.home + y.away) ||
      x.home - y.home,
  );
  return scores.slice(0, Math.max(0, count));
}

export interface ScoresByOutcome {
  home: LikelyScore;
  draw: LikelyScore;
  away: LikelyScore;
}

/**
 * The most likely scoreline within each outcome.
 *
 * The fix for the problem described at the top of this file. `mostLikelyScores`
 * ranks every cell against every other, and because draws are concentrated on
 * a handful of low cells while wins are spread across many, 1-1 wins that
 * contest almost regardless of how lopsided the fixture is — it is the mode in
 * nine of ten Premier League fixtures even where the home side is a 60%
 * favourite.
 *
 * Conditioning first removes the comparison that was doing the damage. Take
 * the outcome the model actually favours, then the best scoreline inside it,
 * and a 2.25 v 1.15 fixture reports the 2-1 it should rather than a 1-1 that
 * describes the shape of the draw distribution instead of the match.
 *
 * `probability` stays JOINT, not conditional — the outright chance of that
 * exact scoreline. It is therefore comparable across all three, and small: a
 * single scoreline rarely clears one in six. Divide by the outcome's own
 * probability to condition it.
 */
export function mostLikelyScoreByOutcome(
  { grid }: Scoreline,
): ScoresByOutcome {
  const best: ScoresByOutcome = {
    home: { home: 1, away: 0, probability: -1 },
    draw: { home: 0, away: 0, probability: -1 },
    away: { home: 0, away: 1, probability: -1 },
  };

  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const key = h > a ? "home" : h === a ? "draw" : "away";
      if (grid[h][a] > best[key].probability) {
        best[key] = { home: h, away: a, probability: grid[h][a] };
      }
    }
  }
  return best;
}

/**
 * Expected goal difference, home minus away.
 *
 * Read off the grid rather than returned as `lambdaHome - lambdaAway`, because
 * the two stop agreeing once the correction reweights the low cells, and the
 * grid is the thing the screen is showing.
 */
export function expectedSupremacy({ grid }: Scoreline): number {
  let total = 0;
  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) total += (h - a) * grid[h][a];
  }
  return total;
}
