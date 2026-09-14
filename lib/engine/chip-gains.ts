import {
  CHIP,
  MAX_PLAYERS_PER_CLUB,
  POSITION,
  type ChipName,
  type PositionId,
} from "@/lib/rules";
import type { ChipWindow } from "@/lib/fpl/gameweek";
import { benchBoostGain, tripleCaptainGain, type ChipGain } from "./chips";
import { bestXi } from "./best-xi";
import {
  InfeasibleError,
  optimiseSquad,
  type PlayerCandidate,
} from "./optimiser";
import type { LpSolver } from "./lp";
import {
  CHIP_CONFIDENCE_FLOOR,
  CHIP_CONFIDENCE_HALF_LIFE,
  CHIP_POOL_CHEAP_TIERS,
  CHIP_POOL_PER_POSITION,
} from "./constants";

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
 * How much of a projection's departure from an ordinary week is trusted, that
 * many gameweeks out.
 *
 * Halves every CHIP_CONFIDENCE_HALF_LIFE gameweeks, down to a floor. `planChips`
 * applies it to how far a week sits above or below the chip's ordinary week,
 * not to the gain itself — discounting the whole gain made every flat week
 * nearer than the next look better, and burned chips early. This is still the
 * term that stops the planner chasing a speculative double gameweek fifteen
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

/**
 * The players a chip rebuild could actually want.
 *
 * See CHIP_POOL_PER_POSITION for the measurement and for why the cheap tiers
 * are kept explicitly. `alwaysKeep` is the owned squad: a rebuild is scored
 * against holding, so every held player has to remain available or the
 * comparison is against a squad the manager could not have kept.
 */
export function prunePool<T extends ChipCandidate>(
  pool: T[],
  alwaysKeep: Set<number>,
): T[] {
  // Interchangeable within position, price and club — only the per-club cap
  // can ever be needed, and taking the best of them is never worse.
  const buckets = new Map<string, T[]>();
  for (const player of pool) {
    const key = `${player.position}:${player.price}:${player.teamId}`;
    buckets.set(key, [...(buckets.get(key) ?? []), player]);
  }

  const peak = (p: T) => Math.max(0, ...p.epByGameweek.values());
  const safe: T[] = [];
  for (const bucket of buckets.values()) {
    safe.push(
      ...[...bucket].sort((a, b) => peak(b) - peak(a)).slice(0, MAX_PLAYERS_PER_CLUB),
    );
  }

  const kept: T[] = [];
  for (const position of Object.values(POSITION) as PositionId[]) {
    const group = safe.filter((p) => p.position === position);
    const cheapest = new Set(
      [...new Set(group.map((p) => p.price))]
        .sort((a, b) => a - b)
        .slice(0, CHIP_POOL_CHEAP_TIERS),
    );
    const best = new Set(
      [...group]
        .sort((a, b) => peak(b) - peak(a))
        .slice(0, CHIP_POOL_PER_POSITION)
        .map((p) => p.id),
    );

    for (const player of group) {
      if (best.has(player.id) || cheapest.has(player.price) || alwaysKeep.has(player.id)) {
        kept.push(player);
      }
    }
  }

  // A held player whose bucket lost him still has to come back.
  const present = new Set(kept.map((p) => p.id));
  for (const player of pool) {
    if (alwaysKeep.has(player.id) && !present.has(player.id)) kept.push(player);
  }
  return kept;
}

export function computeChipGains(input: ChipGainInput): ChipGain[] {
  const { squad, gameweeks, budget, windows, currentGw, solver } = input;

  // Pruned here rather than by the callers, so the dashboard and the chips
  // screen cannot end up solving over different pools and disagreeing.
  const pool = prunePool(
    input.pool,
    new Set(squad.map((p) => p.id)),
  );
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
