import { toPlayerCandidate, type Candidate } from "@/lib/squad/candidates";
import { computeChipGains } from "@/lib/engine/chip-gains";
import { planChips, type ChipPlan } from "@/lib/engine/chips";
import type { LpSolver } from "@/lib/engine/lp";
import type { ChipWindow } from "@/lib/fpl/gameweek";
import type { ChipName } from "@/lib/rules";

/**
 * The chip plan for a squad — the one every screen and the shadow manager use.
 *
 * It exists because there used to be three copies. The chips screen, the
 * dashboard and the shadow each built gains and ran the planner themselves, and
 * the dashboard's copy scanned ONLY the current gameweek. Given one week, the
 * planner has nothing to compare against: that week is its own ordinary week,
 * nothing can beat it, and every positive chip is "play it now". So after the
 * planner stopped burning chips early, the dashboard went on telling people to
 * play a Free Hit in GW5 — and it never passed the chips already played either,
 * so it could recommend a spent wildcard.
 *
 * One function, called with the scan horizon and the chips already played, is
 * how the three stay the same answer.
 */
export function planChipsForSquad(input: {
  squad: Candidate[];
  pool: Candidate[];
  /** The gameweeks to scan — the CHIP_SCAN_HORIZON context's, not one week. */
  gameweeks: number[];
  /** Tenths: what a rebuild has to fit inside. */
  budget: number;
  windows: ChipWindow[];
  currentGw: number;
  played: { chip: ChipName; set: number }[];
  priceDeltas: Map<number, number>;
  solver: LpSolver;
  /**
   * What each owned player is worth to a rebuild. Defaults to his current
   * price; the shadow manager passes selling prices.
   */
  squadPrice?: (candidate: Candidate) => number;
}): ChipPlan {
  // Refused loudly rather than planned quietly: a one-week scan is precisely
  // the bug this function replaced, and it produces a confident, wrong answer.
  // A single week is legitimate only when every window ends inside it.
  if (
    input.gameweeks.length === 1 &&
    input.windows.some((w) => w.stopEvent > input.gameweeks[0])
  ) {
    throw new Error(
      "A chip plan needs the scan horizon, not one gameweek: with nothing to compare against, every chip reads as worth playing now",
    );
  }

  const priceOf = (id: number) => input.priceDeltas.get(id) ?? 0;
  const withGameweeks = (c: Candidate, price = c.price) => ({
    ...toPlayerCandidate(c, priceOf(c.id)),
    price,
    epByGameweek: new Map(c.perGameweek.map((g) => [g.gw, g.ep])),
  });

  const gains = computeChipGains({
    squad: input.squad.map((c) => withGameweeks(c, input.squadPrice?.(c) ?? c.price)),
    pool: input.pool.map((c) => withGameweeks(c)),
    gameweeks: input.gameweeks,
    budget: input.budget,
    windows: input.windows,
    currentGw: input.currentGw,
    solver: input.solver,
  });

  return planChips({
    windows: input.windows,
    gains,
    alreadyPlayed: input.played,
    currentGw: input.currentGw,
    solver: input.solver,
  });
}
