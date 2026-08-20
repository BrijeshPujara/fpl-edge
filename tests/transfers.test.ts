import { beforeAll, describe, expect, it } from "vitest";
import { createGlpkSolver } from "@/lib/solver/glpk";
import { suggestTransfers } from "@/lib/engine/transfers";
import { optimiseSquad, type PlayerCandidate } from "@/lib/engine/optimiser";
import type { LpSolver } from "@/lib/engine/lp";
import { POSITION, SQUAD_COMPOSITION, TRANSFER_HIT_COST } from "@/lib/rules";

let solver: LpSolver;
beforeAll(async () => {
  solver = await createGlpkSolver();
});

type Pos = PlayerCandidate["position"];

/**
 * A legal starting fifteen, cheap and mediocre, spread over enough clubs that
 * max-three-per-club never binds.
 */
function currentSquad(): PlayerCandidate[] {
  const squad: PlayerCandidate[] = [];
  let id = 1;
  for (const position of [
    POSITION.GK,
    POSITION.DEF,
    POSITION.MID,
    POSITION.FWD,
  ] as Pos[]) {
    for (let i = 0; i < SQUAD_COMPOSITION[position]; i++) {
      squad.push({
        id: id,
        position,
        teamId: id,
        price: 45,
        ep: 3,
        pMinutes: 0.95,
      });
      id++;
    }
  }
  return squad;
}

/**
 * Replacements, one per position, each strictly better than what is in the
 * squad and affordable. `count` upgrades per position keeps the scenarios
 * separable.
 */
function upgrades(count: number, epStep = 4): PlayerCandidate[] {
  const out: PlayerCandidate[] = [];
  let id = 100;
  for (const position of [
    POSITION.GK,
    POSITION.DEF,
    POSITION.MID,
    POSITION.FWD,
  ] as Pos[]) {
    for (let i = 0; i < count; i++) {
      out.push({
        id: id,
        position,
        // Own club each, so the club rule never becomes the binding constraint.
        teamId: 500 + id,
        price: 45,
        // Descending, so the best upgrade is unambiguous and the second move
        // is genuinely worth less than the first.
        ep: 3 + epStep - i * 0.5,
        pMinutes: 0.95,
      });
      id++;
    }
  }
  return out;
}

describe("suggestTransfers — the retention floor pins the count", () => {
  it("offers every transfer count from zero to the cap", () => {
    // The regression this exists for: each scenario used to solve the identical
    // unconstrained problem and then be filtered by whatever count fell out, so
    // most counts were never surfaced at all.
    const result = suggestTransfers(
      {
        currentSquad: currentSquad(),
        candidates: upgrades(3),
        freeTransfers: 1,
        bank: 0,
      },
      solver,
    );

    const counts = result.options.map((o) => o.transfers).sort();
    expect(counts).toEqual([0, 1, 2, 3]);
  });

  it("always offers the roll", () => {
    const result = suggestTransfers(
      {
        currentSquad: currentSquad(),
        candidates: upgrades(3),
        freeTransfers: 1,
        bank: 0,
      },
      solver,
    );
    const roll = result.options.find((o) => o.transfers === 0);
    expect(roll).toBeDefined();
    expect(roll?.playersIn).toEqual([]);
    expect(roll?.playersOut).toEqual([]);
    expect(roll?.epGain).toBeCloseTo(0, 6);
    expect(roll?.hitCost).toBe(0);
  });

  it("gains more from more transfers, before hits", () => {
    const result = suggestTransfers(
      {
        currentSquad: currentSquad(),
        candidates: upgrades(3),
        freeTransfers: 3,
        bank: 0,
      },
      solver,
    );
    const byCount = new Map(result.options.map((o) => [o.transfers, o]));
    expect(byCount.get(1)!.epGain).toBeGreaterThan(byCount.get(0)!.epGain);
    expect(byCount.get(2)!.epGain).toBeGreaterThan(byCount.get(1)!.epGain);
    expect(byCount.get(3)!.epGain).toBeGreaterThan(byCount.get(2)!.epGain);
  });

  it("moves exactly the players it says it moves", () => {
    const result = suggestTransfers(
      {
        currentSquad: currentSquad(),
        candidates: upgrades(3),
        freeTransfers: 2,
        bank: 0,
      },
      solver,
    );

    for (const option of result.options) {
      expect(option.playersIn).toHaveLength(option.transfers);
      expect(option.playersOut).toHaveLength(option.transfers);
      // In and out are disjoint, and nobody appears twice.
      const ids = [...option.playersIn, ...option.playersOut].map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe("suggestTransfers — hits", () => {
  it("charges four points per transfer beyond the free allowance", () => {
    const result = suggestTransfers(
      {
        currentSquad: currentSquad(),
        candidates: upgrades(3),
        freeTransfers: 1,
        bank: 0,
      },
      solver,
    );
    const byCount = new Map(result.options.map((o) => [o.transfers, o]));
    expect(byCount.get(0)!.hitCost).toBe(0);
    expect(byCount.get(1)!.hitCost).toBe(0);
    expect(byCount.get(2)!.hitCost).toBe(TRANSFER_HIT_COST);
    expect(byCount.get(3)!.hitCost).toBe(TRANSFER_HIT_COST * 2);
  });

  it("nets the hit off the gain", () => {
    const result = suggestTransfers(
      {
        currentSquad: currentSquad(),
        candidates: upgrades(3),
        freeTransfers: 1,
        bank: 0,
      },
      solver,
    );
    for (const option of result.options) {
      expect(option.netGain).toBeCloseTo(option.epGain - option.hitCost, 6);
    }
  });

  it("recommends rolling when no move clears its own hit", () => {
    // Upgrades worth only half a point each, against a four-point hit.
    const result = suggestTransfers(
      {
        currentSquad: currentSquad(),
        candidates: upgrades(3, 0.5),
        freeTransfers: 0,
        bank: 0,
      },
      solver,
    );

    expect(result.recommended.transfers).toBe(0);
    expect(result.shouldRoll).toBe(true);
  });

  it("takes the hit when the gain is worth it", () => {
    const result = suggestTransfers(
      {
        currentSquad: currentSquad(),
        candidates: upgrades(3, 12),
        freeTransfers: 1,
        bank: 0,
      },
      solver,
    );

    expect(result.recommended.transfers).toBeGreaterThan(1);
    expect(result.recommended.hitCost).toBeGreaterThan(0);
    expect(result.shouldRoll).toBe(false);
  });

  it("ranks options by net gain, best first", () => {
    const result = suggestTransfers(
      {
        currentSquad: currentSquad(),
        candidates: upgrades(3),
        freeTransfers: 1,
        bank: 0,
      },
      solver,
    );
    const nets = result.options.map((o) => o.netGain);
    expect([...nets].sort((a, b) => b - a)).toEqual(nets);
    expect(result.recommended).toBe(result.options[0]);
  });
});

describe("suggestTransfers — budget", () => {
  it("respects the bank", () => {
    // Every upgrade costs £2.0m more than the player it replaces, and the bank
    // holds £2.0m — so exactly one is affordable however many are wanted.
    const squad = currentSquad();
    const expensive = upgrades(3).map((p) => ({ ...p, price: 65 }));

    const result = suggestTransfers(
      { currentSquad: squad, candidates: expensive, freeTransfers: 3, bank: 20 },
      solver,
    );

    const budget = squad.reduce((sum, p) => sum + p.price, 0) + 20;
    for (const option of result.options) {
      const cost =
        squad.reduce((sum, p) => sum + p.price, 0) + option.costDelta;
      expect(cost).toBeLessThanOrEqual(budget);
    }
  });
});

describe("optimiseSquad — retention floor", () => {
  const squad = currentSquad();
  const pool = [...squad, ...upgrades(5)];

  it("keeps at least as many of the pool as demanded", () => {
    for (const minRetained of [15, 14, 13, 12]) {
      const solved = optimiseSquad(pool, solver, {
        retentionPool: squad.map((p) => p.id),
        minRetained,
      });
      const kept = [...solved.starting, ...solved.bench].filter((p) =>
        squad.some((s) => s.id === p.id),
      );
      expect(kept.length).toBeGreaterThanOrEqual(minRetained);
    }
  });

  it("is a floor, not an equality — it never forces an unwanted transfer", () => {
    // Everything on offer is worse than what is held, so the best squad under
    // "keep at least 12" is to keep all 15.
    const worse = upgrades(5).map((p) => ({ ...p, ep: 0.1 }));
    const solved = optimiseSquad([...squad, ...worse], solver, {
      retentionPool: squad.map((p) => p.id),
      minRetained: 12,
    });
    const kept = [...solved.starting, ...solved.bench].filter((p) =>
      squad.some((s) => s.id === p.id),
    );
    expect(kept).toHaveLength(15);
  });

  it("is inert when no pool is given", () => {
    const withFloor = optimiseSquad(pool, solver, { minRetained: 14 });
    const without = optimiseSquad(pool, solver);
    // A floor over an empty pool must not silently constrain anything.
    expect(withFloor.objectiveValue).toBeCloseTo(without.objectiveValue, 6);
  });

  it("clamps a floor larger than the pool actually present", () => {
    // Asking to retain 15 when only 10 of them are still candidates must not
    // report infeasible: the other five are gone from the game, not unaffordable.
    const partial = squad.slice(0, 10);
    const solved = optimiseSquad([...squad, ...upgrades(5)], solver, {
      retentionPool: partial.map((p) => p.id),
      minRetained: 15,
    });
    const kept = [...solved.starting, ...solved.bench].filter((p) =>
      partial.some((s) => s.id === p.id),
    );
    expect(kept).toHaveLength(10);
  });
});
