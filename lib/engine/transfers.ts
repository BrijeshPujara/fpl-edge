import { HIT_BREAK_EVEN_EP, TRANSFER_HIT_COST } from "@/lib/rules";
import {
  InfeasibleError,
  optimiseSquad,
  type OptimiserOptions,
  type PlayerCandidate,
} from "./optimiser";
import { bestXi } from "./best-xi";
import type { LpSolver } from "./lp";

/**
 * Transfer suggestions.
 *
 * The four-point hit is NOT a term in a single programme. Rolling, one
 * transfer, two, and three are structurally different problems, so each is
 * solved separately with the number of changes constrained, then the results
 * are compared after the hit is deducted. That is what makes "roll it" an
 * answer the tool can actually give: it wins whenever no move clears the bar.
 *
 * Each scenario is pinned by a retention floor — keep 15 − n of the current
 * fifteen — which is a real constraint in the programme rather than a filter
 * applied afterwards. It used to be the latter, and the difference matters: an
 * unconstrained solve returns one squad, and filtering four identical solves by
 * the transfer count that happened to come out means most counts were never
 * offered. A user who wanted to see the two-transfer option simply did not get
 * one.
 */

export interface TransferOption {
  /** How many players change. Zero is the roll. */
  transfers: number;
  playersIn: PlayerCandidate[];
  playersOut: PlayerCandidate[];
  /**
   * Gain in STARTING XI expected points over the horizon, before any hit.
   *
   * The starting eleven and not the fifteen, because only the eleven score.
   * Measuring the whole squad would credit a transfer for upgrading a bench
   * player who never plays, and the four-point hit it has to clear is charged
   * in real scoring points.
   */
  epGain: number;
  /** Points deducted for transfers beyond the free allowance. */
  hitCost: number;
  /** epGain − hitCost. The number that decides it. */
  netGain: number;
  /** Change in squad cost, in tenths. Negative frees money. */
  costDelta: number;
  /**
   * Net realisable price movement this option buys into, in tenths — already
   * adjusted for the sell-on fee.
   */
  expectedPriceDelta: number;
  /**
   * Marginal EP per £0.1m at this squad, from the LP dual.
   *
   * Null for the roll, which is computed without a solve and therefore has no
   * dual to read.
   */
  marginalEpPerTenth: number | null;
}

export interface TransferSuggestion {
  options: TransferOption[];
  /** The best option after hits. May be the roll. */
  recommended: TransferOption;
  /** True when nothing cleared the hit threshold. */
  shouldRoll: boolean;
  /**
   * The move that scored best but was not recommended, because it costs a hit
   * and minutes are not yet known. Null whenever nothing was held back.
   *
   * Kept rather than discarded so a screen can show the move and say why it is
   * not being advised. Hiding it would be a different kind of dishonesty.
   */
  withheld: TransferOption | null;
}

export interface SuggestTransfersInput {
  currentSquad: PlayerCandidate[];
  candidates: PlayerCandidate[];
  freeTransfers: number;
  /** Money in the bank, tenths. */
  bank: number;
  /** Highest number of changes to evaluate. Each one costs a solve. */
  maxTransfers?: number;
  /**
   * Whether the projections know who actually plays.
   *
   * False before any gameweek has been played, when rates come from last
   * season and every available player carries the same flat starting
   * probability. Defaults to true, so a caller that has not thought about it
   * gets the old behaviour rather than a silently weakened engine.
   *
   * WHY IT CHANGES THE RECOMMENDATION, and how that reason has since weakened.
   *
   * Originally the case was absolute: minutes were held constant across every
   * player, so the model could not tell a nailed starter from a squad player,
   * and "sell A, buy B" could be a statement about last season's per-90 rate
   * rather than about anything happening this season. It proposed selling
   * Virgil van Dijk for a cheaper player with better rates and paying eight
   * points for it.
   *
   * That defect is fixed — the minutes model now reads last season's workload,
   * so a 3,000-minute ever-present and a fringe player no longer look alike.
   * The guard stays anyway, for a smaller and more honest reason: last
   * season's role is not this season's. Summer transfers, a new manager and a
   * lost place are all invisible until real minutes arrive, and a hit is a
   * CERTAIN four points against a gain that still rests on how someone was
   * used a year ago.
   *
   * It lifts on its own once `basis` becomes "this-season". Free transfers are
   * unaffected throughout — a free move that turns out wrong costs nothing but
   * the move.
   */
  minutesKnown?: boolean;
}

export function suggestTransfers(
  input: SuggestTransfersInput,
  solver: LpSolver,
  options: OptimiserOptions = {},
): TransferSuggestion {
  const { currentSquad, candidates, freeTransfers, bank } = input;
  const maxTransfers = input.maxTransfers ?? 3;

  const currentIds = new Set(currentSquad.map((p) => p.id));
  const budget =
    currentSquad.reduce((sum, p) => sum + p.price, 0) + bank;

  // Pool must include the current squad so "keep" is always available.
  const pool = [
    ...currentSquad,
    ...candidates.filter((c) => !currentIds.has(c.id)),
  ];

  const results: TransferOption[] = [];
  const baselinePrice = currentSquad.reduce((sum, p) => sum + p.price, 0);

  // What the current squad is worth if nothing changes. Every option is
  // measured against this, so it has to be the same quantity the options
  // report: the best legal eleven, not the sum of the fifteen.
  const baseline = bestXi(currentSquad);

  // The roll needs no solve. Keeping all fifteen IS the current squad, so its
  // value is known exactly, and computing it directly rather than asking the
  // optimiser to rediscover it has a second benefit that matters more: it
  // cannot fail. A squad carrying two injured players can violate the
  // optimiser's nailed-bench floor, which would make "retain all fifteen"
  // infeasible and take the whole screen down with it — for the one option
  // that is always available in real life.
  results.push({
    transfers: 0,
    playersIn: [],
    playersOut: [],
    epGain: 0,
    hitCost: 0,
    netGain: 0,
    costDelta: 0,
    expectedPriceDelta: currentSquad.reduce(
      (sum, p) => sum + (p.expectedPriceDelta ?? 0),
      0,
    ),
    // No solve, so no dual. Null rather than zero: zero would claim money is
    // worth nothing at this squad, which is a strong and probably false claim.
    marginalEpPerTenth: null,
  });

  for (let n = 1; n <= maxTransfers; n++) {
    // Pinning the scenario: requiring 15 − n of the current squad to survive
    // is exactly "at most n transfers". Without this every iteration solved
    // the identical unconstrained problem and was then filtered by whatever
    // count fell out, so most counts were never offered at all.
    let solved;
    try {
      solved = optimiseSquad(pool, solver, {
        ...options,
        budget,
        retentionPool: currentSquad.map((p) => p.id),
        minRetained: currentSquad.length - n,
      });
    } catch (error) {
      // One scenario being infeasible is not the screen failing. A tight
      // budget or a flagged squad can make a given transfer count impossible
      // while others remain fine, so drop this one and keep the rest.
      if (error instanceof InfeasibleError) continue;
      throw error;
    }

    const fifteen = [...solved.starting, ...solved.bench];
    const chosen = new Set(fifteen.map((p) => p.id));
    const playersOut = currentSquad.filter((p) => !chosen.has(p.id));
    const playersIn = fifteen.filter((p) => !currentIds.has(p.id));

    // The floor is "at most n", so a scenario may return fewer changes than
    // asked when the extra transfer is not worth making. That is a correct
    // answer rather than a miss, and the duplicate is collapsed below.
    const epGain = solved.startingEp - baseline.startingEp;
    const paid = Math.max(0, playersOut.length - freeTransfers);
    const hitCost = paid * TRANSFER_HIT_COST;

    results.push({
      transfers: playersOut.length,
      playersIn,
      playersOut,
      epGain,
      hitCost,
      netGain: epGain - hitCost,
      costDelta: solved.totalCost - baselinePrice,
      expectedPriceDelta: solved.expectedPriceDelta,
      marginalEpPerTenth: solved.marginalEpPerTenth,
    });
  }

  // Deduplicate by transfer count, keeping the best of each.
  const byCount = new Map<number, TransferOption>();
  for (const option of results) {
    const existing = byCount.get(option.transfers);
    if (!existing || option.netGain > existing.netGain) {
      byCount.set(option.transfers, option);
    }
  }

  const options_ = [...byCount.values()].sort((a, b) => b.netGain - a.netGain);
  const best = options_[0];

  // Without minutes, decline to SPEND points on a projection that cannot tell
  // a starter from a squad player. The move is still returned for the screen
  // to show; it is just not what the engine advises.
  const minutesKnown = input.minutesKnown ?? true;
  const affordable = options_.filter((option) => option.hitCost === 0);
  const withhold = !minutesKnown && best.hitCost > 0;
  const recommended = withhold ? (affordable[0] ?? best) : best;

  return {
    options: options_,
    recommended,
    // Rolling wins when the best paid move fails to clear the hit it costs.
    shouldRoll: recommended.transfers === 0 || recommended.netGain <= 0,
    withheld: withhold ? best : null,
  };
}

export { HIT_BREAK_EVEN_EP };
