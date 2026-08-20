import { beforeAll, describe, expect, it } from "vitest";
import { createGlpkSolver } from "@/lib/solver/glpk";
import {
  benchBoostGain,
  chipUrgency,
  planChips,
  tripleCaptainGain,
  type ChipGain,
} from "@/lib/engine/chips";
import type { LpSolver } from "@/lib/engine/lp";
import type { ChipWindow } from "@/lib/fpl/gameweek";
import { CAPTAIN_MULTIPLIER, CHIP, TRIPLE_CAPTAIN_MULTIPLIER } from "@/lib/rules";

let solver: LpSolver;
beforeAll(async () => {
  solver = await createGlpkSolver();
});

function window(
  name: ChipWindow["name"],
  startEvent: number,
  stopEvent: number,
  set = 1,
): ChipWindow {
  return { name, set, startEvent, stopEvent };
}

function gain(
  chip: ChipGain["chip"],
  gw: number,
  value: number,
  set = 1,
  confidence?: number,
): ChipGain {
  return { chip, set, gw, gain: value, confidence };
}

describe("planChips", () => {
  it("waits for the better gameweek instead of firing on the first good one", () => {
    // The whole point. A threshold at 8.0 fires in GW5 and burns the chip; the
    // assignment sees GW12 coming and holds.
    const plan = planChips({
      windows: [window(CHIP.tripleCaptain, 2, 19)],
      gains: [
        gain(CHIP.tripleCaptain, 5, 9),
        gain(CHIP.tripleCaptain, 8, 8.5),
        gain(CHIP.tripleCaptain, 12, 16),
      ],
      currentGw: 4,
      solver,
    });

    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0].gw).toBe(12);
    expect(plan.assignments[0].gain).toBe(16);
  });

  it("reports the margin over the next-best week for that chip", () => {
    const plan = planChips({
      windows: [window(CHIP.tripleCaptain, 2, 19)],
      gains: [
        gain(CHIP.tripleCaptain, 5, 9),
        gain(CHIP.tripleCaptain, 12, 16),
      ],
      currentGw: 4,
      solver,
    });

    const [tc] = plan.assignments;
    expect(tc.nextBestGw).toBe(5);
    expect(tc.marginOverNextBest).toBeCloseTo(7, 6);
  });

  it("leaves the margin null when there is no alternative week", () => {
    const plan = planChips({
      windows: [window(CHIP.benchBoost, 2, 19)],
      gains: [gain(CHIP.benchBoost, 9, 14)],
      currentGw: 4,
      solver,
    });
    expect(plan.assignments[0].nextBestGw).toBeNull();
    expect(plan.assignments[0].marginOverNextBest).toBeNull();
  });

  it("keeps two chips out of the same gameweek", () => {
    // GW12 is the standout week for both. Only one can have it, and the other
    // must take its own best remaining week rather than doubling up.
    const plan = planChips({
      windows: [
        window(CHIP.tripleCaptain, 2, 19),
        window(CHIP.benchBoost, 2, 19),
      ],
      gains: [
        gain(CHIP.tripleCaptain, 12, 16),
        gain(CHIP.tripleCaptain, 15, 6),
        gain(CHIP.benchBoost, 12, 14),
        gain(CHIP.benchBoost, 17, 11),
      ],
      currentGw: 4,
      solver,
    });

    const weeks = plan.assignments.map((a) => a.gw);
    expect(new Set(weeks).size).toBe(weeks.length);
    expect(plan.assignments).toHaveLength(2);

    // The optimum is TC in 12 and BB in 17 (16 + 11 = 27), not BB in 12 and TC
    // in 15 (14 + 6 = 20). A greedy pass by chip order could get this wrong.
    expect(plan.totalGain).toBeCloseTo(27, 6);
  });

  it("sacrifices the locally best choice for the better total", () => {
    // TC's best week is 10 at 12 points. But BB can ONLY play in 10, and is
    // worth 20 there. Giving 10 to BB and TC its second choice scores more.
    const plan = planChips({
      windows: [
        window(CHIP.tripleCaptain, 2, 19),
        window(CHIP.benchBoost, 10, 10),
      ],
      gains: [
        gain(CHIP.tripleCaptain, 10, 12),
        gain(CHIP.tripleCaptain, 11, 11),
        gain(CHIP.benchBoost, 10, 20),
      ],
      currentGw: 4,
      solver,
    });

    const tc = plan.assignments.find((a) => a.chip === CHIP.tripleCaptain);
    const bb = plan.assignments.find((a) => a.chip === CHIP.benchBoost);
    expect(bb?.gw).toBe(10);
    expect(tc?.gw).toBe(11);
    expect(plan.totalGain).toBeCloseTo(31, 6);
  });

  it("never plays a chip for a negative gain", () => {
    // A Free Hit into a week your own squad handles better is a loss, and an
    // idle gameweek is not a reason to take it.
    const plan = planChips({
      windows: [window(CHIP.freeHit, 2, 19)],
      gains: [gain(CHIP.freeHit, 6, -3), gain(CHIP.freeHit, 9, -1)],
      currentGw: 4,
      solver,
    });

    expect(plan.assignments).toEqual([]);
    expect(plan.unassigned).toEqual([
      expect.objectContaining({ chip: CHIP.freeHit, reason: "no-positive-gain" }),
    ]);
  });

  it("treats the two sets of a chip as separate instances", () => {
    const plan = planChips({
      windows: [
        window(CHIP.wildcard, 2, 19, 1),
        window(CHIP.wildcard, 20, 38, 2),
      ],
      gains: [
        gain(CHIP.wildcard, 8, 10, 1),
        gain(CHIP.wildcard, 28, 14, 2),
      ],
      currentGw: 4,
      solver,
    });

    expect(plan.assignments).toHaveLength(2);
    expect(plan.assignments.map((a) => a.set)).toEqual([1, 2]);
    expect(plan.assignments.map((a) => a.gw)).toEqual([8, 28]);
  });

  it("does not offer a set that has already been played", () => {
    const plan = planChips({
      windows: [
        window(CHIP.wildcard, 2, 19, 1),
        window(CHIP.wildcard, 20, 38, 2),
      ],
      gains: [
        gain(CHIP.wildcard, 8, 10, 1),
        gain(CHIP.wildcard, 28, 14, 2),
      ],
      alreadyPlayed: [{ chip: CHIP.wildcard, set: 1 }],
      currentGw: 4,
      solver,
    });

    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0].set).toBe(2);
    expect(plan.unassigned).toEqual([
      expect.objectContaining({ set: 1, reason: "already-played" }),
    ]);
  });

  it("ignores gameweeks already behind us", () => {
    // GW5 was the best week of the season and it is gone. The plan must not
    // recommend it, and must not report the chip as unplayable either.
    const plan = planChips({
      windows: [window(CHIP.tripleCaptain, 2, 19)],
      gains: [
        gain(CHIP.tripleCaptain, 5, 30),
        gain(CHIP.tripleCaptain, 14, 7),
      ],
      currentGw: 10,
      solver,
    });

    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0].gw).toBe(14);
  });

  it("ignores gameweeks outside the window", () => {
    const plan = planChips({
      windows: [window(CHIP.wildcard, 2, 19, 1)],
      gains: [
        gain(CHIP.wildcard, 25, 40, 1),
        gain(CHIP.wildcard, 12, 6, 1),
      ],
      currentGw: 4,
      solver,
    });
    expect(plan.assignments[0].gw).toBe(12);
  });

  it("reports a closed window rather than dropping the chip", () => {
    const plan = planChips({
      windows: [window(CHIP.benchBoost, 2, 19)],
      gains: [gain(CHIP.benchBoost, 12, 14)],
      currentGw: 22,
      solver,
    });
    expect(plan.assignments).toEqual([]);
    expect(plan.unassigned).toEqual([
      expect.objectContaining({ reason: "window-closed" }),
    ]);
  });

  it("distinguishes no projections from nothing worth playing", () => {
    const plan = planChips({
      windows: [
        window(CHIP.benchBoost, 2, 19),
        window(CHIP.freeHit, 2, 19),
      ],
      gains: [gain(CHIP.freeHit, 6, -2)],
      currentGw: 4,
      solver,
    });

    const reasons = Object.fromEntries(
      plan.unassigned.map((u) => [u.chip, u.reason]),
    );
    expect(reasons[CHIP.benchBoost]).toBe("no-projections");
    expect(reasons[CHIP.freeHit]).toBe("no-positive-gain");
  });

  it("says when a chip lost its week to a more valuable one", () => {
    // Both can only play GW10. That is a different situation from having no
    // data, and the reason has to say so.
    const plan = planChips({
      windows: [
        window(CHIP.tripleCaptain, 10, 10),
        window(CHIP.benchBoost, 10, 10),
      ],
      gains: [
        gain(CHIP.tripleCaptain, 10, 20),
        gain(CHIP.benchBoost, 10, 8),
      ],
      currentGw: 4,
      solver,
    });

    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0].chip).toBe(CHIP.tripleCaptain);
    expect(plan.unassigned).toEqual([
      expect.objectContaining({ chip: CHIP.benchBoost, reason: "gameweek-taken" }),
    ]);
  });

  it("discounts a distant projection through confidence", () => {
    // GW30's raw 20 beats GW8's 12, but at 40% confidence it is worth 8.
    const plan = planChips({
      windows: [window(CHIP.benchBoost, 20, 38, 2)],
      gains: [
        gain(CHIP.benchBoost, 22, 12, 2, 1),
        gain(CHIP.benchBoost, 30, 20, 2, 0.4),
      ],
      currentGw: 21,
      solver,
    });

    expect(plan.assignments[0].gw).toBe(22);
    expect(plan.assignments[0].gain).toBe(12);
    expect(plan.assignments[0].adjustedGain).toBeCloseTo(12, 6);
  });

  it("counts gameweeks to expiry inclusively", () => {
    // Playing in the window's final gameweek leaves one gameweek, not zero.
    const plan = planChips({
      windows: [window(CHIP.benchBoost, 2, 19)],
      gains: [gain(CHIP.benchBoost, 19, 14)],
      currentGw: 18,
      solver,
    });
    expect(plan.assignments[0].gameweeksUntilExpiry).toBe(1);
  });

  it("returns an empty plan rather than throwing when there is nothing to do", () => {
    const plan = planChips({
      windows: [],
      gains: [],
      currentGw: 4,
      solver,
    });
    expect(plan).toEqual({ assignments: [], unassigned: [], totalGain: 0 });
  });

  it("orders assignments by gameweek", () => {
    const plan = planChips({
      windows: [
        window(CHIP.tripleCaptain, 2, 19),
        window(CHIP.benchBoost, 2, 19),
        window(CHIP.freeHit, 2, 19),
      ],
      gains: [
        gain(CHIP.tripleCaptain, 15, 9),
        gain(CHIP.benchBoost, 6, 12),
        gain(CHIP.freeHit, 11, 7),
      ],
      currentGw: 4,
      solver,
    });
    expect(plan.assignments.map((a) => a.gw)).toEqual([6, 11, 15]);
  });
});

describe("chipUrgency", () => {
  it("is zero for a chip that already has a week booked", () => {
    expect(chipUrgency(window(CHIP.benchBoost, 2, 19), 17, true)).toBe(0);
  });

  it("rises as the window closes", () => {
    const w = window(CHIP.benchBoost, 2, 19);
    const early = chipUrgency(w, 4, false);
    const late = chipUrgency(w, 17, false);
    expect(late).toBeGreaterThan(early);
    expect(early).toBeGreaterThanOrEqual(0);
    expect(late).toBeLessThanOrEqual(1);
  });

  it("peaks in the final gameweek of the window", () => {
    expect(chipUrgency(window(CHIP.benchBoost, 2, 19), 19, false)).toBe(1);
  });

  it("is zero once the window has closed — there is nothing left to urge", () => {
    expect(chipUrgency(window(CHIP.benchBoost, 2, 19), 20, false)).toBe(0);
  });
});

describe("gains", () => {
  it("bench boost is the sum of the bench, at full value", () => {
    expect(benchBoostGain([3.2, 2.8, 2.1, 1.9])).toBeCloseTo(10, 6);
    expect(benchBoostGain([])).toBe(0);
  });

  it("triple captain is ONE extra multiple, not three", () => {
    // The armband already pays double. The chip buys the step from 2x to 3x,
    // so a captain projected at 9 gains 9 — not 27, and not 18.
    expect(tripleCaptainGain(9)).toBeCloseTo(9, 6);
  });

  it("triple captain gain equals the difference between the multipliers", () => {
    const ep = 7.5;
    expect(tripleCaptainGain(ep)).toBeCloseTo(
      ep * TRIPLE_CAPTAIN_MULTIPLIER - ep * CAPTAIN_MULTIPLIER,
      6,
    );
  });
});

describe("planChips — the margin is against weeks you could actually use", () => {
  it("never reports a negative margin", () => {
    // Both chips want GW12. Bench Boost wins it, so Triple Captain takes GW15.
    // Measuring TC against GW12 — a week it cannot have — would report it as
    // worse off than an impossible alternative.
    const plan = planChips({
      windows: [
        window(CHIP.benchBoost, 2, 19),
        window(CHIP.tripleCaptain, 2, 19),
      ],
      gains: [
        gain(CHIP.benchBoost, 12, 20),
        gain(CHIP.benchBoost, 13, 3),
        gain(CHIP.tripleCaptain, 12, 18),
        gain(CHIP.tripleCaptain, 15, 6),
        gain(CHIP.tripleCaptain, 16, 4),
      ],
      currentGw: 4,
      solver,
    });

    for (const assignment of plan.assignments) {
      if (assignment.marginOverNextBest === null) continue;
      expect(assignment.marginOverNextBest).toBeGreaterThanOrEqual(0);
    }
  });

  it("names a free gameweek as the alternative, not an occupied one", () => {
    const plan = planChips({
      windows: [
        window(CHIP.benchBoost, 2, 19),
        window(CHIP.tripleCaptain, 2, 19),
      ],
      gains: [
        gain(CHIP.benchBoost, 12, 20),
        gain(CHIP.benchBoost, 13, 3),
        gain(CHIP.tripleCaptain, 12, 18),
        gain(CHIP.tripleCaptain, 15, 6),
        gain(CHIP.tripleCaptain, 16, 4),
      ],
      currentGw: 4,
      solver,
    });

    const tc = plan.assignments.find((a) => a.chip === CHIP.tripleCaptain)!;
    expect(tc.gw).toBe(15);
    // GW12 is Bench Boost's. The real alternative is GW16.
    expect(tc.nextBestGw).toBe(16);
    expect(tc.marginOverNextBest).toBeCloseTo(2, 6);
  });

  it("reports no alternative when every other week is taken", () => {
    const plan = planChips({
      windows: [
        window(CHIP.benchBoost, 10, 11),
        window(CHIP.tripleCaptain, 10, 11),
      ],
      gains: [
        gain(CHIP.benchBoost, 10, 20),
        gain(CHIP.benchBoost, 11, 18),
        gain(CHIP.tripleCaptain, 10, 9),
        gain(CHIP.tripleCaptain, 11, 8),
      ],
      currentGw: 4,
      solver,
    });

    expect(plan.assignments).toHaveLength(2);
    for (const assignment of plan.assignments) {
      expect(assignment.marginOverNextBest).toBeNull();
      expect(assignment.nextBestGw).toBeNull();
    }
  });
});
