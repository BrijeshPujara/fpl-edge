import {
  MAX_PROJECTED_PRICE_DELTA,
  PRICE_CHANGE_THRESHOLD_RATIO,
  PRICE_MOMENTUM_WEIGHTS,
  PRICE_RISE_REALISATION,
} from "./constants";

/**
 * Expected price movement over a horizon.
 *
 * Pure. Estimates how far a player's price will move from net transfer
 * momentum, scaled against ownership.
 *
 * THE MECHANIC. FPL moves a price when net transfers cross an undisclosed
 * threshold that scales with how many people own the player: a 50%-owned
 * premium needs vastly more net transfers in to rise than a 2%-owned
 * differential does. Expressing the threshold as a proportion of the owner base
 * captures that, and is why ownership is an input rather than a nicety.
 *
 * ASYMMETRY. Price movement is not worth its face value. FPL charges a 50%
 * sell-on fee, so banking a £0.4m rise puts £0.2m in your pocket — but a fall
 * is borne in full. `realisableDelta` applies that, and it is the number the
 * optimiser should use. Treating movement symmetrically overvalues rises about
 * twofold and quietly biases the squad toward chasing risers.
 *
 * DATA REALITY. Both inputs come from `player_gw_stats`, which is empty until
 * gameweeks have been played, and `price_history`, which by design records only
 * actual changes. Before roughly GW4 there is nothing to fit and this returns
 * zero with `confidence: "none"`. That is the honest answer, and callers must
 * not present a zero from an empty model as a prediction of no movement.
 */

export interface PriceMomentumInput {
  playerId: number;
  /**
   * Net transfers in (positive) or out (negative) per gameweek, most recent
   * first — `transfers_balance` from `player_gw_stats`.
   */
  transfersBalance: number[];
  /** Current ownership as a percentage, 0-100. */
  ownershipPercent: number;
  /** Ownership one gameweek ago, for trend. Null when unknown. */
  previousOwnershipPercent: number | null;
  /** Total active FPL managers. Sets the scale of the owner base. */
  totalManagers: number;
}

export type PriceConfidence = "none" | "low" | "medium";

export interface PriceProjection {
  playerId: number;
  /** Expected movement in tenths of a million over the horizon. */
  expectedDelta: number;
  /**
   * The delta adjusted for the 50% sell-on fee on gains. This is what the
   * optimiser objective should use — not `expectedDelta`.
   */
  realisableDelta: number;
  confidence: PriceConfidence;
}

/** Weighted mean of recent net transfers, most recent first. */
function weightedMomentum(balances: number[]): number {
  if (balances.length === 0) return 0;
  let total = 0;
  let weightUsed = 0;
  for (let i = 0; i < balances.length && i < PRICE_MOMENTUM_WEIGHTS.length; i++) {
    total += balances[i] * PRICE_MOMENTUM_WEIGHTS[i];
    weightUsed += PRICE_MOMENTUM_WEIGHTS[i];
  }
  // Renormalise when fewer gameweeks exist than weights, so a player with one
  // gameweek of history is not scaled down to half their momentum.
  return weightUsed === 0 ? 0 : total / weightUsed;
}

export function projectPriceChange(
  input: PriceMomentumInput,
  horizon: number,
): PriceProjection {
  const { playerId, transfersBalance, ownershipPercent, totalManagers } = input;

  const hasHistory = transfersBalance.length > 0;
  const hasScale = totalManagers > 0 && ownershipPercent > 0;

  if (!hasHistory || !hasScale) {
    return {
      playerId,
      expectedDelta: 0,
      realisableDelta: 0,
      confidence: "none",
    };
  }

  const owners = (ownershipPercent / 100) * totalManagers;
  const threshold = owners * PRICE_CHANGE_THRESHOLD_RATIO;
  if (threshold <= 0) {
    return { playerId, expectedDelta: 0, realisableDelta: 0, confidence: "none" };
  }

  const momentum = weightedMomentum(transfersBalance);

  // Changes per gameweek, then projected across the horizon. Momentum is
  // assumed to persist rather than decay, which the cap below compensates for.
  const changesPerGw = momentum / threshold;
  const raw = changesPerGw * horizon;

  const expectedDelta = Math.max(
    -MAX_PROJECTED_PRICE_DELTA,
    Math.min(MAX_PROJECTED_PRICE_DELTA, raw),
  );

  // Gains are halved by the sell-on fee; falls are borne in full.
  const realisableDelta =
    expectedDelta > 0 ? expectedDelta * PRICE_RISE_REALISATION : expectedDelta;

  return {
    playerId,
    expectedDelta,
    realisableDelta,
    confidence:
      transfersBalance.length >= PRICE_MOMENTUM_WEIGHTS.length ? "medium" : "low",
  };
}

/** Project a whole player pool. */
export function projectPriceChanges(
  inputs: PriceMomentumInput[],
  horizon: number,
): Map<number, PriceProjection> {
  return new Map(
    inputs.map((input) => [input.playerId, projectPriceChange(input, horizon)]),
  );
}
