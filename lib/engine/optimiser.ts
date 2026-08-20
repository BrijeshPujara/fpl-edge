import {
  BENCH_WEIGHT_BENCH_BOOST,
  BENCH_WEIGHT_INACTIVE,
  BENCH_RULE_INCLUDES_GK,
  DEFAULT_HORIZON,
  MIN_BENCH_PLAYING_PROB,
  MIN_NAILED_BENCH_OUTFIELD,
  PRICE_WEIGHT_DEFAULT,
} from "./constants";
import type { LpConstraint, LpProblem, LpSolver } from "./lp";
import {
  FORMATION_BOUNDS,
  MAX_PLAYERS_PER_CLUB,
  POSITION,
  SQUAD_BUDGET,
  SQUAD_COMPOSITION,
  SQUAD_SIZE,
  STARTING_XI_SIZE,
  type PositionId,
} from "@/lib/rules";

/**
 * Squad optimisation as a mixed-integer linear programme.
 *
 * Pure: the solver is injected, and everything else is passed in. Expected
 * points are an INPUT — this module never computes them, which is what lets it
 * be built and tested before the EP model exists.
 *
 * TWO SOLVES, NOT ONE.
 *
 *   1. The MIP, with x and s binary, gives the actual squad.
 *   2. The LP relaxation, with x and s in [0,1], gives the dual on the budget
 *      constraint — the marginal expected points per £0.1m.
 *
 * A mixed-integer programme has no duals; duality is LP theory. So the shadow
 * price genuinely requires the second solve, and it is an approximation of the
 * integer marginal, which is really a step function: an extra £0.1m buys
 * nothing at all until it crosses a threshold and then buys a whole upgrade.
 * Degenerate optima also make the dual non-unique. Treat `marginalEpPerTenth`
 * as a good local estimate of what money is worth, not a promise.
 */

export interface PlayerCandidate {
  id: number;
  position: PositionId;
  teamId: number;
  /** Tenths of a million. */
  price: number;
  /** Expected points over the horizon. Computed elsewhere and passed in. */
  ep: number;
  /** Probability of playing. Drives the nailed-bench constraint. */
  pMinutes: number;
  /**
   * Expected price movement over the horizon in tenths, already adjusted for
   * the sell-on fee — `realisableDelta` from the price model.
   */
  expectedPriceDelta?: number;
}

export interface OptimiserOptions {
  budget?: number;
  horizon?: number;
  benchBoost?: boolean;
  /**
   * Points per tenth of expected price movement. A number uses it directly;
   * "auto" runs the LP relaxation first, reads the budget dual, and re-solves
   * with priceWeight set to it.
   *
   * "auto" exists because the principled value of this weight IS the shadow
   * price — money in the squad is worth exactly what the budget constraint says
   * it is worth. But the shadow price comes from a solve that needs the weight,
   * so the two are circular. Measuring first and re-solving once breaks the
   * cycle and terminates; it does not iterate to a fixed point, which in
   * practice moves the answer very little.
   */
  priceWeight?: number | "auto";
  /** Players who must be in the squad, e.g. when evaluating a partial rebuild. */
  lockedIn?: number[];
  /** Players who must not be selected. */
  excluded?: number[];
  /**
   * Force at least `minRetained` of `retentionPool` into the fifteen.
   *
   * This is how a transfer count is pinned. `suggestTransfers` needs to ask
   * "what is the best squad reachable with exactly two changes?", and the only
   * way to express that is a floor on how many of the current fifteen survive:
   * retaining 13 of 15 means two transfers.
   *
   * A floor rather than an equality, deliberately. The optimiser will never
   * make a transfer that does not help, so the floor binds from below and the
   * achieved count is whatever is genuinely best at or under the cap. Forcing
   * equality would make it burn a transfer it does not want, and the caller
   * asked for "at most n", not "exactly n".
   */
  retentionPool?: number[];
  minRetained?: number;
  /**
   * Whether to measure the budget shadow price. Defaults to true.
   *
   * It costs a whole second solve — a mixed-integer programme has no usable
   * duals, so the relaxation has to be solved separately — and callers that
   * only want the squad pay double for a number they discard. The chip planner
   * runs dozens of solves per render and needs none of them.
   *
   * When false, `marginalEpPerTenth` is 0. Read `shadowPriceMeasured` before
   * showing it, or you will present "money is worth nothing here" as a finding.
   */
  shadowPrice?: boolean;
}

export interface OptimisedSquad {
  starting: PlayerCandidate[];
  bench: PlayerCandidate[];
  /** Sum of EP over the XI, plus the bench at its weight. */
  objectiveValue: number;
  /** Sum of raw EP over the starting XI only. */
  startingEp: number;
  benchEp: number;
  totalCost: number;
  /** Sum of realisable expected price movement across the fifteen, in tenths. */
  expectedPriceDelta: number;
  /**
   * Marginal expected points per additional £0.1m of budget, from the dual on
   * the budget constraint in the LP relaxation. Non-negative, and falls toward
   * zero as budget stops binding.
   */
  marginalEpPerTenth: number;
  /**
   * False when `shadowPrice: false` skipped the relaxation. `marginalEpPerTenth`
   * is then 0 because it was never measured, not because money is worthless.
   */
  shadowPriceMeasured: boolean;
  /** The price weight actually applied, after resolving "auto". */
  priceWeightUsed: number;
}

export class InfeasibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InfeasibleError";
  }
}

const inSquad = (id: number) => `x_${id}`;
const inXi = (id: number) => `s_${id}`;
const BUDGET_CONSTRAINT = "budget";

interface BuildOptions {
  benchWeight: number;
  priceWeight: number;
  budget: number;
  lockedIn: Set<number>;
  excluded: Set<number>;
  retentionPool: Set<number>;
  minRetained: number | null;
}

/**
 * Build the programme.
 *
 * Variables: x_i = player i is in the fifteen, s_i = player i starts.
 * Bench membership is x_i − s_i, which keeps everything linear.
 */
function buildProblem(
  players: PlayerCandidate[],
  opts: BuildOptions,
  relaxed: boolean,
): LpProblem {
  const objective: Record<string, number> = {};
  const constraints: LpConstraint[] = [];

  for (const p of players) {
    const priceTerm = opts.priceWeight * (p.expectedPriceDelta ?? 0);
    // A squad place earns the bench weight on EP plus the full price term;
    // starting earns the remaining EP. The two coefficients sum to the full EP
    // for a starter, and to the bench-weighted EP for a bench player.
    objective[inSquad(p.id)] = opts.benchWeight * p.ep + priceTerm;
    objective[inXi(p.id)] = (1 - opts.benchWeight) * p.ep;
  }

  // Squad size.
  constraints.push({
    name: "squad_size",
    coefficients: Object.fromEntries(players.map((p) => [inSquad(p.id), 1])),
    type: "=",
    rhs: SQUAD_SIZE,
  });

  // Starting XI size.
  constraints.push({
    name: "xi_size",
    coefficients: Object.fromEntries(players.map((p) => [inXi(p.id), 1])),
    type: "=",
    rhs: STARTING_XI_SIZE,
  });

  // Cannot start a player who is not in the squad: s_i − x_i ≤ 0.
  for (const p of players) {
    constraints.push({
      name: `link_${p.id}`,
      coefficients: { [inXi(p.id)]: 1, [inSquad(p.id)]: -1 },
      type: "<=",
      rhs: 0,
    });
  }

  // Budget. The dual on THIS constraint is the shadow price we extract.
  constraints.push({
    name: BUDGET_CONSTRAINT,
    coefficients: Object.fromEntries(
      players.map((p) => [inSquad(p.id), p.price]),
    ),
    type: "<=",
    rhs: opts.budget,
  });

  // Exact squad composition per position.
  for (const position of Object.values(POSITION)) {
    const members = players.filter((p) => p.position === position);
    constraints.push({
      name: `squad_pos_${position}`,
      coefficients: Object.fromEntries(members.map((p) => [inSquad(p.id), 1])),
      type: "=",
      rhs: SQUAD_COMPOSITION[position],
    });

    const bounds = FORMATION_BOUNDS[position];
    constraints.push({
      name: `xi_pos_min_${position}`,
      coefficients: Object.fromEntries(members.map((p) => [inXi(p.id), 1])),
      type: ">=",
      rhs: bounds.min,
    });
    constraints.push({
      name: `xi_pos_max_${position}`,
      coefficients: Object.fromEntries(members.map((p) => [inXi(p.id), 1])),
      type: "<=",
      rhs: bounds.max,
    });
  }

  // Max three players per club.
  const teams = [...new Set(players.map((p) => p.teamId))];
  for (const teamId of teams) {
    constraints.push({
      name: `club_${teamId}`,
      coefficients: Object.fromEntries(
        players
          .filter((p) => p.teamId === teamId)
          .map((p) => [inSquad(p.id), 1]),
      ),
      type: "<=",
      rhs: MAX_PLAYERS_PER_CLUB,
    });
  }

  // The nailed-bench floor: enough bench players must be genuine cover.
  //
  // Bench membership is x_i − s_i, so summing that over players who clear the
  // playing-probability threshold and requiring a floor is linear. The
  // goalkeeper slot is excluded by default — see MIN_NAILED_BENCH_OUTFIELD for
  // why counting it would defeat the constraint's own purpose.
  const nailedPool = players.filter(
    (p) =>
      p.pMinutes >= MIN_BENCH_PLAYING_PROB &&
      (BENCH_RULE_INCLUDES_GK || p.position !== POSITION.GK),
  );
  if (nailedPool.length > 0) {
    const coefficients: Record<string, number> = {};
    for (const p of nailedPool) {
      coefficients[inSquad(p.id)] = 1;
      coefficients[inXi(p.id)] = -1;
    }
    constraints.push({
      name: "nailed_bench",
      coefficients,
      type: ">=",
      rhs: MIN_NAILED_BENCH_OUTFIELD,
    });
  }

  // Cardinality: at least `minRetained` of the current squad must survive.
  //
  // Summing x_i over the retention pool and putting a floor under it is the
  // whole mechanism, and it is what lets suggestTransfers ask for a specific
  // number of changes instead of solving freely and reporting whatever count
  // happened to come out.
  //
  // Skipped when the pool is empty: a floor over no variables is either
  // vacuous (rhs <= 0) or instantly infeasible, and neither is what a caller
  // who passed no pool meant.
  if (opts.minRetained !== null && opts.retentionPool.size > 0) {
    const members = players.filter((p) => opts.retentionPool.has(p.id));
    constraints.push({
      name: "retention",
      coefficients: Object.fromEntries(members.map((p) => [inSquad(p.id), 1])),
      type: ">=",
      // Cannot retain more of the pool than the pool has members present in
      // the candidate list — a player who has left the game is not retainable,
      // and demanding it would report infeasible for the wrong reason.
      rhs: Math.min(opts.minRetained, members.length),
    });
  }

  for (const id of opts.lockedIn) {
    constraints.push({
      name: `lock_${id}`,
      coefficients: { [inSquad(id)]: 1 },
      type: "=",
      rhs: 1,
    });
  }
  for (const id of opts.excluded) {
    constraints.push({
      name: `excl_${id}`,
      coefficients: { [inSquad(id)]: 1 },
      type: "=",
      rhs: 0,
    });
  }

  const variables = players.flatMap((p) => [inSquad(p.id), inXi(p.id)]);

  return {
    direction: "max",
    objective,
    constraints,
    binaries: relaxed ? [] : variables,
    bounds: relaxed
      ? Object.fromEntries(variables.map((v) => [v, { lb: 0, ub: 1 }]))
      : undefined,
  };
}

/**
 * Solve for the best fifteen and the best XI within it.
 */
export function optimiseSquad(
  players: PlayerCandidate[],
  solver: LpSolver,
  options: OptimiserOptions = {},
): OptimisedSquad {
  const budget = options.budget ?? SQUAD_BUDGET;
  const benchWeight = options.benchBoost
    ? BENCH_WEIGHT_BENCH_BOOST
    : BENCH_WEIGHT_INACTIVE;
  const lockedIn = new Set(options.lockedIn ?? []);
  const excluded = new Set(options.excluded ?? []);

  const base = {
    benchWeight,
    budget,
    lockedIn,
    excluded,
    retentionPool: new Set(options.retentionPool ?? []),
    minRetained: options.minRetained ?? null,
  };

  // Resolve the price weight. "auto" measures the shadow price first, which is
  // the only non-arbitrary value it can take.
  let priceWeight =
    typeof options.priceWeight === "number"
      ? options.priceWeight
      : PRICE_WEIGHT_DEFAULT;

  if (options.priceWeight === "auto") {
    const probe = solver.solve(
      buildProblem(players, { ...base, priceWeight: 0 }, true),
    );
    priceWeight = Math.max(0, probe.duals?.[BUDGET_CONSTRAINT] ?? 0);
  }

  const build = { ...base, priceWeight };

  const mip = solver.solve(buildProblem(players, build, false));
  if (mip.status !== "optimal") {
    throw new InfeasibleError(
      `No feasible squad under a budget of ${budget} tenths with ` +
        `${players.length} candidates (solver status: ${mip.status}). The ` +
        `nailed-bench floor and the max-three-per-club rule are the usual ` +
        `causes when the candidate pool is small` +
        (base.minRetained === null
          ? "."
          : `, and a retention floor of ${base.minRetained} narrows it ` +
            `further — a squad that must keep that many existing players may ` +
            `not fit the budget once prices have moved.`),
    );
  }

  // Second solve purely for the dual. Same programme, integrality dropped.
  const wantShadowPrice = options.shadowPrice ?? true;
  const relaxation = wantShadowPrice
    ? solver.solve(buildProblem(players, build, true))
    : null;
  const marginalEpPerTenth =
    relaxation === null
      ? 0
      : Math.max(0, relaxation.duals?.[BUDGET_CONSTRAINT] ?? 0);

  const chosen = players.filter((p) => (mip.variables[inSquad(p.id)] ?? 0) > 0.5);
  const starting = chosen.filter((p) => (mip.variables[inXi(p.id)] ?? 0) > 0.5);
  const startingIds = new Set(starting.map((p) => p.id));
  const bench = chosen.filter((p) => !startingIds.has(p.id));

  const startingEp = starting.reduce((sum, p) => sum + p.ep, 0);
  const benchEp = bench.reduce((sum, p) => sum + p.ep, 0);

  return {
    starting: [...starting].sort((a, b) => a.position - b.position || b.ep - a.ep),
    // Bench order matters: best first, since that is the first to auto-sub in.
    bench: [...bench].sort((a, b) => a.position - b.position || b.ep - a.ep),
    objectiveValue: mip.objectiveValue,
    startingEp,
    benchEp,
    totalCost: chosen.reduce((sum, p) => sum + p.price, 0),
    expectedPriceDelta: chosen.reduce(
      (sum, p) => sum + (p.expectedPriceDelta ?? 0),
      0,
    ),
    marginalEpPerTenth,
    shadowPriceMeasured: wantShadowPrice,
    priceWeightUsed: priceWeight,
  };
}

export { DEFAULT_HORIZON };
