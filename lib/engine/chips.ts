import {
  CAPTAIN_MULTIPLIER,
  CHIP_LABEL,
  MAX_CHIPS_PER_GW,
  TRIPLE_CAPTAIN_MULTIPLIER,
  type ChipName,
} from "@/lib/rules";
import type { ChipWindow } from "@/lib/fpl/gameweek";
import type { LpProblem, LpSolver } from "./lp";

/**
 * Chip timing as an assignment problem.
 *
 * PLAN.md section 7 specified rules-based triggers with thresholds — "fire
 * Triple Captain above 8.5 EP". That is a guess dressed as a rule, and it
 * cannot answer the only question that actually matters:
 *
 *     is this week good enough, or is a better one coming before the window
 *     closes?
 *
 * A threshold has no idea. It fires on the first week that clears the bar, even
 * when a double gameweek four weeks out would have paid twice as much, and it
 * never fires at all in a season where nothing clears the bar — leaving the
 * chip to expire unused, which is strictly the worst outcome available.
 *
 * The question is exactly a bipartite assignment: chips on one side, gameweeks
 * on the other, a gain on each edge that exists, and a matching to maximise.
 * The solver already in the repo does it, and the constraint matrix is an
 * assignment polytope — totally unimodular — so the relaxation is integral and
 * the answer is genuinely optimal rather than a good-enough heuristic.
 *
 * WHAT THIS DOES NOT MODEL. Gains are taken as independent across chips, and
 * they are not: playing a Wildcard in one gameweek changes the squad, and
 * therefore changes what a Bench Boost is worth the week after. That
 * interaction is the transfer-path MILP's job (docs/next-steps.md), and
 * pretending to solve it here would be worse than saying so. Callers who care
 * can price the interaction into the gains they pass in.
 */

export interface ChipGain {
  chip: ChipName;
  /** Which set the chip belongs to. Sets are separate, single-use instances. */
  set: number;
  gw: number;
  /**
   * Expected points gained by playing this chip in this gameweek, relative to
   * not playing it. Bench Boost is the bench's EP; Triple Captain the captain's
   * extra multiple; Free Hit the one-week squad improvement; Wildcard the
   * horizon improvement from rebuilding.
   *
   * May be negative — a Free Hit into a bad week is a real possibility — and a
   * negative gain is simply never assigned.
   */
  gain: number;
  /**
   * Optional 0-1 multiplier for how much the projection is trusted. A double
   * gameweek fifteen weeks out is a real opportunity but a soft number, and
   * this is where that belongs rather than smuggled into `gain`.
   */
  confidence?: number;
}

export interface ChipAssignment {
  chip: ChipName;
  label: string;
  set: number;
  gw: number;
  /** The raw gain as supplied. */
  gain: number;
  /** After the confidence multiplier — what the solver actually maximised. */
  adjustedGain: number;
  /**
   * The best gameweek this chip could move to instead, and how much worse that
   * would be.
   *
   * Restricted to gameweeks no OTHER chip in the plan is using, which is the
   * whole subtlety. Comparing against the unconstrained best week produces a
   * negative margin whenever another chip won that week — "3.6 points worse
   * than a gameweek you cannot have" is not an answer to any question a user
   * is asking. Against genuinely available weeks the margin is non-negative by
   * optimality: if moving there gained anything, the plan would have done it.
   *
   * Null when the chip has nowhere else to go. A wide margin means play it
   * here with confidence; a margin near zero means the call is close and worth
   * revisiting next week.
   */
  nextBestGw: number | null;
  marginOverNextBest: number | null;
  /** Gameweeks left before this chip's window closes, inclusive of `gw`. */
  gameweeksUntilExpiry: number;
}

export type UnassignedReason =
  | "already-played"
  | "window-closed"
  | "no-projections"
  | "no-positive-gain"
  | "gameweek-taken";

export interface UnassignedChip {
  chip: ChipName;
  label: string;
  set: number;
  reason: UnassignedReason;
}

export interface ChipPlan {
  assignments: ChipAssignment[];
  unassigned: UnassignedChip[];
  /** Sum of adjusted gains across the plan. */
  totalGain: number;
}

export interface ChipPlanOptions {
  windows: ChipWindow[];
  gains: ChipGain[];
  /** Chips already used this season. Sets matter: set 1 gone leaves set 2. */
  alreadyPlayed?: { chip: ChipName; set: number }[];
  /** The earliest gameweek still decidable. Earlier ones are history. */
  currentGw: number;
  solver: LpSolver;
}

const key = (chip: ChipName, set: number) => `${chip}#${set}`;

/** Variable name for "play this chip instance in this gameweek". */
const playVar = (chip: ChipName, set: number, gw: number) =>
  `y_${chip}_${set}_${gw}`;

export function planChips(options: ChipPlanOptions): ChipPlan {
  const { windows, gains, currentGw, solver } = options;
  const played = new Set(
    (options.alreadyPlayed ?? []).map((p) => key(p.chip, p.set)),
  );

  // Index gains by chip instance and gameweek. Later entries win, so a caller
  // that refreshes one gameweek's projection does not have to filter the old
  // one out first.
  const gainAt = new Map<string, Map<number, ChipGain>>();
  for (const g of gains) {
    const k = key(g.chip, g.set);
    const byGw = gainAt.get(k) ?? new Map<number, ChipGain>();
    byGw.set(g.gw, g);
    gainAt.set(k, byGw);
  }

  const adjusted = (g: ChipGain) => g.gain * (g.confidence ?? 1);

  // Build the edge set, recording why each chip instance has no edges when it
  // has none. A chip that silently vanishes from the plan is indistinguishable
  // from a chip the model decided not to play, and those mean opposite things.
  interface Edge {
    window: ChipWindow;
    gw: number;
    gain: number;
    adjustedGain: number;
  }
  const edges: Edge[] = [];
  const unassigned: UnassignedChip[] = [];

  const reject = (window: ChipWindow, reason: UnassignedReason) =>
    unassigned.push({
      chip: window.name,
      label: CHIP_LABEL[window.name],
      set: window.set,
      reason,
    });

  for (const window of windows) {
    const k = key(window.name, window.set);

    if (played.has(k)) {
      reject(window, "already-played");
      continue;
    }
    if (window.stopEvent < currentGw) {
      reject(window, "window-closed");
      continue;
    }

    const byGw = gainAt.get(k);
    // Only gameweeks that are inside the window AND still ahead of us.
    const from = Math.max(window.startEvent, currentGw);
    const candidates: Edge[] = [];
    for (let gw = from; gw <= window.stopEvent; gw++) {
      const g = byGw?.get(gw);
      if (g === undefined) continue;
      candidates.push({
        window,
        gw,
        gain: g.gain,
        adjustedGain: adjusted(g),
      });
    }

    if (candidates.length === 0) {
      reject(window, "no-projections");
      continue;
    }
    // A chip is never worth playing for a negative gain, and dropping those
    // edges keeps them from being chosen to fill an otherwise idle gameweek.
    const positive = candidates.filter((c) => c.adjustedGain > 0);
    if (positive.length === 0) {
      reject(window, "no-positive-gain");
      continue;
    }
    edges.push(...positive);
  }

  if (edges.length === 0) {
    return { assignments: [], unassigned, totalGain: 0 };
  }

  // --- The programme ------------------------------------------------------

  const objective: Record<string, number> = {};
  const byChip = new Map<string, string[]>();
  const byGw = new Map<number, string[]>();

  for (const edge of edges) {
    const name = playVar(edge.window.name, edge.window.set, edge.gw);
    objective[name] = edge.adjustedGain;

    const k = key(edge.window.name, edge.window.set);
    byChip.set(k, [...(byChip.get(k) ?? []), name]);
    byGw.set(edge.gw, [...(byGw.get(edge.gw) ?? []), name]);
  }

  const problem: LpProblem = {
    direction: "max",
    objective,
    binaries: Object.keys(objective),
    constraints: [
      // Each chip instance is played at most once. "At most" and not "exactly":
      // a chip whose every window gameweek is a poor bet is better held, and
      // forcing an assignment would manufacture a recommendation to waste it.
      ...[...byChip.entries()].map(([k, vars]) => ({
        name: `chip_${k}`,
        coefficients: Object.fromEntries(vars.map((v) => [v, 1])),
        type: "<=" as const,
        rhs: 1,
      })),
      // One chip per gameweek — the actual FPL rule, and the constraint that
      // makes this an assignment problem rather than four independent choices.
      // Without it two chips both pile into the same juicy double gameweek.
      ...[...byGw.entries()].map(([gw, vars]) => ({
        name: `gw_${gw}`,
        coefficients: Object.fromEntries(vars.map((v) => [v, 1])),
        type: "<=" as const,
        rhs: MAX_CHIPS_PER_GW,
      })),
    ],
  };

  const solution = solver.solve(problem);
  if (solution.status !== "optimal") {
    // Infeasible is impossible here — the empty assignment always satisfies
    // every constraint — so this means the solver failed, and reporting an
    // empty plan as though it were an answer would hide that.
    throw new Error(`Chip assignment did not solve: ${solution.status}`);
  }

  // --- Read it back -------------------------------------------------------

  const assignments: ChipAssignment[] = [];
  const chosen = new Set<string>();

  const playedEdges = edges.filter(
    (e) =>
      (solution.variables[playVar(e.window.name, e.window.set, e.gw)] ?? 0) >=
      0.5,
  );
  const occupied = new Map(
    playedEdges.map((e) => [e.gw, key(e.window.name, e.window.set)]),
  );

  for (const edge of playedEdges) {
    const k = key(edge.window.name, edge.window.set);
    chosen.add(k);

    // The counterfactual: where else could THIS chip go?
    //
    // Only gameweeks free of another chip count. A week already spoken for is
    // not an alternative, and measuring against one produces the nonsense of a
    // negative margin — the chip is "worse off" than a slot it was never able
    // to take. Restricted this way the margin is non-negative by optimality.
    const alternatives = edges
      .filter(
        (e) =>
          key(e.window.name, e.window.set) === k &&
          e.gw !== edge.gw &&
          (occupied.get(e.gw) ?? k) === k,
      )
      .sort((a, b) => b.adjustedGain - a.adjustedGain);
    const nextBest = alternatives[0];

    assignments.push({
      chip: edge.window.name,
      label: CHIP_LABEL[edge.window.name],
      set: edge.window.set,
      gw: edge.gw,
      gain: edge.gain,
      adjustedGain: edge.adjustedGain,
      nextBestGw: nextBest?.gw ?? null,
      marginOverNextBest:
        nextBest === undefined
          ? null
          : edge.adjustedGain - nextBest.adjustedGain,
      // Inclusive: at the final gameweek of a window the chip can still be
      // played this week, so one gameweek remains, not zero.
      gameweeksUntilExpiry: edge.window.stopEvent - edge.gw + 1,
    });
  }

  // A chip with viable edges that still went unplayed lost its gameweeks to
  // chips worth more in them. That is a real answer and a different one from
  // "no projections", so it gets its own reason.
  for (const k of byChip.keys()) {
    if (chosen.has(k)) continue;
    const edge = edges.find((e) => key(e.window.name, e.window.set) === k);
    if (edge === undefined) continue;
    reject(edge.window, "gameweek-taken");
  }

  assignments.sort((a, b) => a.gw - b.gw);

  return {
    assignments,
    unassigned,
    totalGain: assignments.reduce((sum, a) => sum + a.adjustedGain, 0),
  };
}

/**
 * Urgency, for the countdown PLAN.md section 7 asks the UI to surface.
 *
 * Rises as a window closes and falls away when the chip has a strong assignment
 * already booked: a Bench Boost with three gameweeks left and no plan is the
 * thing worth shouting about, not one with three gameweeks left and a good week
 * chosen.
 *
 * Returns 0-1. Callers decide what to do with it; this makes no claim about
 * where a banner should start appearing.
 */
export function chipUrgency(
  window: ChipWindow,
  currentGw: number,
  assigned: boolean,
): number {
  const remaining = window.stopEvent - currentGw + 1;
  if (remaining <= 0) return 0;
  if (assigned) return 0;

  const span = window.stopEvent - window.startEvent + 1;
  if (span <= 0) return 1;

  return Math.max(0, Math.min(1, 1 - (remaining - 1) / span));
}

// ---------------------------------------------------------------------------
// Gains
// ---------------------------------------------------------------------------

/**
 * Two of the four gains are unambiguous and computable from per-player EP
 * alone, so they live here. The other two are not:
 *
 *   Free Hit — needs an optimal one-week squad, which needs a candidate pool
 *              and a budget, which means the optimiser and therefore a solve
 *   Wildcard — same, over the whole remaining horizon
 *
 * Both are the caller's job, because both need inputs this module has no
 * business holding. `optimalFreeHit` and `optimalWildcard` in `optimiser.ts`
 * produce them; the difference against the current squad's EP is the gain.
 */

/**
 * Bench Boost: the bench scores, so the gain is simply the bench's EP.
 *
 * Note this is the bench as it will actually be — the four players who would
 * otherwise not have counted — and not the bench weighted as the optimiser
 * weights it. The optimiser discounts bench EP to near zero on purpose (a
 * bench is not worth paying for), but under Bench Boost every point is real.
 */
export function benchBoostGain(benchEp: number[]): number {
  return benchEp.reduce((sum, ep) => sum + ep, 0);
}

/**
 * Triple Captain: the gain is ONE further multiple of the captain's EP, not
 * three and not two.
 *
 * The armband is already paying double, so the chip buys the difference
 * between tripling and doubling — which is 1x, not 3x. Reading it as 3x
 * overstates the chip threefold and would have the model burning it on any
 * decent week. Written against the multiplier constants rather than a literal
 * so it stays right if the rule ever changes.
 */
export function tripleCaptainGain(captainEp: number): number {
  return captainEp * (TRIPLE_CAPTAIN_MULTIPLIER - CAPTAIN_MULTIPLIER);
}
