import { CHIP, type ChipName } from "@/lib/rules";
import type { ChipWindow } from "@/lib/fpl/gameweek";
import { benchBoostGain, tripleCaptainGain, type ChipGain } from "./chips";
import { bestXi } from "./best-xi";
import {
  InfeasibleError,
  optimiseSquad,
  type PlayerCandidate,
} from "./optimiser";
import type { LpSolver } from "./lp";
import { CHIP_CONFIDENCE_FLOOR, CHIP_CONFIDENCE_HALF_LIFE } from "./constants";

/**
 * Computing what each chip is worth in each gameweek.
 *
 * `planChips` takes gains and schedules them; this is where the gains come
 * from. Two are arithmetic and two need a solve:
 *
 *   Bench Boost    the bench's EP that week
 *   Triple Captain one further multiple of the captain's EP
 *   Free Hit       best one-week squad − what your own squad does that week
 *   Wildcard       best rebuild over the rest of the horizon − your own squad
 *
 * Pure, with the solver injected, in keeping with the rest of `lib/engine/**`.
 */

export interface ChipCandidate extends PlayerCandidate {
  /** Undiscounted expected points, by gameweek. */
  epByGameweek: Map<number, number>;
}

export interface ChipGainInput {
  /** The fifteen currently owned. */
  squad: ChipCandidate[];
  /** Everyone buyable, including the current squad. */
  pool: ChipCandidate[];
  /** Gameweeks to evaluate, ascending. */
  gameweeks: number[];
  /** Squad value plus bank, in tenths — what a rebuild has to fit inside. */
  budget: number;
  windows: ChipWindow[];
  currentGw: number;
  solver: LpSolver;
}

/**
 * How much a projection that many gameweeks out is trusted.
 *
 * Halves every CHIP_CONFIDENCE_HALF_LIFE gameweeks, down to a floor. This is
 * the term that stops the planner chasing a speculative double gameweek fifteen
 * weeks away over a solid opportunity next month, without pretending distant
 * gameweeks do not exist at all — which is what a hard horizon cut-off does,
 * and it is worse, because the biggest chip weeks of a season are exactly the
 * far-off doubles.
 */
export function chipConfidence(gw: number, currentGw: number): number {
  const distance = Math.max(0, gw - currentGw);
  const decayed = Math.pow(0.5, distance / CHIP_CONFIDENCE_HALF_LIFE);
  return Math.max(CHIP_CONFIDENCE_FLOOR, decayed);
}

/** A squad re-scored for one gameweek. */
function at(squad: ChipCandidate[], gw: number): ChipCandidate[] {
  return squad.map((p) => ({ ...p, ep: p.epByGameweek.get(gw) ?? 0 }));
}

/** A squad re-scored over a span, undiscounted. */
function over(squad: ChipCandidate[], gameweeks: number[]): ChipCandidate[] {
  return squad.map((p) => ({
    ...p,
    ep: gameweeks.reduce((sum, gw) => sum + (p.epByGameweek.get(gw) ?? 0), 0),
  }));
}

function openIn(windows: ChipWindow[], chip: ChipName, gw: number): boolean {
  return windows.some(
    (w) => w.name === chip && gw >= w.startEvent && gw <= w.stopEvent,
  );
}

function setFor(windows: ChipWindow[], chip: ChipName, gw: number): number | null {
  const w = windows.find(
    (x) => x.name === chip && gw >= x.startEvent && gw <= x.stopEvent,
  );
  return w?.set ?? null;
}

export function computeChipGains(input: ChipGainInput): ChipGain[] {
  const { squad, pool, gameweeks, budget, windows, currentGw, solver } = input;
  const gains: ChipGain[] = [];

  const push = (chip: ChipName, gw: number, gain: number) => {
    const set = setFor(windows, chip, gw);
    if (set === null) return;
    gains.push({ chip, set, gw, gain, confidence: chipConfidence(gw, currentGw) });
  };

  for (const gw of gameweeks) {
    const squadThisWeek = at(squad, gw);
    const xi = bestXi(squadThisWeek);

    // --- Bench Boost: the four who would not have counted, now counting.
    if (openIn(windows, CHIP.benchBoost, gw)) {
      push(CHIP.benchBoost, gw, benchBoostGain(xi.bench.map((p) => p.ep)));
    }

    // --- Triple Captain: one further multiple of the captain's EP.
    if (openIn(windows, CHIP.tripleCaptain, gw) && xi.captain) {
      push(CHIP.tripleCaptain, gw, tripleCaptainGain(xi.captain.ep));
    }

    // --- Free Hit: the best one-week squad money can buy, for one week only.
    //
    // Bench weight stays at its default. A Free Hit squad's bench does not
    // score, so there is no reason to pay for it — the same logic as any other
    // week, which is why no bench-boost flag is set here.
    if (openIn(windows, CHIP.freeHit, gw)) {
      const rebuilt = solveQuietly(
        () =>
          optimiseSquad(at(pool, gw), solver, {
            budget,
            shadowPrice: false,
          }),
      );
      if (rebuilt) push(CHIP.freeHit, gw, rebuilt.startingEp - xi.startingEp);
    }

    // --- Wildcard: rebuild here and keep it for the rest of the horizon.
    //
    // Measured over the gameweeks REMAINING from gw, not over the whole span,
    // because a wildcard played in gameweek 12 cannot collect points from
    // gameweek 8. Playing it later therefore has fewer weeks to pay it back,
    // which is the pressure that makes wildcard timing a real decision.
    if (openIn(windows, CHIP.wildcard, gw)) {
      const remaining = gameweeks.filter((g) => g >= gw);
      const rebuilt = solveQuietly(
        () =>
          optimiseSquad(over(pool, remaining), solver, {
            budget,
            shadowPrice: false,
          }),
      );
      if (rebuilt) {
        const held = bestXi(over(squad, remaining));
        push(CHIP.wildcard, gw, rebuilt.startingEp - held.startingEp);
      }
    }
  }

  return gains;
}

/**
 * Run a solve, treating infeasibility as "no gain available here".
 *
 * A budget that cannot field a legal fifteen is a real state — it happens when
 * the pool is thin — and it says nothing about the other gameweeks. Letting it
 * propagate would take down a whole screen over one week's arithmetic.
 */
function solveQuietly<T>(run: () => T): T | null {
  try {
    return run();
  } catch (error) {
    if (error instanceof InfeasibleError) return null;
    throw error;
  }
}
