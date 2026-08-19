import { describe, expect, it } from "vitest";
import { assessValue, type FrontierInput } from "@/lib/engine/frontier";
import { POSITION } from "@/lib/rules";

/** A clean linear price→EP relationship: ep = price/10. */
function linearPool(count = 12): FrontierInput[] {
  return Array.from({ length: count }, (_, i) => ({
    playerId: i + 1,
    position: POSITION.MID,
    price: 40 + i * 10,
    ep: (40 + i * 10) / 10,
  }));
}

describe("assessValue", () => {
  it("gives roughly zero surplus to players on the trend", () => {
    for (const a of assessValue(linearPool())) {
      expect(Math.abs(a.valueSurplus)).toBeLessThan(0.5);
    }
  });

  it("marks an over-performer positive and an under-performer negative", () => {
    const players = linearPool();
    players.push({ playerId: 99, position: POSITION.MID, price: 60, ep: 14 });
    players.push({ playerId: 98, position: POSITION.MID, price: 150, ep: 2 });

    const byId = new Map(assessValue(players).map((a) => [a.playerId, a]));
    // Positive means more output than the price implies — underpriced.
    expect(byId.get(99)!.valueSurplus).toBeGreaterThan(0);
    expect(byId.get(98)!.valueSurplus).toBeLessThan(0);
  });

  it("fits each position separately", () => {
    // A 5.0m defender scoring 4 is good; a 5.0m forward scoring 4 is not.
    // Pooling them would rate every defender a bargain.
    const players: FrontierInput[] = [
      ...Array.from({ length: 10 }, (_, i) => ({
        playerId: 100 + i,
        position: POSITION.DEF,
        price: 40 + i * 5,
        ep: 2 + i * 0.1,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        playerId: 200 + i,
        position: POSITION.FWD,
        price: 40 + i * 5,
        ep: 6 + i * 0.3,
      })),
    ];
    const byId = new Map(assessValue(players).map((a) => [a.playerId, a]));
    // The mid-table defender sits on its own position's curve, not below the
    // forwards' much higher one.
    expect(Math.abs(byId.get(105)!.valueSurplus)).toBeLessThan(0.5);
  });

  it("returns zero surplus rather than fitting noise on a thin position", () => {
    const players: FrontierInput[] = [
      { playerId: 1, position: POSITION.GK, price: 40, ep: 3 },
      { playerId: 2, position: POSITION.GK, price: 55, ep: 9 },
    ];
    for (const a of assessValue(players)) {
      expect(a.valueSurplus).toBe(0);
    }
  });

  it("keeps the fitted curve monotone through a dip in the data", () => {
    // A price band where the sample happens to underperform must not produce a
    // downward-sloping curve, which would mark a whole band as underpriced.
    const players = linearPool();
    players[6].ep = 1;
    players[7].ep = 1;

    const fitted = assessValue(players)
      .sort((a, b) => a.price - b.price)
      .map((a) => a.expectedEpForPrice);

    for (let i = 1; i < fitted.length; i++) {
      expect(fitted[i]).toBeGreaterThanOrEqual(fitted[i - 1] - 1e-9);
    }
  });
});
