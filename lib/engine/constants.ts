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
 * `chance_of_playing_next_round` is a coarse FITNESS signal — clubs round to
 * 25/50/75 — and it converts to actually starting less often than it claims,
 * hence the discount.
 *
 * Critically, it says nothing about ROLE. A value of 100 and a value of null
 * carry identical information: the club has no fitness concern. Neither tells
 * you whether the player starts; only appearance history does. Treating 100 as
 * a positive signal ranks the handful of players just cleared from injury above
 * every nailed starter with no news — verified against live data, where 467
 * available players report null and only 13 report 100.
 *
 * So fitness and role are separate factors: this discount applies only when the
 * reported chance is BELOW 100, and multiplies a start rate derived from
 * history rather than replacing it.
 */
export const CHANCE_OF_PLAYING_DISCOUNT = 0.85;

/**
 * Start probability assumed for an available player with no appearance history
 * at all — a new signing, or any player pre-season.
 *
 * Deliberately mid-range. Assuming a starter would talk the optimiser into
 * buying squad players; assuming a bench-warmer would make every pre-season
 * projection useless. With no information, say so rather than guessing high.
 */
export const NO_HISTORY_START_PRIOR = 0.5;

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
 * Weight on bench EP in the objective.
 *
 * Near-zero when Bench Boost is inactive. The bench is not literally worthless
 * — it covers rotation and flags — but valuing it any higher makes the
 * optimiser buy bench quality with money the starting XI should be spending.
 * That is the whole point of treating the bench as a budget lever: four cheap
 * bodies free perhaps £8-10m into the XI, which is worth far more than the
 * fraction of a point the bench actually returns.
 *
 * Exactly 1.0 under Bench Boost, when all fifteen score.
 */
export const BENCH_WEIGHT_INACTIVE = 0.05;
export const BENCH_WEIGHT_BENCH_BOOST = 1.0;

/**
 * Minimum P(minutes) for a bench player to count as genuine injury cover.
 *
 * 0.5 is the point at which a player is more likely to feature than not. Below
 * it, a bench slot is decoration: it cannot be relied on to auto-sub in.
 */
export const MIN_BENCH_PLAYING_PROB = 0.5;

/**
 * How many *outfield* bench players must clear that threshold.
 *
 * Two of the three. The goalkeeper bench slot is deliberately excluded: the
 * standard and correct play is a £4.0 non-playing backup keeper, precisely
 * because it frees budget into the XI. Counting the keeper would force either a
 * playing backup or all three outfield bench nailed — both of which spend the
 * money this constraint exists to free, defeating its own purpose.
 *
 * Set MIN_NAILED_BENCH_OUTFIELD to 3 and BENCH_RULE_INCLUDES_GK to true to get
 * the stricter "3 of 4" reading instead.
 */
export const MIN_NAILED_BENCH_OUTFIELD = 2;
export const BENCH_RULE_INCLUDES_GK = false;

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

// ---------------------------------------------------------------------------
// Value and price
// ---------------------------------------------------------------------------

/**
 * Weight converting expected price movement (tenths of a million) into the
 * points currency of the objective.
 *
 * DERIVATION. The objective is `Σ EP + priceWeight × Σ expectedPriceDelta`, so
 * priceWeight carries units of points per tenth. The only defensible value is
 * what a tenth of a million is actually worth inside the squad — which is
 * exactly the shadow price on the budget constraint, `marginalEpPerTenth`.
 *
 * 0.08 is a typical mid-season value of that dual over a 5-gameweek horizon:
 * roughly, £1.0m buys about 0.8 EP of upgrade once the squad is already
 * sensible. It is a static default because computing it requires a solve, and
 * the solve requires this weight — see `priceWeight: "auto"` in the optimiser
 * for the two-pass version that breaks that circularity by measuring the dual
 * first and re-solving.
 *
 * Tune against the backtest. If the measured shadow price settles well away
 * from this, change the default rather than living with the drift.
 */
export const PRICE_WEIGHT_DEFAULT = 0.08;

/**
 * Fraction of a price RISE you actually realise.
 *
 * FPL charges a 50% sell-on fee: bank £0.4m of profit and you keep £0.2m. A
 * price FALL, by contrast, is borne in full. The value of price movement is
 * therefore asymmetric, and treating it symmetrically overvalues rises by
 * about a factor of two.
 */
export const PRICE_RISE_REALISATION = 0.5;

/**
 * Gameweeks of transfer momentum used to project price movement, most recent
 * first. Shorter than FORM_WEIGHTS because transfer flow reverses far faster
 * than underlying performance does — a single bad result turns it around.
 */
export const PRICE_MOMENTUM_WEIGHTS = [0.5, 0.3, 0.2] as const;

/**
 * Net transfers, as a fraction of a player's owner count, needed to move the
 * price by £0.1m.
 *
 * FPL's real threshold is undisclosed and scales with ownership: a widely-owned
 * player needs far more net transfers in absolute terms than a differential.
 * Expressing it as a proportion of owners captures that scaling. 0.11 is the
 * community-estimated figure; it is the single most uncertain constant in this
 * file and the first thing to fit once a season of `price_history` exists.
 */
export const PRICE_CHANGE_THRESHOLD_RATIO = 0.11;

/**
 * Cap on projected price movement over a horizon, in tenths.
 *
 * Momentum decays and clubs' fortunes turn; projecting a player five gameweeks
 * out at +0.5m on the strength of one good week is how a price model starts
 * driving transfers it should only be informing.
 */
export const MAX_PROJECTED_PRICE_DELTA = 3;

/**
 * Minimum number of priced players in a position before the value frontier is
 * fitted. Below this the curve is noise dressed up as a benchmark.
 */
export const FRONTIER_MIN_SAMPLE = 8;
