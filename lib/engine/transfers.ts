import { HIT_BREAK_EVEN_EP, TRANSFER_HIT_COST } from "@/lib/rules";
import { optimiseSquad, type OptimiserOptions, type PlayerCandidate } from "./optimiser";
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
  /** Raw EP gain over the horizon, before any hit. */
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
  /** Marginal EP per £0.1m at this squad, from the LP dual. */
  marginalEpPerTenth: number;
}

export interface TransferSuggestion {
  options: TransferOption[];
  /** The best option after hits. May be the roll. */
  recommended: TransferOption;
  /** True when nothing cleared the hit threshold. */
  shouldRoll: boolean;
}

export interface SuggestTransfersInput {
  currentSquad: PlayerCandidate[];
  candidates: PlayerCandidate[];
  freeTransfers: number;
  /** Money in the bank, tenths. */
  bank: number;
  /** Highest number of changes to evaluate. Each one costs a solve. */
  maxTransfers?: number;
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
  const baselineEp = currentSquad.reduce((sum, p) => sum + p.ep, 0);

  for (let n = 0; n <= maxTransfers; n++) {
    // Pinning the scenario: requiring 15 − n of the current squad to survive
    // is exactly "at most n transfers". Without this every iteration solved
    // the identical unconstrained problem and was then filtered by whatever
    // count fell out, so most counts were never offered at all.
    const solved = optimiseSquad(pool, solver, {
      ...options,
      budget,
      retentionPool: currentSquad.map((p) => p.id),
      minRetained: currentSquad.length - n,
    });

    const fifteen = [...solved.starting, ...solved.bench];
    const chosen = new Set(fifteen.map((p) => p.id));
    const playersOut = currentSquad.filter((p) => !chosen.has(p.id));
    const playersIn = fifteen.filter((p) => !currentIds.has(p.id));

    // The floor is "at most n", so a scenario may return fewer changes than
    // asked when the extra transfer is not worth making. That is a correct
    // answer rather than a miss, and the duplicate is collapsed below.
    const epGain = solved.startingEp + solved.benchEp - baselineEp;
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
  const recommended = options_[0];

  return {
    options: options_,
    recommended,
    // Rolling wins when the best paid move fails to clear the hit it costs.
    shouldRoll: recommended.transfers === 0 || recommended.netGain <= 0,
  };
}

export { HIT_BREAK_EVEN_EP };
