import { FIRST_XG_SEASON, PRIOR_SEASON_MIN_MINUTES } from "./constants";
import type { PriorSeasonRates } from "./expected-points";

/**
 * Turning a completed season into the rates the model shrinks toward.
 *
 * Pure. The shrinkage schedule in `expected-points.ts` weights prior-season
 * rates at 0.7 in gameweek one, decaying to zero by gameweek six — so this is
 * the input that decides how the model behaves for the first month and a half
 * of a season, when there is almost no current-season evidence to work with.
 *
 * Until now it was passed `null`, which made that whole schedule inert.
 */

export interface SeasonTotals {
  seasonName: string;
  minutes: number;
  starts: number;
  /** Null for seasons before FPL published expected goals at all. */
  expectedGoals: number | null;
  expectedAssists: number | null;
  bonus: number;
}

/**
 * Rates from a season, or null when the season cannot support them.
 *
 * Three ways it returns null, all deliberate:
 *
 *   * The season predates expected goals. FPL did not publish xG before
 *     2022/23 and reports 0.00 for every player in those seasons — verified
 *     against live data. That zero is missing data wearing the costume of a
 *     measurement, and believing it would model a player as having never
 *     threatened a goal.
 *   * The field is genuinely absent, in a payload that omits it entirely.
 *   * Too few minutes. A per-90 rate from 90 minutes of football is one
 *     match's noise multiplied up, and it arrives weighted at 0.7 in gameweek
 *     one. A fringe player who scored in his only appearance would open the
 *     season projected as elite.
 */
export function ratesFromSeason(season: SeasonTotals): PriorSeasonRates | null {
  if (season.seasonName.localeCompare(FIRST_XG_SEASON) < 0) return null;
  if (season.expectedGoals === null || season.expectedAssists === null) {
    return null;
  }
  if (season.minutes < PRIOR_SEASON_MIN_MINUTES) return null;

  const per90 = (total: number) => (total / season.minutes) * 90;

  return {
    xGper90: per90(season.expectedGoals),
    xAper90: per90(season.expectedAssists),
    bonusPerAppearance: bonusPerAppearance(season),
    // Not derivable, and the field is unread.
    //
    // `defensive_contribution` in a season row is a TOTAL of defensive
    // actions, not a count of gameweeks that cleared the threshold. A player
    // averaging eleven actions might clear twelve in half his matches or in
    // none of them, and a season total cannot distinguish those. Inferring a
    // hit rate would mean inventing a distribution, so the model keeps using
    // its positional base rate until real gameweeks arrive.
    defconHitRate: 0,
  };
}

/**
 * Bonus per appearance, estimated from starts.
 *
 * `history_past` reports starts but not appearances, so substitute outings are
 * missing from the denominator and this runs slightly high — a player with 30
 * starts and 4 cameos is divided by 30 rather than 34, overstating the rate by
 * about a tenth.
 *
 * Left uncorrected on purpose. Any correction would be a guess at how many
 * cameos a player made, the bias is small and in a known direction, and the
 * whole term is weighted to zero by gameweek six. A fudge factor here would be
 * harder to reason about than a documented lean.
 */
function bonusPerAppearance(season: SeasonTotals): number {
  const appearances = Math.max(season.starts, 1);
  return season.bonus / appearances;
}

/**
 * Pick the season to shrink toward, given everything known about a player.
 *
 * The most recent usable one. Not an average across careers: a player's rate
 * two seasons ago is a worse guide than last season, and blending them would
 * hide a step change — a breakout, a new position, a move to a better team —
 * behind an average that describes neither.
 *
 * Seasons are compared by name, which sorts correctly because FPL writes them
 * as "2025/26".
 */
export function mostRecentRates(
  seasons: SeasonTotals[],
): PriorSeasonRates | null {
  const ordered = [...seasons].sort((a, b) =>
    b.seasonName.localeCompare(a.seasonName),
  );

  for (const season of ordered) {
    const rates = ratesFromSeason(season);
    if (rates !== null) return rates;
  }
  return null;
}

/**
 * How much a player actually PLAYED last season.
 *
 * Separate from `ratesFromSeason`, and deliberately not gated the same way.
 *
 * Rates are gated at PRIOR_SEASON_MIN_MINUTES because a per-90 figure from a
 * few appearances is one match's noise multiplied up. A start RATE is not
 * noisy in that way — a player with three hundred minutes genuinely did not
 * start much, and that is exactly the fact worth knowing. Gating it would
 * throw away the signal for the players it most distinguishes.
 *
 * WHY THIS EXISTS AT ALL. The minutes model had no prior-season input, so
 * before a gameweek was played every available player fell back to a flat
 * NO_HISTORY_START_PRIOR — measured on a real squad, all fifteen came out at
 * 41 expected minutes and a 43% chance of reaching sixty, a 3,000-minute
 * ever-present indistinguishable from a fringe squad player. That halves every
 * projection, because appearance points, clean sheets and attacking returns
 * all scale with minutes, and it is why a starting eleven projected 26 points
 * against a realistic 50.
 */
export interface PriorSeasonWorkload {
  /** Share of the season's matches started, 0 to 1. */
  startRate: number;
  /** Typical minutes in a match the player started. */
  minutesPerStart: number;
  /**
   * Share of matches entered as a substitute.
   *
   * Derived from the minutes that starts do not explain, rather than assumed.
   * The flat P_BENCH_CAMEO is a reasonable guess when nothing is known, and a
   * poor one here: applied to a player who started twice it produced a 33%
   * chance of appearing off the bench, when his own minutes say roughly half
   * that. The residual is the evidence, so it is used.
   */
  cameoRate: number;
}

/** Matches in a Premier League season — the denominator for a start rate. */
const SEASON_MATCHES = 38;

/** How long a substitute appearance tends to be, for converting minutes to outings. */
const TYPICAL_CAMEO_MINUTES = 20;

/** Bounds on minutes-per-start, so one odd season cannot produce nonsense. */
const MINUTES_PER_START_BOUNDS = { min: 45, max: 90 } as const;

export function workloadFromSeason(
  season: SeasonTotals,
): PriorSeasonWorkload | null {
  if (season.minutes <= 0) return null;

  // A player with minutes but no recorded starts came off the bench all
  // season. That is a real answer, not missing data.
  const startRate = Math.min(1, Math.max(0, season.starts / SEASON_MATCHES));

  const perStart =
    season.starts > 0 ? season.minutes / season.starts : MINUTES_PER_START_BOUNDS.min;
  const minutesPerStart = Math.min(
    MINUTES_PER_START_BOUNDS.max,
    Math.max(MINUTES_PER_START_BOUNDS.min, perStart),
  );

  // Whatever the starts do not account for was time off the bench. Divided by
  // a typical cameo, that is roughly how many substitute appearances he made.
  const cameoMinutes = Math.max(0, season.minutes - season.starts * minutesPerStart);
  const cameoRate = Math.min(
    1 - startRate,
    cameoMinutes / TYPICAL_CAMEO_MINUTES / SEASON_MATCHES,
  );

  return { startRate, minutesPerStart, cameoRate };
}

/**
 * Workload from the most recent season the player actually played.
 *
 * Most recent only, not an average: a player who broke into the side last year
 * is described by last year, and averaging in the two before it would hold him
 * down for reasons that have stopped being true.
 */
export function mostRecentWorkload(
  seasons: SeasonTotals[],
): PriorSeasonWorkload | null {
  const ordered = [...seasons].sort((a, b) =>
    b.seasonName.localeCompare(a.seasonName),
  );

  for (const season of ordered) {
    const workload = workloadFromSeason(season);
    if (workload !== null) return workload;
  }
  return null;
}
