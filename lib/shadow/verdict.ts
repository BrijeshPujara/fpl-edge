/**
 * Is the shadow ahead of the manager, and by more than luck?
 *
 * Both squads play the same gameweeks, so the comparison is PAIRED: the thing
 * to measure is the per-week gap, not the two totals. Pairing is what makes
 * this instrument usable at all — the two squads share most of their players
 * and nearly all of their fixtures, so the gap varies far less than either
 * score does. The squad backtest measured the same effect: unpaired sd ~16 a
 * week, paired sd ~6.
 *
 * Pure.
 */

export interface ShadowWeekResult {
  gw: number;
  /** Shadow points after its hit. */
  shadow: number;
  /** Manager points after their hit. */
  manager: number;
}

export interface ShadowVerdictWeek extends ShadowWeekResult {
  /** Shadow minus manager this week. */
  gap: number;
  /** Running total of `gap`. */
  cumulative: number;
  /**
   * Half-width of the band a cumulative gap this many weeks in would stay
   * inside, roughly 95% of the time, if the engine had NO edge: two standard
   * deviations of a sum of k weekly gaps, 2·sd·√k. A line wandering inside it
   * is what luck looks like. Null until the spread can be estimated.
   */
  band: number | null;
}

export type ShadowReading =
  | "no-data"
  | "too-few"
  | "noise"
  | "engine-ahead"
  | "manager-ahead";

export interface ShadowVerdict {
  weeks: ShadowVerdictWeek[];
  shadowTotal: number;
  managerTotal: number;
  /** shadowTotal − managerTotal. */
  gap: number;
  meanGap: number | null;
  /** Standard error of the mean weekly gap. */
  standardError: number | null;
  t: number | null;
  reading: ShadowReading;
}

/**
 * The weeks both sides have a final score for, each net of its hits.
 *
 * Only scored ENGINE weeks: the seed belongs to both sides and cannot separate
 * them, and an unscored week has no number. The manager's FPL `points` is
 * provisional while a gameweek is live, but a shadow week is scored only after
 * FPL checks the results, so by the time a week pairs, both numbers are final.
 */
export function pairWeeks(
  shadow: { gw: number; origin: string; points: number | null; hitCost: number }[],
  manager: { event: number; points: number; event_transfers_cost: number }[],
): ShadowWeekResult[] {
  const managerNet = new Map(
    manager.map((m) => [m.event, m.points - m.event_transfers_cost]),
  );
  return shadow.flatMap((week) =>
    week.origin === "engine" && week.points !== null && managerNet.has(week.gw)
      ? [
          {
            gw: week.gw,
            shadow: week.points - week.hitCost,
            manager: managerNet.get(week.gw)!,
          },
        ]
      : [],
  );
}

/** The same bar the journal and both backtests use. */
const T_THRESHOLD = 2;

export function shadowVerdict(results: ShadowWeekResult[]): ShadowVerdict {
  const sorted = [...results].sort((a, b) => a.gw - b.gw);
  const gaps = sorted.map((r) => r.shadow - r.manager);
  const n = gaps.length;

  const shadowTotal = sorted.reduce((sum, r) => sum + r.shadow, 0);
  const managerTotal = sorted.reduce((sum, r) => sum + r.manager, 0);
  const gap = shadowTotal - managerTotal;

  const meanGap = n > 0 ? gap / n : null;
  const sd =
    n > 1
      ? Math.sqrt(gaps.reduce((s, g) => s + (g - meanGap!) ** 2, 0) / (n - 1))
      : null;
  const standardError = sd === null ? null : sd / Math.sqrt(n);
  // A zero spread over two or more weeks has no finite t. Left null rather than
  // reported as infinite certainty: two identical gaps is a coincidence far
  // more often than it is a law.
  const t =
    standardError !== null && standardError > 0 ? meanGap! / standardError : null;

  let running = 0;
  const weeks = sorted.map((r, i) => {
    running += gaps[i];
    return {
      ...r,
      gap: gaps[i],
      cumulative: running,
      band: sd === null ? null : 2 * sd * Math.sqrt(i + 1),
    };
  });

  const reading: ShadowReading =
    n === 0
      ? "no-data"
      : n < 2
        ? "too-few"
        : t === null || Math.abs(t) < T_THRESHOLD
          ? "noise"
          : t > 0
            ? "engine-ahead"
            : "manager-ahead";

  return {
    weeks,
    shadowTotal,
    managerTotal,
    gap,
    meanGap,
    standardError,
    t,
    reading,
  };
}
