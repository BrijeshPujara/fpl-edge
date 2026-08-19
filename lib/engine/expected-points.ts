import {
  APPEARANCE_POINTS,
  ASSIST_POINTS,
  CARD_POINTS,
  CLEAN_SHEET_POINTS,
  DEFCON_POINTS,
  DEFCON_THRESHOLD,
  GOALS_CONCEDED_PENALTY,
  GOAL_POINTS,
  POSITION,
  type PositionId,
} from "@/lib/rules";
import {
  BASE_REDS_PER_90,
  BASE_YELLOWS_PER_90,
  BONUS_POSITIONAL_CORRECTION,
  DEFCON_BASE_RATE,
  DEFCON_MIN_SAMPLE,
  FORM_WEIGHTS,
  HOME_ADVANTAGE,
  HORIZON_DISCOUNT,
  LEAGUE_MEAN_GOALS_PER_TEAM,
  OPPONENT_ADJUSTMENT_BOUNDS,
  OPPONENT_ADJUSTMENT_NEUTRAL,
  OPPONENT_ADJUSTMENT_SCALE,
  SHRINKAGE_END_GW,
  SHRINKAGE_INITIAL_WEIGHT,
} from "./constants";
import { projectMinutes, type MinutesInput } from "./minutes";

/**
 * The expected points model. The heart of the project.
 *
 * Pure functions, no I/O, no environment. Every input is passed in, which is
 * what makes the whole thing unit-testable and backtestable.
 *
 * EP(player, fixture) =
 *     P(60+) x 2  +  P(1-59) x 1
 *   + xG90_adj  x minutesScale x goalPoints(position)
 *   + xA90_adj  x minutesScale x 3
 *   + P(clean sheet) x cleanSheetPoints(position)
 *   + E(defcon) + E(bonus)
 *   - E(goals conceded penalty)     // GK and DEF only
 *   - E(cards)
 *
 * Everything after the appearance terms is scaled by minutes, because a player
 * who does not play cannot score. See `minutes.ts` — that is the input this
 * model is most sensitive to.
 */

export interface GameweekSample {
  minutes: number;
  started: boolean;
  expectedGoals: number;
  expectedAssists: number;
  defensiveContribution: number;
  bonus: number;
  goalsConceded: number;
  yellowCards: number;
  redCards: number;
}

/** Prior-season per-90 rates, used to shrink toward early in a season. */
export interface PriorSeasonRates {
  xGper90: number;
  xAper90: number;
  bonusPerAppearance: number;
  defconHitRate: number;
}

export interface PlayerModelInput {
  playerId: number;
  position: PositionId;
  teamId: number;
  minutes: MinutesInput;
  /** Recent gameweeks, most recent first. */
  recent: GameweekSample[];
  priorSeason?: PriorSeasonRates | null;
}

/**
 * One fixture to project.
 *
 * Strength ratings are nullable because the API reports them as zero before a
 * season is under way. Pass null rather than zero — a zero would be read as
 * "very weak" and produce a wildly optimistic clean-sheet probability.
 */
export interface FixtureContext {
  gw: number;
  isHome: boolean;
  teamDefence: number | null;
  opponentAttack: number | null;
  /** Mean of the same rating across the league, for normalisation. */
  leagueMeanAttack: number | null;
  /** Standard deviation of that rating. Null or zero disables the adjustment. */
  leagueStdAttack: number | null;
  /** Opponent's defensive rating, for adjusting this player's attacking output. */
  opponentDefence: number | null;
  leagueMeanDefence: number | null;
  leagueStdDefence: number | null;
}

export interface ExpectedPointsBreakdown {
  appearance: number;
  goals: number;
  assists: number;
  cleanSheet: number;
  defcon: number;
  bonus: number;
  goalsConceded: number;
  cards: number;
  total: number;
  /** Surfaced because it explains most of the variance between players. */
  pMinutes: number;
  /** Expected goals conceded by the player's team. Drives clean sheets. */
  lambdaAgainst: number;
}

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

/** Weighted mean over recent gameweeks, most recent first. Renormalised. */
function weightedRate(
  samples: GameweekSample[],
  pick: (s: GameweekSample) => number,
): number | null {
  let total = 0;
  let weight = 0;
  for (let i = 0; i < samples.length && i < FORM_WEIGHTS.length; i++) {
    // Per-90 only makes sense over minutes actually played.
    if (samples[i].minutes <= 0) continue;
    total += (pick(samples[i]) / samples[i].minutes) * 90 * FORM_WEIGHTS[i];
    weight += FORM_WEIGHTS[i];
  }
  return weight === 0 ? null : total / weight;
}

/**
 * Weight given to prior-season rates at a given gameweek.
 *
 * Decays linearly from SHRINKAGE_INITIAL_WEIGHT at GW1 to zero at
 * SHRINKAGE_END_GW. Early samples are too thin to trust on their own, and a
 * model that believes three good gameweeks is a model that chases form.
 */
export function shrinkageWeight(gw: number): number {
  if (gw >= SHRINKAGE_END_GW) return 0;
  const remaining = (SHRINKAGE_END_GW - gw) / (SHRINKAGE_END_GW - 1);
  return Math.max(0, Math.min(1, remaining)) * SHRINKAGE_INITIAL_WEIGHT;
}

function blend(current: number | null, prior: number | null, gw: number): number {
  const w = shrinkageWeight(gw);
  if (current === null && prior === null) return 0;
  if (current === null) return prior ?? 0;
  if (prior === null) return current;
  return current * (1 - w) + prior * w;
}

/**
 * Opponent adjustment as a multiplier on an attacking rate.
 *
 * Normalised against the league's own mean and spread rather than an assumed
 * scale, because the FPL strength fields have changed scale between seasons and
 * read as zero pre-season. Returns a neutral 1.0 whenever the ratings carry no
 * information — which is the correct answer, not a fallback.
 */
export function opponentAdjustment(
  opponentRating: number | null,
  leagueMean: number | null,
  leagueStd: number | null,
): number {
  if (
    opponentRating === null ||
    leagueMean === null ||
    leagueStd === null ||
    leagueStd <= 0 ||
    opponentRating <= 0
  ) {
    return OPPONENT_ADJUSTMENT_NEUTRAL;
  }
  // A weaker opponent (lower defensive rating) raises expected output.
  const z = (leagueMean - opponentRating) / leagueStd;
  const raw = 1 + z * OPPONENT_ADJUSTMENT_SCALE;
  return Math.max(
    OPPONENT_ADJUSTMENT_BOUNDS.min,
    Math.min(OPPONENT_ADJUSTMENT_BOUNDS.max, raw),
  );
}

/**
 * Expected goals conceded by the player's team — the Poisson rate that drives
 * clean sheets and the goals-conceded penalty.
 */
export function expectedGoalsAgainst(fixture: FixtureContext): number {
  const attackMultiplier = opponentAdjustment(
    // Invert: a STRONGER opponent attack should raise goals against, so pass
    // the mirrored rating through the same helper.
    fixture.opponentAttack === null || fixture.leagueMeanAttack === null
      ? null
      : 2 * fixture.leagueMeanAttack - fixture.opponentAttack,
    fixture.leagueMeanAttack,
    fixture.leagueStdAttack,
  );

  const defenceMultiplier = opponentAdjustment(
    fixture.teamDefence,
    fixture.leagueMeanDefence,
    fixture.leagueStdDefence,
  );

  // Away teams concede slightly more; home advantage applies to the side at home.
  const venue = fixture.isHome ? 1 / HOME_ADVANTAGE : HOME_ADVANTAGE;

  return Math.max(
    0.1,
    LEAGUE_MEAN_GOALS_PER_TEAM * attackMultiplier * defenceMultiplier * venue,
  );
}

/** Poisson P(X = 0). */
export function poissonZero(lambda: number): number {
  return Math.exp(-lambda);
}

/**
 * Expected value of floor(X / 2) for X ~ Poisson(lambda).
 *
 * This is the goals-conceded penalty for goalkeepers and defenders: one point
 * lost per two goals shipped, not per goal. Computed exactly over the Poisson
 * mass rather than approximated as lambda/2, which would overstate the penalty
 * by roughly a quarter of a point at typical rates.
 */
export function expectedConcededPenaltySteps(lambda: number): number {
  let pmf = Math.exp(-lambda);
  let total = 0;
  for (let k = 0; k <= 12; k++) {
    if (k > 0) pmf = (pmf * lambda) / k;
    total += Math.floor(k / 2) * pmf;
  }
  return total;
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export function expectedPoints(
  player: PlayerModelInput,
  fixture: FixtureContext,
): ExpectedPointsBreakdown {
  const minutes = projectMinutes(player.minutes);
  const { position } = player;

  const empty: ExpectedPointsBreakdown = {
    appearance: 0,
    goals: 0,
    assists: 0,
    cleanSheet: 0,
    defcon: 0,
    bonus: 0,
    goalsConceded: 0,
    cards: 0,
    total: 0,
    pMinutes: 0,
    lambdaAgainst: 0,
  };

  if (minutes.pAppears <= 0) return empty;

  const appearance =
    minutes.pSixty * APPEARANCE_POINTS.over60 +
    minutes.pShort * APPEARANCE_POINTS.under60;

  // Attacking output, blended toward prior season early on, then adjusted for
  // how good the opponent's defence is.
  const attackAdj = opponentAdjustment(
    fixture.opponentDefence,
    fixture.leagueMeanDefence,
    fixture.leagueStdDefence,
  );

  const xG90 =
    blend(
      weightedRate(player.recent, (s) => s.expectedGoals),
      player.priorSeason?.xGper90 ?? null,
      fixture.gw,
    ) * attackAdj;

  const xA90 =
    blend(
      weightedRate(player.recent, (s) => s.expectedAssists),
      player.priorSeason?.xAper90 ?? null,
      fixture.gw,
    ) * attackAdj;

  const minutesScale = minutes.expectedMinutes / 90;

  const goals = xG90 * minutesScale * GOAL_POINTS[position];
  const assists = xA90 * minutesScale * ASSIST_POINTS;

  // Clean sheets and the concession penalty both come off the same Poisson rate.
  const lambdaAgainst = expectedGoalsAgainst(fixture);

  // A clean sheet only pays if the player reaches 60 minutes.
  const cleanSheet =
    poissonZero(lambdaAgainst) *
    minutes.pSixty *
    CLEAN_SHEET_POINTS[position];

  // Goals conceded, for goalkeepers and defenders only.
  //
  // Two details that are easy to get wrong. First, the penalty is one point per
  // TWO goals, so the expectation is E[floor(X/2)], not lambda/2 — the latter
  // overstates it by roughly a quarter of a point at typical rates. Second,
  // unlike the clean sheet, this has no 60-minute qualification: goals concede
  // against you for as long as you are on the pitch, so it scales with expected
  // minutes rather than with P(60+).
  const concedes = position === POSITION.GK || position === POSITION.DEF;
  const goalsConceded = concedes
    ? expectedConcededPenaltySteps(lambdaAgainst) *
      minutesScale *
      GOALS_CONCEDED_PENALTY
    : 0;

  const defcon = expectedDefcon(player, minutes.pAppears);
  const bonus = expectedBonus(player, minutes.pAppears, fixture.gw);
  const cards = expectedCards(player, minutes.expectedMinutes);

  const total =
    appearance + goals + assists + cleanSheet + defcon + bonus + goalsConceded + cards;

  return {
    appearance,
    goals,
    assists,
    cleanSheet,
    defcon,
    bonus,
    goalsConceded,
    cards,
    total,
    pMinutes: minutes.pAppears,
    lambdaAgainst,
  };
}

/**
 * Defensive contributions: 2 points for clearing the positional threshold.
 *
 * Estimated from the player's own hit rate once there is enough history, and
 * blended toward the positional base rate below that. Centre-backs and holding
 * midfielders dominate here; forwards essentially never qualify.
 */
function expectedDefcon(player: PlayerModelInput, pAppears: number): number {
  const threshold = DEFCON_THRESHOLD[player.position];
  if (threshold === null) return 0;

  const played = player.recent.filter((s) => s.minutes > 0);
  const hits = played.filter(
    (s) => s.defensiveContribution >= threshold,
  ).length;

  const base = DEFCON_BASE_RATE[player.position];
  const rate =
    played.length === 0
      ? base
      : played.length >= DEFCON_MIN_SAMPLE
        ? hits / played.length
        : // Blend toward the positional mean while the sample is thin.
          (hits / played.length) * (played.length / DEFCON_MIN_SAMPLE) +
          base * (1 - played.length / DEFCON_MIN_SAMPLE);

  return rate * DEFCON_POINTS * pAppears;
}

/**
 * Bonus, from historical bonus per appearance and the positional correction.
 *
 * The BPS was rebalanced for 2026/27 to reduce overlap with defensive
 * contributions, so 2025/26 rates understate goalkeepers, full-backs, attacking
 * midfielders and forwards. The correction factor compensates and is flagged in
 * constants.ts as the most suspect number in the model.
 */
function expectedBonus(
  player: PlayerModelInput,
  pAppears: number,
  gw: number,
): number {
  const played = player.recent.filter((s) => s.minutes > 0);
  const current =
    played.length === 0
      ? null
      : played.reduce((sum, s) => sum + s.bonus, 0) / played.length;

  const rate = blend(current, player.priorSeason?.bonusPerAppearance ?? null, gw);
  return rate * BONUS_POSITIONAL_CORRECTION[player.position] * pAppears;
}

/** Cards, from the player's own rate where it exists, else the league rate. */
function expectedCards(
  player: PlayerModelInput,
  expectedMinutes: number,
): number {
  const played = player.recent.filter((s) => s.minutes > 0);
  const totalMinutes = played.reduce((sum, s) => sum + s.minutes, 0);

  const yellowPer90 =
    totalMinutes > 0
      ? (played.reduce((sum, s) => sum + s.yellowCards, 0) / totalMinutes) * 90
      : BASE_YELLOWS_PER_90;

  const redPer90 =
    totalMinutes > 0
      ? (played.reduce((sum, s) => sum + s.redCards, 0) / totalMinutes) * 90
      : BASE_REDS_PER_90;

  const scale = expectedMinutes / 90;
  return (
    yellowPer90 * scale * CARD_POINTS.yellow +
    redPer90 * scale * CARD_POINTS.red
  );
}

// ---------------------------------------------------------------------------
// Multi-gameweek
// ---------------------------------------------------------------------------

export interface HorizonResult {
  total: number;
  /** EP per gameweek in the horizon, including zeros for blanks. */
  perGameweek: { gw: number; ep: number; fixtures: number }[];
}

/**
 * Sum EP across the next N gameweeks.
 *
 * Handles doubles by summing every fixture in a gameweek, and blanks by
 * contributing zero. Optimising on this rather than a single gameweek is what
 * stops the model chasing last week's points — a player with one great fixture
 * and four terrible ones should not outrank a steady alternative.
 *
 * Future gameweeks are discounted slightly: a projection five weeks out can be
 * undone by a transfer, an injury or a price change, so certainty now is worth
 * marginally more.
 */
export function expectedPointsOverHorizon(
  player: PlayerModelInput,
  fixtures: FixtureContext[],
  gameweeks: number[],
): HorizonResult {
  const perGameweek = gameweeks.map((gw, index) => {
    const inGw = fixtures.filter((f) => f.gw === gw);
    const raw = inGw.reduce(
      (sum, fixture) => sum + expectedPoints(player, fixture).total,
      0,
    );
    const discounted = raw * Math.pow(HORIZON_DISCOUNT, index);
    return { gw, ep: discounted, fixtures: inGw.length };
  });

  return {
    total: perGameweek.reduce((sum, g) => sum + g.ep, 0),
    perGameweek,
  };
}
