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
