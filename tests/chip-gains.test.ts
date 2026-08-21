import { beforeAll, describe, expect, it } from "vitest";
import { createGlpkSolver } from "@/lib/solver/glpk";
import { bestXi } from "@/lib/engine/best-xi";
import {
  chipConfidence,
  computeChipGains,
  type ChipCandidate,
  prunePool,
} from "@/lib/engine/chip-gains";
import type { LpSolver } from "@/lib/engine/lp";
import type { ChipWindow } from "@/lib/fpl/gameweek";
import {
  CHIP_CONFIDENCE_FLOOR,
  CHIP_CONFIDENCE_HALF_LIFE,
} from "@/lib/engine/constants";
import {
  CAPTAIN_MULTIPLIER,
  CHIP,
  POSITION,
  SQUAD_COMPOSITION,
  TRIPLE_CAPTAIN_MULTIPLIER,
  type PositionId,
} from "@/lib/rules";

let solver: LpSolver;
beforeAll(async () => {
  solver = await createGlpkSolver();
});

const GWS = [5, 6, 7];

const ALL_WINDOWS: ChipWindow[] = [
  { name: CHIP.benchBoost, set: 1, startEvent: 2, stopEvent: 19 },
  { name: CHIP.tripleCaptain, set: 1, startEvent: 2, stopEvent: 19 },
  { name: CHIP.freeHit, set: 1, startEvent: 2, stopEvent: 19 },
  { name: CHIP.wildcard, set: 1, startEvent: 2, stopEvent: 19 },
];

/** A legal fifteen. `epFor` returns the EP for a given index and gameweek. */
function squad(epFor: (index: number, gw: number) => number): ChipCandidate[] {
  const out: ChipCandidate[] = [];
  let id = 1;
  for (const position of [
    POSITION.GK,
    POSITION.DEF,
    POSITION.MID,
    POSITION.FWD,
  ]) {
    for (let i = 0; i < SQUAD_COMPOSITION[position]; i++) {
      const index = id - 1;
      out.push({
        id,
        position,
        teamId: id,
        price: 45,
        ep: 0,
        pMinutes: 0.95,
        epByGameweek: new Map(GWS.map((gw) => [gw, epFor(index, gw)])),
      });
      id++;
    }
  }
  return out;
}

describe("chipConfidence", () => {
  it("fully trusts the gameweek in front of you", () => {
    expect(chipConfidence(7, 7)).toBe(1);
  });

  it("halves over the half-life", () => {
    expect(chipConfidence(7 + CHIP_CONFIDENCE_HALF_LIFE, 7)).toBeCloseTo(0.5, 6);
  });

  it("decays but never to nothing", () => {
    // A far-off double is still the best chip week of the season, and a
    // discount that ran to zero would hide it.
    expect(chipConfidence(38, 2)).toBe(CHIP_CONFIDENCE_FLOOR);
    expect(chipConfidence(38, 2)).toBeGreaterThan(0);
  });

  it("does not reward the past", () => {
    expect(chipConfidence(3, 7)).toBe(1);
  });
});

describe("computeChipGains", () => {
  it("prices Bench Boost as exactly the four who would not have counted", () => {
    // A uniform squad makes the arithmetic unambiguous: eleven of fifteen
    // start, so the chip is worth the other four.
    const s = squad(() => 4);
    const gains = computeChipGains({
      squad: s,
      pool: s,
      gameweeks: GWS,
      budget: 1000,
      windows: ALL_WINDOWS,
      currentGw: 5,
      solver,
    });

    const bb = gains.filter((g) => g.chip === CHIP.benchBoost);
    expect(bb).toHaveLength(GWS.length);
    expect(bb[0].gain).toBeCloseTo(4 * 4, 6);
  });

  it("Bench Boost is whatever the eleven leave behind, whatever the shape", () => {
    // The invariant, independent of formation: squad EP minus starting EP.
    // Note the reserve goalkeeper is always on that bench, however good he is,
    // which is exactly why a hand-picked "eleven good, four poor" fixture
    // gives the wrong answer.
    const s = squad((i) => [8, 7, 6, 5, 4, 3, 2, 9, 8, 7, 6, 1, 5, 4, 3][i]);
    const total = s.reduce((sum, p) => sum + (p.epByGameweek.get(5) ?? 0), 0);

    const gains = computeChipGains({
      squad: s,
      pool: s,
      gameweeks: [5],
      budget: 1000,
      windows: ALL_WINDOWS,
      currentGw: 5,
      solver,
    });

    const bb = gains.find((g) => g.chip === CHIP.benchBoost)!;
    const xi = bestXi(s.map((p) => ({ ...p, ep: p.epByGameweek.get(5) ?? 0 })));
    expect(bb.gain).toBeCloseTo(total - xi.startingEp, 6);
    expect(bb.gain).toBeGreaterThan(0);
  });

  it("prices Triple Captain as one extra multiple, not three", () => {
    const s = squad((i) => (i === 12 ? 10 : 2));
    const gains = computeChipGains({
      squad: s,
      pool: s,
      gameweeks: [5],
      budget: 1000,
      windows: ALL_WINDOWS,
      currentGw: 5,
      solver,
    });

    const tc = gains.find((g) => g.chip === CHIP.tripleCaptain);
    expect(tc?.gain).toBeCloseTo(10, 6);
    expect(tc?.gain).toBeCloseTo(
      10 * TRIPLE_CAPTAIN_MULTIPLIER - 10 * CAPTAIN_MULTIPLIER,
      6,
    );
  });

  it("finds the double gameweek", () => {
    // Gameweek 6 is worth double to everyone, as a double gameweek is.
    const s = squad((i, gw) => (gw === 6 ? 8 : 4) * (i < 11 ? 1 : 0.4));
    const gains = computeChipGains({
      squad: s,
      pool: s,
      gameweeks: GWS,
      budget: 1000,
      windows: ALL_WINDOWS,
      currentGw: 5,
      solver,
    });

    const bb = gains.filter((g) => g.chip === CHIP.benchBoost);
    const best = bb.reduce((a, b) => (b.gain > a.gain ? b : a));
    expect(best.gw).toBe(6);
  });

  it("gives Free Hit nothing when the squad is already optimal", () => {
    // The pool IS the squad, so there is no better one-week team to buy.
    const s = squad(() => 5);
    const gains = computeChipGains({
      squad: s,
      pool: s,
      gameweeks: [5],
      budget: 1000,
      windows: ALL_WINDOWS,
      currentGw: 5,
      solver,
    });

    const fh = gains.find((g) => g.chip === CHIP.freeHit);
    expect(fh?.gain).toBeCloseTo(0, 6);
  });

  it("values Free Hit when the market is better than what you own", () => {
    const owned = squad(() => 2);
    const better = squad(() => 9).map((p) => ({
      ...p,
      id: p.id + 100,
      teamId: p.teamId + 100,
    }));
    const gains = computeChipGains({
      squad: owned,
      pool: [...owned, ...better],
      gameweeks: [5],
      budget: 1000,
      windows: ALL_WINDOWS,
      currentGw: 5,
      solver,
    });

    const fh = gains.find((g) => g.chip === CHIP.freeHit);
    // Eleven starters improving from 2 to 9.
    expect(fh?.gain).toBeCloseTo(11 * 7, 6);
  });

  it("values a Wildcard over the gameweeks that remain, not the whole span", () => {
    // Playing in the last scanned gameweek can only collect that one week, so
    // it must be worth less than playing in the first.
    const owned = squad(() => 2);
    const better = squad(() => 9).map((p) => ({
      ...p,
      id: p.id + 100,
      teamId: p.teamId + 100,
    }));
    const gains = computeChipGains({
      squad: owned,
      pool: [...owned, ...better],
      gameweeks: GWS,
      budget: 1000,
      windows: ALL_WINDOWS,
      currentGw: 5,
      solver,
    });

    const wc = gains.filter((g) => g.chip === CHIP.wildcard);
    const early = wc.find((g) => g.gw === 5)!;
    const late = wc.find((g) => g.gw === 7)!;
    expect(early.gain).toBeGreaterThan(late.gain);
    // Three weeks of improvement against one.
    expect(early.gain).toBeCloseTo(late.gain * 3, 4);
  });

  it("attaches a confidence that falls with distance", () => {
    const s = squad(() => 5);
    const gains = computeChipGains({
      squad: s,
      pool: s,
      gameweeks: GWS,
      budget: 1000,
      windows: ALL_WINDOWS,
      currentGw: 5,
      solver,
    });

    const bb = gains
      .filter((g) => g.chip === CHIP.benchBoost)
      .sort((a, b) => a.gw - b.gw);
    expect(bb[0].confidence).toBeGreaterThan(bb[2].confidence!);
  });

  it("offers no gain for a gameweek outside the chip's window", () => {
    const s = squad(() => 5);
    const gains = computeChipGains({
      squad: s,
      pool: s,
      gameweeks: GWS,
      budget: 1000,
      windows: [
        { name: CHIP.benchBoost, set: 1, startEvent: 20, stopEvent: 38 },
      ],
      currentGw: 5,
      solver,
    });
    expect(gains).toEqual([]);
  });

  it("tags each gain with the set whose window contains it", () => {
    const s = squad(() => 5);
    const gains = computeChipGains({
      squad: s,
      pool: s,
      gameweeks: [5, 25],
      budget: 1000,
      windows: [
        { name: CHIP.benchBoost, set: 1, startEvent: 2, stopEvent: 19 },
        { name: CHIP.benchBoost, set: 2, startEvent: 20, stopEvent: 38 },
      ],
      currentGw: 5,
      solver,
    });

    expect(gains.find((g) => g.gw === 5)?.set).toBe(1);
    expect(gains.find((g) => g.gw === 25)?.set).toBe(2);
  });
});

describe("pruning the pool a rebuild solves over", () => {
  const player = (
    id: number,
    position: PositionId,
    price: number,
    teamId: number,
    ep: number,
  ) => ({
    id,
    position,
    teamId,
    price,
    ep,
    pMinutes: 1,
    epByGameweek: new Map([[1, ep]]),
  });

  it("keeps at most the per-club cap from one position, price and club", () => {
    // These four are interchangeable in every constraint the optimiser has,
    // so a fourth can never be needed — three is the club limit.
    const pool = [
      player(1, POSITION.DEF, 45, 7, 5),
      player(2, POSITION.DEF, 45, 7, 4),
      player(3, POSITION.DEF, 45, 7, 3),
      player(4, POSITION.DEF, 45, 7, 2),
    ];
    const kept = prunePool(pool, new Set());

    expect(kept).toHaveLength(3);
    expect(kept.map((p) => p.id).sort()).toEqual([1, 2, 3]);
  });

  it("keeps the cheapest players however low their projection", () => {
    // The enablers, and the reason a plain top-N prune moved a chip gain by
    // 1.21 points: ranking by expected points discards exactly the players a
    // rebuild needs in order to afford the ones it wants.
    const expensive = Array.from({ length: 40 }, (_, i) =>
      player(100 + i, POSITION.MID, 90 + i, i % 20, 10 - i * 0.1),
    );
    const enabler = player(1, POSITION.MID, 45, 3, 0.2);

    const kept = prunePool([...expensive, enabler], new Set());
    expect(kept.map((p) => p.id)).toContain(1);
  });

  it("never drops a player the manager owns", () => {
    // A rebuild is scored against holding, so a held player has to stay
    // available or the comparison is against a squad nobody could have kept.
    const owned = player(1, POSITION.FWD, 120, 5, 0.1);
    const better = Array.from({ length: 40 }, (_, i) =>
      player(200 + i, POSITION.FWD, 120, 5, 9 - i * 0.1),
    );

    const kept = prunePool([owned, ...better], new Set([1]));
    expect(kept.map((p) => p.id)).toContain(1);
  });

  it("cuts a real-sized pool down hard", () => {
    const pool = Array.from({ length: 600 }, (_, i) =>
      player(
        i,
        ((i % 4) + 1) as PositionId,
        40 + (i % 60),
        i % 20,
        Math.random() * 8,
      ),
    );
    expect(prunePool(pool, new Set()).length).toBeLessThan(pool.length / 2);
  });

  it("leaves a pool that is already small alone", () => {
    const pool = [
      player(1, POSITION.GK, 45, 1, 3),
      player(2, POSITION.DEF, 45, 2, 4),
      player(3, POSITION.MID, 55, 3, 5),
      player(4, POSITION.FWD, 65, 4, 6),
    ];
    expect(prunePool(pool, new Set())).toHaveLength(4);
  });
});
