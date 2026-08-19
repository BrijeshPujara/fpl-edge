import { FRONTIER_MIN_SAMPLE } from "./constants";
import type { PositionId } from "@/lib/rules";

/**
 * Value diagnostics: who gives more expected points per pound than their price
 * implies.
 *
 * Pure. This is a DIAGNOSTIC FOR THE UI, not an objective term — the optimiser
 * must never maximise `valueSurplus`. Doing so would double-count: EP is
 * already in the objective and price is already in the budget constraint, so
 * adding surplus on top would pay twice for the same fact and bias the squad
 * toward cheap players whose EP the model has simply overestimated.
 *
 * WHAT THE CURVE IS. Not an efficiency frontier in the strict sense. A true
 * frontier is an upper envelope — the best EP achievable at each price — and
 * nothing can sit above it, so every surplus would be zero or negative. What is
 * wanted here is the opposite sign convention: positive means underpriced. That
 * requires a *typical* price-to-output curve, so this fits one and measures
 * vertical distance from it. Roughly half the league lands on each side, which
 * is what makes it discriminating.
 *
 * The fit is isotonic (monotone non-decreasing) because more expensive players
 * should not be projected to score less. Enforcing that stops a thin patch of
 * the price range from producing a locally downward-sloping curve, which would
 * mark a whole price band as underpriced for no reason.
 */

export interface FrontierInput {
  playerId: number;
  position: PositionId;
  /** Tenths of a million. */
  price: number;
  /** Expected points over the horizon the caller is evaluating. */
  ep: number;
}

export interface ValueAssessment {
  playerId: number;
  position: PositionId;
  price: number;
  ep: number;
  /** EP the fitted curve predicts for a player at this price and position. */
  expectedEpForPrice: number;
  /** ep − expectedEpForPrice. Positive means underpriced for their output. */
  valueSurplus: number;
}

/**
 * Pool-Adjacent-Violators: the standard isotonic regression, O(n).
 *
 * Walks left to right merging any block whose mean dips below its neighbour,
 * which yields the monotone non-decreasing least-squares fit.
 */
function isotonic(values: number[], weights: number[]): number[] {
  const means: number[] = [];
  const counts: number[] = [];
  const sizes: number[] = [];

  for (let i = 0; i < values.length; i++) {
    means.push(values[i]);
    counts.push(weights[i]);
    sizes.push(1);

    // Merge backwards while monotonicity is violated.
    while (
      means.length > 1 &&
      means[means.length - 2] > means[means.length - 1]
    ) {
      const w2 = counts.pop()!;
      const m2 = means.pop()!;
      const s2 = sizes.pop()!;
      const w1 = counts.pop()!;
      const m1 = means.pop()!;
      const s1 = sizes.pop()!;
      const w = w1 + w2;
      means.push(w === 0 ? (m1 + m2) / 2 : (m1 * w1 + m2 * w2) / w);
      counts.push(w);
      sizes.push(s1 + s2);
    }
  }

  // Expand blocks back out to one value per input.
  const fitted: number[] = [];
  for (let b = 0; b < means.length; b++) {
    for (let k = 0; k < sizes[b]; k++) fitted.push(means[b]);
  }
  return fitted;
}

/** Linear interpolation over the fitted step function, clamped at both ends. */
function interpolate(
  prices: number[],
  fitted: number[],
  price: number,
): number {
  if (prices.length === 0) return 0;
  if (price <= prices[0]) return fitted[0];
  if (price >= prices[prices.length - 1]) return fitted[fitted.length - 1];

  for (let i = 1; i < prices.length; i++) {
    if (price <= prices[i]) {
      const span = prices[i] - prices[i - 1];
      if (span === 0) return fitted[i];
      const t = (price - prices[i - 1]) / span;
      return fitted[i - 1] + t * (fitted[i] - fitted[i - 1]);
    }
  }
  return fitted[fitted.length - 1];
}

/**
 * Fit the price-to-EP curve per position and score every player against it.
 *
 * Positions are fitted separately because a £5.0m defender and a £5.0m forward
 * are not competing for the same job — pooling them would mark every cheap
 * defender as a bargain purely because forwards score more.
 *
 * Positions with fewer than `FRONTIER_MIN_SAMPLE` priced players are returned
 * with a surplus of zero rather than a curve fitted to noise.
 */
export function assessValue(players: FrontierInput[]): ValueAssessment[] {
  const byPosition = new Map<PositionId, FrontierInput[]>();
  for (const player of players) {
    const group = byPosition.get(player.position);
    if (group) group.push(player);
    else byPosition.set(player.position, [player]);
  }

  const results: ValueAssessment[] = [];

  for (const [position, group] of byPosition) {
    if (group.length < FRONTIER_MIN_SAMPLE) {
      for (const p of group) {
        results.push({
          playerId: p.playerId,
          position,
          price: p.price,
          ep: p.ep,
          expectedEpForPrice: p.ep,
          valueSurplus: 0,
        });
      }
      continue;
    }

    const sorted = [...group].sort((a, b) => a.price - b.price);
    const prices = sorted.map((p) => p.price);
    const fitted = isotonic(
      sorted.map((p) => p.ep),
      sorted.map(() => 1),
    );

    for (const p of group) {
      const expected = interpolate(prices, fitted, p.price);
      results.push({
        playerId: p.playerId,
        position,
        price: p.price,
        ep: p.ep,
        expectedEpForPrice: expected,
        valueSurplus: p.ep - expected,
      });
    }
  }

  return results;
}

/** Index the assessments by player id, for joining onto a squad view. */
export function valueSurplusById(
  assessments: ValueAssessment[],
): Map<number, number> {
  return new Map(assessments.map((a) => [a.playerId, a.valueSurplus]));
}
