/**
 * Discrete probability distributions over points.
 *
 * Pure. Everything else in the engine works with expected points — a mean —
 * and for buying a squad that is the right quantity: fifteen means add up, and
 * the optimiser maximises the sum.
 *
 * Captaincy is a different question, and a mean answers it badly. The armband
 * doubles a single player's return, so what matters is the shape of that
 * player's outcome, not its centre. Two forwards can share an expected 6.0
 * where one returns 6 nearly every week and the other blanks four times in five
 * and hauls once — and if you are chasing, only the second is worth doubling.
 *
 * A mean cannot see that difference. This can.
 */

/**
 * The lowest score the support covers.
 *
 * Negative because red cards and goals conceded are real. A distribution
 * clamped at zero would quietly move that mass onto zero and overstate the
 * floor of exactly the defenders whose floor you are trying to check.
 */
export const MIN_POINTS = -6;

/** The highest. A 20+ point return is a season-defining haul, not a forecast. */
export const MAX_POINTS = 40;

const SIZE = MAX_POINTS - MIN_POINTS + 1;

/**
 * A probability mass function over points, indexed from MIN_POINTS.
 *
 * Held as a plain array rather than a map because every operation here is a
 * convolution, and convolutions over dense arrays are simple and fast enough
 * that nothing cleverer is warranted.
 */
export type Pmf = number[];

/** All mass on a single value. The identity for convolution. */
export function pointMass(points: number): Pmf {
  const pmf = new Array<number>(SIZE).fill(0);
  pmf[clampIndex(points)] = 1;
  return pmf;
}

function clampIndex(points: number): number {
  const index = Math.round(points) - MIN_POINTS;
  return Math.max(0, Math.min(SIZE - 1, index));
}

/**
 * The distribution of the sum of two independent scores.
 *
 * Independence is an assumption and worth naming: a player who scores is more
 * likely to earn bonus, and a clean sheet correlates with the goals-conceded
 * term rather than being independent of it. The correlations that matter are
 * handled by construction — conceded and clean sheet are derived from the same
 * Poisson draw below — and the rest are second-order against the size of the
 * question being asked.
 */
export function convolve(a: Pmf, b: Pmf): Pmf {
  const out = new Array<number>(SIZE).fill(0);
  for (let i = 0; i < SIZE; i++) {
    const pa = a[i];
    if (pa === 0) continue;
    for (let j = 0; j < SIZE; j++) {
      const pb = b[j];
      if (pb === 0) continue;
      // Both indices carry the offset, so adding them double-counts it.
      const points = i + MIN_POINTS + (j + MIN_POINTS);
      out[clampIndex(points)] += pa * pb;
    }
  }
  return out;
}

/** Weighted mixture — for conditioning on something that already happened. */
export function mix(parts: { weight: number; pmf: Pmf }[]): Pmf {
  const out = new Array<number>(SIZE).fill(0);
  for (const { weight, pmf } of parts) {
    if (weight <= 0) continue;
    for (let i = 0; i < SIZE; i++) out[i] += weight * pmf[i];
  }
  return out;
}

/** Bernoulli over two scores. */
export function bernoulli(p: number, ifTrue: number, ifFalse = 0): Pmf {
  const pmf = new Array<number>(SIZE).fill(0);
  pmf[clampIndex(ifFalse)] += 1 - p;
  pmf[clampIndex(ifTrue)] += p;
  return pmf;
}

/**
 * Poisson counts, each worth `pointsEach`.
 *
 * Truncated at `maxCount`, with the remaining tail mass placed on that count —
 * which shortens the mean slightly, because mass that belonged at seven is
 * being scored at the cap instead.
 *
 * Eight rather than five, and the difference is measurable rather than
 * theoretical: at a rate of 1.5 a cap of five loses 0.37% of the mean, while
 * eight loses under a hundredth of that. Five goals in a match is historic and
 * eight is impossible, so the extra headroom costs nothing and removes an
 * error large enough to show up in a test.
 */
export function poissonPoints(
  lambda: number,
  pointsEach: number,
  maxCount = 8,
): Pmf {
  const pmf = new Array<number>(SIZE).fill(0);
  let mass = Math.exp(-lambda);
  let remaining = 1;

  for (let k = 0; k < maxCount; k++) {
    if (k > 0) mass = (mass * lambda) / k;
    pmf[clampIndex(k * pointsEach)] += mass;
    remaining -= mass;
  }
  pmf[clampIndex(maxCount * pointsEach)] += Math.max(0, remaining);
  return pmf;
}

// ---------------------------------------------------------------------------
// Reading a distribution
// ---------------------------------------------------------------------------

export function mean(pmf: Pmf): number {
  let total = 0;
  for (let i = 0; i < SIZE; i++) total += pmf[i] * (i + MIN_POINTS);
  return total;
}

/**
 * Spread around the mean.
 *
 * The quantity a risk-adjusted objective can actually use, and the reason it is
 * variance rather than a quantile. Variance is ADDITIVE over independent
 * players, so a sum of per-player `mean - γ·variance` scores is exactly
 * `E[total] - γ·Var[total]` — the objective stays linear and the MILP is
 * unchanged. Summing per-player quantiles looks equivalent and is not: the 25th
 * percentile of eleven players is nothing like the sum of eleven 25th
 * percentiles, because they do not all blank together.
 *
 * Independence is the assumption, and it is worth naming twice. It is false
 * exactly where FPL squads concentrate risk — three defenders from one club
 * share a clean sheet — so this UNDERSTATES the variance of a club stack. See
 * the note at the top of this file.
 */
export function variance(pmf: Pmf): number {
  const mu = mean(pmf);
  let total = 0;
  for (let i = 0; i < SIZE; i++) {
    const x = i + MIN_POINTS;
    total += pmf[i] * (x - mu) ** 2;
  }
  return total;
}

/** P(score >= points). The ceiling question. */
export function atLeast(pmf: Pmf, points: number): number {
  let total = 0;
  for (let i = clampIndex(points); i < SIZE; i++) total += pmf[i];
  return total;
}

/** P(score <= points). The floor question. */
export function atMost(pmf: Pmf, points: number): number {
  let total = 0;
  for (let i = 0; i <= clampIndex(points); i++) total += pmf[i];
  return total;
}

/**
 * The lowest score with at least `p` cumulative probability at or below it.
 *
 * `quantile(pmf, 0.5)` is the median — the score a player beats half the time,
 * which is usually a long way below the mean for a forward and barely below it
 * for a defender. That gap is the whole reason this module exists.
 */
export function quantile(pmf: Pmf, p: number): number {
  let cumulative = 0;
  for (let i = 0; i < SIZE; i++) {
    cumulative += pmf[i];
    if (cumulative >= p) return i + MIN_POINTS;
  }
  return MAX_POINTS;
}

/** Doubling every outcome, which is what the armband actually does. */
export function doubled(pmf: Pmf): Pmf {
  const out = new Array<number>(SIZE).fill(0);
  for (let i = 0; i < SIZE; i++) {
    if (pmf[i] === 0) continue;
    out[clampIndex((i + MIN_POINTS) * 2)] += pmf[i];
  }
  return out;
}
