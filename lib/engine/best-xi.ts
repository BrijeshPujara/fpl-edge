import {
  FORMATION_BOUNDS,
  POSITION,
  STARTING_XI_SIZE,
  type PositionId,
} from "@/lib/rules";

/**
 * The best legal starting eleven from a squad, and the bench it leaves behind.
 *
 * Pure, and deliberately solver-free. Choosing eleven from fifteen under the
 * formation bounds looks like a job for the optimiser, but it is small enough
 * to solve exactly by enumeration: there are only seven legal formations, and
 * within a formation the best XI is simply the top N by expected points in each
 * position. Enumerating all seven and taking the best is provably optimal and
 * runs in microseconds.
 *
 * Solver-free matters more than the speed. This runs once per gameweek per chip
 * scenario on the chips screen — dozens of times a render — and it is needed by
 * `suggestTransfers` to establish the baseline that every transfer is measured
 * against. Making that path depend on WASM initialisation would be a poor trade
 * for a problem this size.
 */

export interface XiPlayer {
  id: number;
  position: PositionId;
  ep: number;
}

export interface BestXi<T extends XiPlayer> {
  starting: T[];
  bench: T[];
  /** Sum of expected points over the starting eleven. */
  startingEp: number;
  /** Sum over the four who do not start. Bench Boost pays exactly this. */
  benchEp: number;
  /** e.g. "3-5-2" — outfield only, as FPL writes it. */
  formation: string;
  /** Highest-EP starter. The captaincy pick, and Triple Captain's basis. */
  captain: T | null;
}

/** Every legal outfield shape: DEF-MID-FWD summing to ten. */
function legalFormations(): { def: number; mid: number; fwd: number }[] {
  const out: { def: number; mid: number; fwd: number }[] = [];
  const d = FORMATION_BOUNDS[POSITION.DEF];
  const m = FORMATION_BOUNDS[POSITION.MID];
  const f = FORMATION_BOUNDS[POSITION.FWD];
  const outfield = STARTING_XI_SIZE - FORMATION_BOUNDS[POSITION.GK].min;

  for (let def = d.min; def <= d.max; def++) {
    for (let mid = m.min; mid <= m.max; mid++) {
      const fwd = outfield - def - mid;
      if (fwd >= f.min && fwd <= f.max) out.push({ def, mid, fwd });
    }
  }
  return out;
}

const FORMATIONS = legalFormations();

export function bestXi<T extends XiPlayer>(squad: T[]): BestXi<T> {
  // Descending EP within each position, so taking the first N is taking the
  // best N.
  const byPosition = new Map<PositionId, T[]>();
  for (const p of squad) {
    byPosition.set(p.position, [...(byPosition.get(p.position) ?? []), p]);
  }
  for (const list of byPosition.values()) list.sort((a, b) => b.ep - a.ep);

  const take = (position: PositionId, n: number): T[] =>
    (byPosition.get(position) ?? []).slice(0, n);

  let best: { starting: T[]; ep: number; shape: (typeof FORMATIONS)[number] } | null =
    null;

  for (const shape of FORMATIONS) {
    const starting = [
      ...take(POSITION.GK, 1),
      ...take(POSITION.DEF, shape.def),
      ...take(POSITION.MID, shape.mid),
      ...take(POSITION.FWD, shape.fwd),
    ];
    // A squad short of players in a position cannot field this shape. Skip
    // rather than field ten — a partial XI is not a legal answer, and silently
    // returning one would understate every EP it touches.
    if (starting.length !== STARTING_XI_SIZE) continue;

    const ep = starting.reduce((sum, p) => sum + p.ep, 0);
    if (best === null || ep > best.ep) best = { starting, ep, shape };
  }

  if (best === null) {
    // No legal shape at all — an incomplete squad. Report it honestly rather
    // than inventing an eleven.
    return {
      starting: [],
      bench: [...squad],
      startingEp: 0,
      benchEp: squad.reduce((sum, p) => sum + p.ep, 0),
      formation: "—",
      captain: null,
    };
  }

  const startingIds = new Set(best.starting.map((p) => p.id));
  const bench = squad.filter((p) => !startingIds.has(p.id));

  return {
    starting: best.starting,
    bench,
    startingEp: best.ep,
    benchEp: bench.reduce((sum, p) => sum + p.ep, 0),
    formation: `${best.shape.def}-${best.shape.mid}-${best.shape.fwd}`,
    captain: best.starting.reduce<T | null>(
      (top, p) => (top === null || p.ep > top.ep ? p : top),
      null,
    ),
  };
}
