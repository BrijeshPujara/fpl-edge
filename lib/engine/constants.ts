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

/**
 * Gameweeks that must be played before the engine will spend points on a hit.
 *
 * The guard used to ask whether ANY gameweek had been played, which one
 * gameweek satisfies. The morning GW1 was finalised the engine went from
 * refusing every hit to recommending an 8-point one, on projections whose
 * largest input was a single match — it wanted three moves for De Cuyper,
 * Hinshelwood and Guéhi, who between them were GW1's first, second and fifth
 * highest scorers.
 *
 * The reasoning that justified the guard does not weaken after one gameweek;
 * it barely moves. A hit is four certain points against an uncertain gain, and
 * a gain inferred from one match is the most uncertain kind there is.
 *
 * Derived rather than picked: this is the first gameweek at which observed
 * minutes carry more weight than last season's under the shrinkage in
 * `minutes.ts`. Before it, the model is still mostly quoting last season back,
 * and paying four points for that is paying for a year-old opinion.
 */
export const MINUTES_KNOWN_GAMEWEEKS = Math.floor(START_RATE_WINDOW / 2) + 1;

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
 * the ratings rather than an assumed scale, because the ratings have no fixed
 * scale to assume — a z-score is comparable whatever units they arrive in.
 * `fixtureRatings` in `lib/squad/projection.ts` supplies them from
 * `team_ratings`; when it has nothing usable, the adjustment falls back to a
 * neutral 1.0, which is the correct answer rather than a fallback.
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
 *
 * Applied as a HALF-STEP in both directions — multiply the home side, divide
 * the away side — so the ratio between them is the square, 1.21, and the
 * league mean is left where it was. Measured across all 380 matches of
 * 2025/26: home sides scored 1.526 a game to 1.224 away, a ratio of 1.247,
 * and home xG ran 1.227 times away xG. So 1.21 is very slightly conservative
 * and the effect is real chance creation rather than finishing variance.
 *
 * Note what this constant does NOT do. It appears exactly once, inside
 * `expectedGoalsAgainst`, so it moves clean sheets and the concession penalty
 * and nothing else. A player's own attacking rate is never adjusted for venue,
 * which means the model currently expects a striker to score at the same rate
 * home and away. `scoreline.ts` applies it to both sides, as the measurement
 * above says it should.
 */
export const HOME_ADVANTAGE = 1.1;

/**
 * League-average goals scored per team per match — the Poisson baseline.
 *
 * 2025/26 came in at 1.375 across 380 matches. Left at 1.42 as a multi-season
 * figure rather than refitted to one season, which would be chasing noise.
 */
export const LEAGUE_MEAN_GOALS_PER_TEAM = 1.42;

// ---------------------------------------------------------------------------
// Scorelines
// ---------------------------------------------------------------------------

/**
 * Largest goal count the scoreline grid carries explicitly.
 *
 * The top cell means "this many OR MORE" — the Poisson tail is folded into it
 * rather than discarded, so the grid still sums to exactly one. At realistic
 * rates the fold is worth less than a thousandth of the mass, but dropping it
 * would make every probability on the screen read fractionally low, and a
 * distribution that does not sum to one is a bug waiting to be found by
 * someone adding two of them together.
 */
export const MAX_GOALS = 10;

/**
 * Dixon-Coles low-score dependence.
 *
 * Two independent Poissons are a good model of a football match everywhere
 * except the corner where most matches actually live. Independence understates
 * 0-0 and 1-1 and therefore understates draws, and this reweights the four
 * cells where both sides scored at most one.
 *
 * THIS WAS FITTED TO ONE SEASON AND WAS WRONG. The first value here was -0.25,
 * swept on 2025/26 alone — a season with a 27.4% draw rate against a long-run
 * Premier League figure near 24%. Tested on 2024/25, which it had never seen:
 *
 *     rho     RPS 24/25   RPS 25/26   predicted draws 24/25 (actual 23.2%)
 *     0.00    0.2024      0.2089      22.3%
 *    -0.10    0.2024      0.2085      24.3%
 *    -0.13    0.2025      0.2084      24.9%
 *    -0.15    0.2025      0.2084      25.4%
 *    -0.25    0.2029      0.2084      27.4%
 *    -0.30    0.2032      0.2084      28.4%
 *
 * On the unseen season -0.25 is the WORST value tested and over-predicts draws
 * by four points. Summed across both seasons the optimum is -0.10 to -0.15.
 * Dixon and Coles estimated ~-0.13 on English league data, which lands inside
 * that window and is the corroboration the original sweep should have been
 * checked against.
 *
 * The magnitude matters more than it looks. tau(1,1) is 1 - rho, a FLAT boost
 * to the 1-1 cell applied no matter how lopsided the fixture — 25% at the old
 * value, which was enough to put 1-1 above 2-1 for a side favoured 60/24/16 at
 * home. At 0.13 it is 13% and the ordering follows the rates again.
 *
 * Two seasons of one league. Refit when there are more.
 */
export const DIXON_COLES_RHO = -0.13;

/**
 * Matches per club before this season's ratings fully replace last season's.
 *
 * Measured by refitting 2025/26 gameweek by gameweek against a prior fitted on
 * all of 2024/25, predicting each gameweek from matches played before it only.
 * Mean RPS, lower is better:
 *
 *     schedule                 all      GW1-6    GW7-19   GW20-38
 *     prior only               0.2254   0.2166   0.2235   0.2295
 *     this season only         0.2191   0.2640   0.2123   0.2095
 *     ramp over 10             0.2113   0.2156   0.2119   0.2095
 *     ramp over 15             0.2108   0.2140   0.2112   0.2095
 *     ramp over 20             0.2110   0.2138   0.2120   0.2095
 *     half-life 15             0.2132   0.2142   0.2139   0.2125
 *
 * Two things that table settles. Frozen prior-season ratings do not merely
 * stop improving, they DECAY — 0.2166 early against 0.2295 late, as the league
 * drifts away from the season they describe. And switching to this season
 * outright is far worse than doing nothing for the first six gameweeks.
 *
 * Fifteen is markedly slower than the GW6 crossover the player model uses in
 * FORM_WEIGHTS, and the difference is real rather than an inconsistency:
 * twenty clubs splitting 380 matches is much less evidence per parameter than
 * a player's own minutes. The basin is flat between 15 and 20, so no more
 * precision is claimed than that; 15 is chosen because it is best early, where
 * the schedule actually matters.
 */
export const RATING_BLEND_MATCHES = 15;

/**
 * Half-life, in gameweeks, of a match's weight in the in-season rating fit.
 *
 * Form is not a separate signal bolted on beside the ratings — it IS the
 * ratings, fitted with recent football counting for more than early football.
 * A match this many gameweeks old counts half as much as one played now.
 *
 * Swept over both held-out seasons, RPS across GW7-38 where in-season data
 * drives the fit:
 *
 *     half-life      2024/25   2025/26   combined
 *     none (equal)   0.2007    0.2092    0.2050
 *     20 gw          0.1994    0.2089    0.2042
 *     12 gw          0.1988    0.2089    0.2039
 *     8 gw           0.1984    0.2091    0.2038
 *     5 gw           0.1986    0.2097    0.2041
 *
 * Every decayed setting beat equal weighting on BOTH seasons, which is
 * stronger evidence than any individual t-statistic here (the best is -1.62):
 * the direction is consistent where the multi-season prior's was not. The
 * basin is flat between 8 and 12 and the two seasons disagree about which end
 * of it is better, so this sits in the middle rather than at either season's
 * optimum.
 *
 * Five gameweeks is measurably too aggressive on both, which is the useful
 * negative result: chasing the last month alone is worse than ignoring form.
 */
export const FORM_HALF_LIFE_GAMEWEEKS = 10;

// ---------------------------------------------------------------------------
// Chip planning
// ---------------------------------------------------------------------------

/**
 * How many players per position the chip planner considers, by expected
 * points, on top of the ones it keeps unconditionally.
 *
 * The planner runs a full squad rebuild for every gameweek in its horizon —
 * twenty mixed-integer solves over six hundred players, measured at 1055ms and
 * by some distance the slowest thing this app does.
 *
 * Most of that pool cannot appear in any answer. The pruning is in two parts,
 * and only the second is a judgement call:
 *
 *   1. Within one position, price AND club, players are interchangeable in
 *      every constraint the optimiser has, so only the top three by expected
 *      points can ever be needed — three being the per-club cap. This cannot
 *      change an answer. Alone it takes 599 players to 469 and 1055ms to
 *      728ms, which is correct and not fast enough.
 *
 *   2. Then the best `CHIP_POOL_PER_POSITION` per position by expected points.
 *      This one could in principle change an answer, and measured on its own
 *      it did: a plain top-20 moved a chip gain by 1.21 points.
 *
 * The reason it moved is worth recording, because it is not the reason it
 * looks like. Ranking by expected points discards the CHEAPEST players, and a
 * rebuild needs those to afford the players it actually wants. Keeping every
 * player at the two cheapest price points per position restores them, and the
 * same top-20 then reproduces the full-pool answer exactly:
 *
 *     pool                       n     ms   identical
 *     full                     599   1055   (baseline)
 *     top 20 per position       95     84   no, off by 1.21
 *     top 3 per pos+price+club 469    728   yes
 *     safe + top 20 + cheapest 286    279   yes
 *
 * Verified identical across every chip and gameweek on a real squad, not
 * merely close. Twenty is deliberately well past where the answer stopped
 * moving rather than at the edge of it.
 */
export const CHIP_POOL_PER_POSITION = 20;

/**
 * Price points per position kept in full regardless of expected points.
 *
 * The enablers. See CHIP_POOL_PER_POSITION for why dropping them is what
 * breaks a pruned pool.
 */
export const CHIP_POOL_CHEAP_TIERS = 2;

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

// ---------------------------------------------------------------------------
// Set-piece and penalty duty
// ---------------------------------------------------------------------------

/**
 * Penalties awarded to one team per match.
 *
 * The Premier League has run close to 100 penalties across 380 matches in each
 * of the last few seasons — 0.26 per match, so 0.13 per team. VAR nudged this
 * up and then back down again; 0.13 is the stable centre.
 */
export const PENALTIES_PER_TEAM_PER_MATCH = 0.13;

/** Premier League penalty conversion, long-run. Roughly four in five. */
export const PENALTY_CONVERSION = 0.79;

/**
 * Probability the nth-listed penalty taker takes a penalty GIVEN that he is on
 * the pitch when one is awarded.
 *
 * Note the conditioning: the reason a second and third name exist at all is
 * that the first is often absent, and absence is already handled by the minutes
 * model. What is left is the residual — a first-choice taker occasionally
 * defers, and someone on a hat-trick occasionally takes the ball off him. The
 * shares are therefore top-heavy and sum to approximately one across a club.
 */
export const PENALTY_TAKER_SHARE = [0.8, 0.15, 0.04] as const;

/**
 * Corners plus indirect free kicks delivered by one team per match.
 *
 * Premier League corners run at about 5.2 per team per match; indirect free
 * kicks in delivery positions add roughly one more. Both go to the same name on
 * the team sheet, which is why the API reports them as a single order.
 */
export const SET_PIECE_DELIVERIES_PER_TEAM_PER_MATCH = 6.2;

/**
 * Probability that one delivery becomes a goal the deliverer is credited with
 * assisting. Around 2.3% of corners are scored from directly; treating indirect
 * free kicks as comparable is a simplification that errs low.
 */
export const SET_PIECE_DELIVERY_ASSIST_RATE = 0.023;

/** Delivery share by listed order. Same conditioning as PENALTY_TAKER_SHARE. */
export const SET_PIECE_TAKER_SHARE = [0.75, 0.18, 0.05] as const;

/**
 * Appearances after which set-piece duty stops contributing anything.
 *
 * This is the anti-double-counting term, and it is the reason this feature is
 * not simply additive. FPL's `expected_goals` is Opta xG, which INCLUDES
 * penalties at ~0.79 apiece, and `expected_assists` credits set-piece
 * deliveries like any other. A player with a full form window of appearances
 * therefore already has his penalty and corner output inside the observed
 * rates, and adding a duty term on top would charge it twice.
 *
 * What the duty flags genuinely add is information the observed window does not
 * have: who takes them *now*. That matters most when the window is empty or
 * thin — a new season, a new signing, a duty that just changed hands — and by
 * construction matters not at all once the window is full of the player's own
 * penalties. So the credit decays linearly from full to zero across a complete
 * form window.
 *
 * Set to FORM_WINDOW deliberately: the credit and the observation it would
 * otherwise duplicate are measured over exactly the same span.
 *
 * MEASURED, not assumed. Backtesting a floor under the decay — i.e. crediting
 * duty even to players with a full window — makes the model monotonically
 * worse, and worse precisely where penalty takers live:
 *
 *   floor   overall MAE   MID       FWD
 *   0.00    1.010         +2.4%     -3.9%
 *   0.50    1.012         .         .
 *   1.00    1.013         +1.9%     -4.2%
 *
 * A floor of 1.0 is the naive "just add the penalty term" implementation.
 * Goalkeepers are unmoved at every floor, which is the control: they take no
 * penalties, so nothing about them should change, and nothing does.
 *
 * Reproduce with `SP_FLOOR` wired into `setPieceCredit` and `npm run backtest`.
 */
export const SET_PIECE_CREDIT_APPEARANCES = FORM_WINDOW;

// ---------------------------------------------------------------------------
// Chip planning
// ---------------------------------------------------------------------------

/**
 * Gameweeks ahead the chip planner looks.
 *
 * Longer than DEFAULT_HORIZON on purpose. The squad optimiser plans a team that
 * has to survive five weeks; the chip planner is answering "is a better week
 * coming before this window shuts", and a five-week view cannot see a December
 * double from October. Ten weeks reaches far enough to catch the fixture swings
 * that actually decide chip timing.
 *
 * The cost is real — Free Hit and Wildcard each need a solve per gameweek — so
 * this is a balance against page render time, not a free parameter.
 */
export const CHIP_SCAN_HORIZON = 10;

/**
 * Gameweeks over which confidence in a chip projection halves.
 *
 * Distant projections are worth less than near ones, but not nothing: the
 * biggest chip weeks of a season are precisely the far-off doubles, so a hard
 * horizon cut-off would blind the planner to exactly what it exists to find.
 * Geometric decay discounts them without discarding them.
 *
 * Five gameweeks is roughly the span over which a squad and the fixture list
 * both stop resembling today's — the same reasoning behind DEFAULT_HORIZON.
 */
export const CHIP_CONFIDENCE_HALF_LIFE = 5;

/**
 * Floor under that decay.
 *
 * Without it, a gameweek far enough out is worth arbitrarily close to zero and
 * the planner would sooner burn a chip on a mediocre week now than hold it for
 * a known double later. The floor keeps distant opportunities visible; it is a
 * deliberate refusal to let the discount run to nothing.
 */
export const CHIP_CONFIDENCE_FLOOR = 0.25;

// ---------------------------------------------------------------------------
// News signal
// ---------------------------------------------------------------------------

/**
 * Bounds on any adjustment derived from team news.
 *
 * Deliberately narrow, and the narrowness is the point. Whatever produces the
 * multiplier — the deterministic classifier in `news-signal.ts` today, a
 * language model reading a press conference later — it is adjusting the single
 * most sensitive input in the engine, and it must not be able to make a claim
 * the evidence cannot support.
 *
 * Inside these bounds it can halve a projection or lift it by a fifth. It
 * cannot turn a bench player into a starter, and it cannot rule out a player
 * the game says is fit. Both of those need better evidence than a sentence.
 */
export const NEWS_MULTIPLIER_BOUNDS = { min: 0.5, max: 1.2 } as const;

/**
 * Multipliers by what the news actually says, over and above the percentage.
 *
 * These exist because FPL's `news` string and `chance_of_playing_next_round`
 * are nearly redundant — "Hamstring injury - 75% chance of playing" alongside a
 * chance of 75 — so the only information the text adds is the KIND of problem.
 * That turns out to matter in one direction and one direction only: some
 * categories imply a reduced role even when the player is passed fit.
 *
 * A player short of match fitness who is cleared to play is a substitute, not a
 * starter, and the percentage cannot say so. A muscle injury carries
 * re-aggravation risk and an early substitution that a knock does not.
 *
 * All at or below 1.0. Nothing in a news string is grounds for projecting a
 * player ABOVE what the club's own percentage says — the text is the club's
 * explanation of that percentage, not a second opinion on it.
 *
 * First estimates, uncalibrated. `player_gw_stats` will be able to settle them
 * once there are enough flagged players with outcomes to measure against.
 */
export const NEWS_CATEGORY_MULTIPLIER = {
  /** Cleared to play but short of fitness — expect minutes off the bench. */
  matchFitness: 0.7,
  /** Muscle injuries re-aggravate and get managed. */
  muscular: 0.9,
  /** A knock is the mildest flag the game issues. */
  knock: 1.0,
  /** Named non-muscular injury: ankle, knee, shoulder. */
  injury: 0.95,
  /** Illness clears fast but saps a full ninety. */
  illness: 0.9,
  /** Personal reasons, international duty, unspecified. No role inference. */
  other: 1.0,
} as const;

// ---------------------------------------------------------------------------
// Prior season
// ---------------------------------------------------------------------------

/**
 * Minimum minutes before a completed season is trusted as a prior.
 *
 * Roughly ten full matches. Below that a per-90 rate is one good afternoon
 * multiplied up — and it would arrive weighted at SHRINKAGE_INITIAL_WEIGHT in
 * gameweek one, so a fringe player who scored in his only substitute appearance
 * would open the season projected as elite.
 *
 * Deliberately not higher. The players this term exists to help are exactly the
 * ones with thin current-season evidence, and a threshold set at a full season
 * would exclude the rotation players and January signings who need it most.
 */
export const PRIOR_SEASON_MIN_MINUTES = 900;

/**
 * The first season FPL published expected goals.
 *
 * A fact about the data source, not a tunable. Seasons before this one are
 * present in `history_past` and report `expected_goals: 0.00` for EVERY player
 * — verified against live data, where 2021/22 and earlier have a maximum xG of
 * zero across the league while 2022/23 peaks at 28.54.
 *
 * Without this guard a player whose last substantial season was 2021/22 would
 * be modelled as having no attacking threat whatsoever, weighted at 0.7 in
 * gameweek one. Absence of data is not evidence of absence, and the two look
 * identical in this field.
 *
 * Compared with localeCompare, which orders "2021/22" before "2022/23"
 * correctly because FPL writes seasons zero-padded and year-first.
 */
export const FIRST_XG_SEASON = "2022/23";

// ---------------------------------------------------------------------------
// Captaincy
// ---------------------------------------------------------------------------

/**
 * The score at or above which a captain has "hauled".
 *
 * Ten points is the conventional line and it survives scrutiny: doubled it is
 * twenty, which is roughly the difference between a good gameweek and a
 * forgettable one against a field where the average manager scores around
 * fifty. Below that a captain has merely not hurt you.
 */
export const CAPTAIN_HAUL_THRESHOLD = 10;

/**
 * The score at or below which a captain has blanked.
 *
 * Two points, because that is what a player earns for turning up and doing
 * nothing else. Doubling two is the outcome that actually loses a gameweek —
 * not a red card, which is rare, but ninety anonymous minutes.
 */
export const CAPTAIN_BLANK_THRESHOLD = 2;
