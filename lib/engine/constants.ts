/**
 * Tunable constants for the expected-points model.
 *
 * Every value here is a *model* parameter, not a rule of the game — game rules
 * live in `lib/rules.ts`. Each export carries a comment explaining where the
 * number came from, because a magic number nobody can justify is a number
 * nobody can improve. Tune these against `scripts/backtest.ts`, not intuition.
 */

import { POSITION, type PositionId } from "@/lib/rules";

// ---------------------------------------------------------------------------
// Form window
// ---------------------------------------------------------------------------

/**
 * Weights for the rolling mean over recent gameweeks, most recent first.
 * Sums to 1.0. Chosen so the last three gameweeks carry ~66% of the signal —
 * responsive to role changes without whipsawing on a single blank.
 */
export const FORM_WEIGHTS = [0.25, 0.22, 0.19, 0.15, 0.11, 0.08] as const;

export const FORM_WINDOW = FORM_WEIGHTS.length;

/**
 * Before this gameweek, blend current-season rates with prior-season rates.
 * The shrinkage factor decays linearly to zero, so by GW6 the model runs on
 * this season's data alone. Early-season samples are too thin to trust.
 */
export const SHRINKAGE_END_GW = 6;

/**
 * Weight given to prior-season rates at GW1, decaying to 0 at SHRINKAGE_END_GW.
 * 0.7 says "at the very start, mostly believe last season".
 */
export const SHRINKAGE_INITIAL_WEIGHT = 0.7;

// ---------------------------------------------------------------------------
// Minutes
// ---------------------------------------------------------------------------

/**
 * Probability a player who starts goes on to play 60+ minutes. Derived from
 * the observation that most starters are substituted after the hour only when
 * the game is decided or they are being managed.
 */
export const P_STARTER_COMPLETES_60 = 0.86;

/**
 * Probability an unused-but-fit squad player appears at all as a substitute.
 * Applied when recent-start rate is near zero but the player is available.
 */
export const P_BENCH_CAMEO = 0.35;

/** Minutes a cameo appearance is assumed to last — under the 60-minute line. */
export const CAMEO_MINUTES = 20;

/**
 * `chance_of_playing_next_round` is reported as a percentage but is a coarse
 * signal — clubs round to 25/50/75. These map the reported percentage onto a
 * start probability, discounted because "75% chance of playing" historically
 * converts to starting less often than 75% of the time.
 */
export const CHANCE_OF_PLAYING_DISCOUNT = 0.85;

/** Number of recent gameweeks used to estimate a start rate from history. */
export const START_RATE_WINDOW = 6;

// ---------------------------------------------------------------------------
// Opponent adjustment
// ---------------------------------------------------------------------------

/**
 * How strongly opponent strength moves an attacking rate: a
 * one-standard-deviation gap in opponent rating maps onto roughly a 20% swing
 * in expected output. Deliberately conservative — the ratings update
 * infrequently and lag reality.
 *
 * The adjustment is computed against the *observed* league mean and spread of
 * the ratings rather than an assumed scale, because the FPL strength fields
 * have changed scale between seasons and read as zero pre-season. See
 * `hasStrengthRatings` in `lib/fpl/schemas.ts` — when it returns false, skip
 * the adjustment entirely and use a neutral 1.0.
 */
export const OPPONENT_ADJUSTMENT_SCALE = 0.2;

/** Neutral multiplier, used when opponent ratings are unavailable. */
export const OPPONENT_ADJUSTMENT_NEUTRAL = 1.0;

/** Clamp on the opponent multiplier so no single fixture dominates. */
export const OPPONENT_ADJUSTMENT_BOUNDS = { min: 0.6, max: 1.5 } as const;

/**
 * Home advantage as a multiplier on expected goals. ~1.1 reflects the
 * long-run Premier League home scoring edge in the post-2020 era, which is
 * smaller than the historical figure.
 */
export const HOME_ADVANTAGE = 1.1;

/** League-average goals scored per team per match — the Poisson baseline. */
export const LEAGUE_MEAN_GOALS_PER_TEAM = 1.42;

// ---------------------------------------------------------------------------
// Bonus
// ---------------------------------------------------------------------------

/**
 * The BPS was rebalanced for 2026/27 to reduce its overlap with defensive
 * contributions, improving bonus potential for goalkeepers, full-backs,
 * attacking midfielders and forwards. Historical bonus rates from 2025/26
 * therefore *understate* these positions.
 *
 * These are a first guess pending a backtest against 2026/27 data — treat them
 * as the most suspect numbers in this file and revisit once ~10 gameweeks of
 * this season exist.
 */
export const BONUS_POSITIONAL_CORRECTION: Record<PositionId, number> = {
  [POSITION.GK]: 1.15,
  [POSITION.DEF]: 1.05,
  [POSITION.MID]: 1.1,
  [POSITION.FWD]: 1.1,
};

// ---------------------------------------------------------------------------
// Defensive contributions
// ---------------------------------------------------------------------------

/**
 * Minimum appearances before a player's own DefCon hit-rate is trusted over
 * the positional average. Below this, blend toward the positional mean.
 */
export const DEFCON_MIN_SAMPLE = 5;

/**
 * Fallback rate of hitting the DefCon threshold, by position, for players with
 * too little history. Defenders clear 10 actions far more readily than
 * midfielders clear 12, and forwards almost never do.
 */
export const DEFCON_BASE_RATE: Record<PositionId, number> = {
  [POSITION.GK]: 0,
  [POSITION.DEF]: 0.32,
  [POSITION.MID]: 0.18,
  [POSITION.FWD]: 0.04,
};

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/** League-average yellow cards per 90 minutes, used when history is thin. */
export const BASE_YELLOWS_PER_90 = 0.14;

/** Red cards are rare enough that a flat league rate beats a noisy player rate. */
export const BASE_REDS_PER_90 = 0.006;

// ---------------------------------------------------------------------------
// Horizon
// ---------------------------------------------------------------------------

/**
 * Default number of gameweeks the optimiser looks ahead. Five is long enough
 * that fixture swings matter and short enough that the squad is still
 * recognisable at the far end.
 */
export const DEFAULT_HORIZON = 5;

/**
 * Per-gameweek discount applied to future EP. Slightly below 1 because a
 * gameweek five weeks out can be undone by a transfer, an injury, or a
 * price change — certainty now is worth marginally more than projection later.
 */
export const HORIZON_DISCOUNT = 0.95;

/**
 * Weight on bench EP in the objective when Bench Boost is *not* active. The
 * bench is not worthless — it covers rotation and flags — but it is close.
 * Set to 1.0 by the caller when Bench Boost is being evaluated.
 */
export const BENCH_WEIGHT = 0.12;

// ---------------------------------------------------------------------------
// Chip advisory thresholds
// ---------------------------------------------------------------------------

/** Single-gameweek EP a captain must clear before Triple Captain is advised. */
export const TRIPLE_CAPTAIN_EP_THRESHOLD = 8.5;

/** Squad-health inputs that push the wildcard advisory. */
export const WILDCARD_TRIGGERS = {
  /** A player below this EP is dead weight. */
  deadWeightEp: 4.0,
  /** This many flagged or dead-weight players and the squad needs surgery. */
  problemPlayerCount: 4,
} as const;
