import { describe, expect, it } from "vitest";
import { projectPriceChange } from "@/lib/engine/price-model";
import {
  MAX_PROJECTED_PRICE_DELTA,
  PRICE_RISE_REALISATION,
} from "@/lib/engine/constants";

const base = {
  playerId: 1,
  ownershipPercent: 20,
  previousOwnershipPercent: 19,
  totalManagers: 10_000_000,
};

describe("projectPriceChange", () => {
  it("reports no confidence when there is no history", () => {
    // The state the app is in right now: player_gw_stats is empty pre-season.
    // A zero here is an absence of data, not a prediction of no movement.
    const result = projectPriceChange({ ...base, transfersBalance: [] }, 5);
    expect(result.confidence).toBe("none");
    expect(result.expectedDelta).toBe(0);
  });

  it("projects a rise on sustained net transfers in", () => {
    const result = projectPriceChange(
      { ...base, transfersBalance: [80_000, 70_000, 60_000] },
      5,
    );
    expect(result.expectedDelta).toBeGreaterThan(0);
    expect(result.confidence).toBe("medium");
  });

  it("projects a fall on net transfers out", () => {
    const result = projectPriceChange(
      { ...base, transfersBalance: [-80_000, -70_000, -60_000] },
      5,
    );
    expect(result.expectedDelta).toBeLessThan(0);
  });

  it("halves a rise for the sell-on fee but bears a fall in full", () => {
    // The asymmetry that stops the optimiser overvaluing risers twofold.
    const up = projectPriceChange(
      { ...base, transfersBalance: [80_000, 70_000, 60_000] },
      5,
    );
    const down = projectPriceChange(
      { ...base, transfersBalance: [-80_000, -70_000, -60_000] },
      5,
    );

    expect(up.realisableDelta).toBeCloseTo(
      up.expectedDelta * PRICE_RISE_REALISATION,
      6,
    );
    expect(down.realisableDelta).toBeCloseTo(down.expectedDelta, 6);
    // A fall of the same magnitude hurts more than the rise helps.
    expect(Math.abs(down.realisableDelta)).toBeGreaterThan(up.realisableDelta);
  });

  it("needs more net transfers to move a widely-owned player", () => {
    // The threshold scales with the owner base, so identical flow moves a
    // differential further than a template pick.
    const flow = [100_000, 100_000, 100_000];
    const differential = projectPriceChange(
      { ...base, ownershipPercent: 2, transfersBalance: flow },
      5,
    );
    const template = projectPriceChange(
      { ...base, ownershipPercent: 60, transfersBalance: flow },
      5,
    );
    expect(differential.expectedDelta).toBeGreaterThan(template.expectedDelta);
  });

  it("caps a runaway projection", () => {
    const result = projectPriceChange(
      { ...base, ownershipPercent: 0.1, transfersBalance: [5_000_000] },
      5,
    );
    expect(result.expectedDelta).toBeLessThanOrEqual(MAX_PROJECTED_PRICE_DELTA);
  });

  it("does not scale down a player with only one gameweek of history", () => {
    // Weights are renormalised, so a short history is not read as low momentum.
    const one = projectPriceChange({ ...base, transfersBalance: [100_000] }, 5);
    const three = projectPriceChange(
      { ...base, transfersBalance: [100_000, 100_000, 100_000] },
      5,
    );
    expect(one.expectedDelta).toBeCloseTo(three.expectedDelta, 6);
    expect(one.confidence).toBe("low");
  });
});
