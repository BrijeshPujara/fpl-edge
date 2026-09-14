import { describe, expect, it } from "vitest";
import { baseWeekFor, lineUp, settleSquad } from "@/lib/shadow/plan";
import { pairWeeks, shadowVerdict } from "@/lib/shadow/verdict";
import { CHIP, POSITION } from "@/lib/rules";

describe("baseWeekFor", () => {
  it("plans from the latest earlier week", () => {
    const weeks = [
      { gw: 4, chip: null },
      { gw: 5, chip: null },
      { gw: 6, chip: null },
    ];
    expect(baseWeekFor(weeks, 6)?.gw).toBe(5);
  });

  it("skips a Free Hit, whose squad and bank revert", () => {
    // Planning GW7 from the GW6 Free Hit fifteen would keep a squad the rules
    // take away.
    const weeks = [
      { gw: 5, chip: null },
      { gw: 6, chip: CHIP.freeHit },
    ];
    expect(baseWeekFor(weeks, 7)?.gw).toBe(5);
  });

  it("does not skip a Wildcard, which is kept", () => {
    const weeks = [
      { gw: 5, chip: null },
      { gw: 6, chip: CHIP.wildcard },
    ];
    expect(baseWeekFor(weeks, 7)?.gw).toBe(6);
  });
});

describe("settleSquad", () => {
  const prices: Record<number, number> = { 1: 53, 2: 48, 3: 60, 4: 45 };
  const price = (id: number) => prices[id];

  it("sells at the selling price and buys at the current price", () => {
    // Player 1 bought at 50, now 53: sells for 51. Player 3 costs 60.
    const result = settleSquad({
      holdings: [
        { playerId: 1, purchasePrice: 50 },
        { playerId: 2, purchasePrice: 48 },
      ],
      bank: 10,
      fifteen: [2, 3],
      currentPrice: price,
    });
    expect(result.bank).toBe(10 + 51 - 60);
    expect(result.moves).toEqual([{ in: 3, out: 1 }]);
    expect(result.holdings).toContainEqual({ playerId: 3, purchasePrice: 60 });
    // A kept player keeps what was paid for him, not today's price.
    expect(result.holdings).toContainEqual({ playerId: 2, purchasePrice: 48 });
  });

  it("refuses to record a squad the budget does not allow", () => {
    // At current prices this would be affordable (53 + 0 ≥ 60 − 7); at the
    // selling price it is not. The difference is exactly the accounting error
    // that would let the shadow win on money it never had.
    expect(() =>
      settleSquad({
        holdings: [{ playerId: 1, purchasePrice: 50 }],
        bank: 7,
        fifteen: [3],
        currentPrice: price,
      }),
    ).toThrow(/overspends/);
  });

  it("changes nothing on a roll", () => {
    const result = settleSquad({
      holdings: [{ playerId: 4, purchasePrice: 45 }],
      bank: 3,
      fifteen: [4],
      currentPrice: price,
    });
    expect(result.moves).toEqual([]);
    expect(result.bank).toBe(3);
  });
});

describe("lineUp", () => {
  it("puts the reserve keeper first on the bench, then outfielders by projection", () => {
    const squad = [
      { id: 1, position: POSITION.GK, ep: 4 },
      { id: 2, position: POSITION.GK, ep: 3 },
      ...[3, 4, 5, 6, 7].map((id) => ({ id, position: POSITION.DEF, ep: 10 - id })),
      ...[8, 9, 10, 11, 12].map((id) => ({ id, position: POSITION.MID, ep: 20 - id })),
      ...[13, 14, 15].map((id) => ({ id, position: POSITION.FWD, ep: 30 - id })),
    ];
    const { starting, bench } = lineUp(squad);
    expect(starting).toHaveLength(11);
    expect(bench[0].position).toBe(POSITION.GK);
    const outfield = bench.slice(1).map((p) => p.ep);
    expect(outfield).toEqual([...outfield].sort((a, b) => b - a));
  });
});

describe("pairWeeks", () => {
  const manager = [
    { event: 4, points: 71, event_transfers_cost: 0 },
    { event: 5, points: 60, event_transfers_cost: 4 },
    { event: 6, points: 50, event_transfers_cost: 0 },
  ];

  it("pairs scored engine weeks, each side net of its own hits", () => {
    const pairs = pairWeeks(
      [{ gw: 5, origin: "engine", points: 62, hitCost: 4 }],
      manager,
    );
    expect(pairs).toEqual([{ gw: 5, shadow: 58, manager: 56 }]);
  });

  it("never scores the seed, which both sides own", () => {
    expect(
      pairWeeks([{ gw: 4, origin: "seed", points: 71, hitCost: 0 }], manager),
    ).toEqual([]);
  });

  it("skips a week not yet scored rather than treating it as zero", () => {
    expect(
      pairWeeks([{ gw: 6, origin: "engine", points: null, hitCost: 0 }], manager),
    ).toEqual([]);
  });
});

describe("shadowVerdict", () => {
  it("has nothing to say before a week is scored", () => {
    expect(shadowVerdict([]).reading).toBe("no-data");
  });

  it("will not read one week as a verdict", () => {
    expect(shadowVerdict([{ gw: 5, shadow: 80, manager: 50 }]).reading).toBe("too-few");
  });

  it("calls a small, noisy lead noise", () => {
    const verdict = shadowVerdict([
      { gw: 5, shadow: 60, manager: 50 },
      { gw: 6, shadow: 40, manager: 48 },
      { gw: 7, shadow: 55, manager: 52 },
    ]);
    expect(verdict.gap).toBe(5);
    expect(verdict.reading).toBe("noise");
  });

  it("calls a consistent lead a lead", () => {
    const verdict = shadowVerdict([
      { gw: 5, shadow: 60, manager: 50 },
      { gw: 6, shadow: 62, manager: 50 },
      { gw: 7, shadow: 59, manager: 50 },
      { gw: 8, shadow: 61, manager: 50 },
    ]);
    expect(verdict.reading).toBe("engine-ahead");
  });

  it("runs the cumulative gap and widens the band with √weeks", () => {
    const verdict = shadowVerdict([
      { gw: 6, shadow: 40, manager: 48 },
      { gw: 5, shadow: 60, manager: 50 },
    ]);
    // Sorted by gameweek before accumulating.
    expect(verdict.weeks.map((w) => w.cumulative)).toEqual([10, 2]);
    const [first, second] = verdict.weeks.map((w) => w.band!);
    expect(second / first).toBeCloseTo(Math.SQRT2);
  });
});
