import { describe, expect, it } from "vitest";
import { planChipsForSquad } from "@/lib/squad/chip-plan";
import type { LpSolver } from "@/lib/engine/lp";
import { CHIP } from "@/lib/rules";

describe("planChipsForSquad", () => {
  const base = {
    squad: [],
    pool: [],
    budget: 1000,
    currentGw: 5,
    played: [],
    priceDeltas: new Map<number, number>(),
    // Never reached: the guard fires before any gain is computed.
    solver: {} as LpSolver,
  };

  it("refuses to plan from one gameweek while a window runs past it", () => {
    // The dashboard bug. With one week there is nothing to wait for, so every
    // positive chip is "play it now" — including a Free Hit worth no more in
    // GW5 than in any other week.
    expect(() =>
      planChipsForSquad({
        ...base,
        gameweeks: [5],
        windows: [{ name: CHIP.freeHit, set: 1, startEvent: 2, stopEvent: 19 }],
      }),
    ).toThrow(/scan horizon/);
  });

  it("allows one gameweek when it is the last week any window has", () => {
    expect(() =>
      planChipsForSquad({
        ...base,
        gameweeks: [19],
        currentGw: 19,
        windows: [{ name: CHIP.freeHit, set: 1, startEvent: 2, stopEvent: 19 }],
      }),
    ).not.toThrow(/scan horizon/);
  });
});
