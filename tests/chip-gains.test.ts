import { beforeAll, describe, expect, it } from "vitest";
import { createGlpkSolver } from "@/lib/solver/glpk";
import { bestXi } from "@/lib/engine/best-xi";
import {
  chipConfidence,
  computeChipGains,
  type ChipCandidate,
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
