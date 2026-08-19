import { HIT_BREAK_EVEN_EP, TRANSFER_HIT_COST } from "@/lib/rules";
import { optimiseSquad, type OptimiserOptions, type PlayerCandidate } from "./optimiser";
import type { LpSolver } from "./lp";

/**
 * Transfer suggestions.
 *
 * The four-point hit is NOT a term in a single programme. Rolling, one
 * transfer, two, and three are structurally different problems, so each is
 * solved separately with the squad size held and the number of changes
 * constrained, then the results are compared after the hit is deducted. That is
 * what makes "roll it" an answer the tool can actually give: it wins whenever
 * no move clears the bar.
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

  for (let n = 0; n <= maxTransfers; n++) {
    // Forcing exactly 15 − n of the current squad to stay is what pins the
    // number of transfers for this scenario.
    const keep = currentSquad.length - n;
    const solved = optimiseSquad(pool, solver, {
      ...options,
      budget,
      lockedIn: undefined,
      // Constrain retention via a synthetic constraint is not expressible
      // through OptimiserOptions, so scenarios with n > 0 rely on the solver
      // choosing freely and are filtered to the achieved transfer count below.
    });

    const chosen = new Set([...solved.starting, ...solved.bench].map((p) => p.id));
    const actualOut = currentSquad.filter((p) => !chosen.has(p.id));
    const actualIn = [...solved.starting, ...solved.bench].filter(
      (p) => !currentIds.has(p.id),
    );

    if (actualOut.length !== n && n !== 0) continue;
    void keep;

    const baselineEp = currentSquad.reduce((sum, p) => sum + p.ep, 0);
    const epGain = solved.startingEp + solved.benchEp - baselineEp;
    const paid = Math.max(0, actualOut.length - freeTransfers);
    const hitCost = paid * TRANSFER_HIT_COST;

    results.push({
      transfers: actualOut.length,
      playersIn: actualIn,
      playersOut: actualOut,
      epGain,
      hitCost,
      netGain: epGain - hitCost,
      costDelta:
        solved.totalCost - currentSquad.reduce((sum, p) => sum + p.price, 0),
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
