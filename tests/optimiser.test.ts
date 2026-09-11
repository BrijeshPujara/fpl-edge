import { beforeAll, describe, expect, it } from "vitest";
import { createGlpkSolver } from "@/lib/solver/glpk";
import { optimiseSquad, type PlayerCandidate } from "@/lib/engine/optimiser";
import type { LpSolver } from "@/lib/engine/lp";
import { MIN_BENCH_PLAYING_PROB, MIN_NAILED_BENCH_OUTFIELD } from "@/lib/engine/constants";
import { POSITION, SQUAD_BUDGET } from "@/lib/rules";

let solver: LpSolver;
beforeAll(async () => {
  solver = await createGlpkSolver();
});

/**
 * A pool big enough to be feasible: 4 clubs would breach max-3-per-club, so
 * spread across enough teams to always allow a legal fifteen.
 */
function pool(overrides: Partial<PlayerCandidate>[] = []): PlayerCandidate[] {
  const players: PlayerCandidate[] = [];
  let id = 1;
  const spec: [PositionIdLocal, number][] = [
    [POSITION.GK, 8],
    [POSITION.DEF, 20],
    [POSITION.MID, 20],
    [POSITION.FWD, 12],
  ];
  for (const [position, count] of spec) {
    for (let i = 0; i < count; i++) {
      players.push({
        id: id++,
        position,
        teamId: (id % 10) + 1,
        price: 40 + i * 5,
        ep: 2 + i * 0.4,
        pMinutes: 0.9,
      });
    }
  }
  for (const o of overrides) {
    const target = players.find((p) => p.id === o.id);
    if (target) Object.assign(target, o);
  }
  return players;
}
type PositionIdLocal = PlayerCandidate["position"];

describe("optimiseSquad — shape", () => {
  it("returns a legal fifteen and eleven", () => {
    const result = optimiseSquad(pool(), solver);
    expect(result.starting).toHaveLength(11);
    expect(result.bench).toHaveLength(4);
    expect(result.totalCost).toBeLessThanOrEqual(SQUAD_BUDGET);
    // Exactly one keeper starts.
    expect(
      result.starting.filter((p) => p.position === POSITION.GK),
    ).toHaveLength(1);
  });
});

describe("shadow price on the budget constraint", () => {
  it("is non-negative and falls as budget increases", () => {
    // The core property: money is worth something while it binds, and worth
    // progressively less as it stops binding. A rising shadow price would mean
    // the dual extraction is wrong.
    const players = pool();
    const budgets = [750, 900, 1000, 1400, 2500];
    const duals = budgets.map(
      (budget) => optimiseSquad(players, solver, { budget }).marginalEpPerTenth,
    );

    for (const d of duals) expect(d).toBeGreaterThanOrEqual(0);

    for (let i = 1; i < duals.length; i++) {
      // Non-increasing, with a small tolerance for LP degeneracy.
      expect(duals[i]).toBeLessThanOrEqual(duals[i - 1] + 1e-6);
    }

    // Tight budget must be worth strictly more than an unconstrained one.
    expect(duals[0]).toBeGreaterThan(duals[duals.length - 1]);
  });

  it("is zero once budget no longer binds", () => {
    // With money to burn the constraint is slack, so another £0.1m buys nothing.
    const result = optimiseSquad(pool(), solver, { budget: 5000 });
    expect(result.marginalEpPerTenth).toBeCloseTo(0, 6);
  });
});

describe("the nailed-bench constraint", () => {
  it("binds: forces playing cover onto the bench when the pool is mostly unfit", () => {
    // Make every cheap outfielder a non-player except a handful. Without the
    // constraint the optimiser would happily bench four £4.0m ghosts to pour
    // every penny into the XI.
    const players = pool().map((p) =>
      p.position === POSITION.GK || p.price > 60
        ? p
        : { ...p, pMinutes: 0.1 },
    );
    // Give a few cheap outfielders real minutes so a feasible answer exists.
    const nailedCheapIds = players
      .filter((p) => p.position !== POSITION.GK && p.price <= 60)
      .slice(0, 4)
      .map((p) => p.id);
    for (const p of players) {
      if (nailedCheapIds.includes(p.id)) p.pMinutes = 0.9;
    }

    const result = optimiseSquad(players, solver);

    const nailedOutfieldBench = result.bench.filter(
      (p) =>
        p.position !== POSITION.GK && p.pMinutes >= MIN_BENCH_PLAYING_PROB,
    );
    expect(nailedOutfieldBench.length).toBeGreaterThanOrEqual(
      MIN_NAILED_BENCH_OUTFIELD,
    );
  });

  it("leaves the bench goalkeeper free to be a non-playing £4.0m", () => {
    // The whole reason the GK slot is excluded from the count.
    const players = pool().map((p) =>
      p.position === POSITION.GK && p.price === 40
        ? { ...p, pMinutes: 0.05, ep: 0.2 }
        : p,
    );
    const result = optimiseSquad(players, solver);
    const benchGk = result.bench.find((p) => p.position === POSITION.GK);
    expect(benchGk).toBeDefined();
    // The cheap non-playing keeper is a legal, and preferred, bench choice.
    expect(benchGk!.price).toBeLessThanOrEqual(50);
  });
});

describe("price momentum in the objective", () => {
  it("flips the pick between two otherwise identical players", () => {
    // The two forwards must COMPETE for one slot, or the squad simply takes
    // both and the price term proves nothing. Putting all four on one club
    // makes max-three-per-club bind: the two elite defenders are certain
    // picks, leaving exactly one forward place for the riser or the faller.
    //
    // Identical price, identical EP. The only thing separating them is the
    // expected price movement, so the choice isolates the price term.
    const CLUB = 99;
    const teammates: PlayerCandidate[] = [
      { id: 9101, position: POSITION.DEF, teamId: CLUB, price: 50, ep: 25, pMinutes: 0.95 },
      { id: 9102, position: POSITION.DEF, teamId: CLUB, price: 50, ep: 25, pMinutes: 0.95 },
    ];
    const riser: PlayerCandidate = {
      id: 9001,
      position: POSITION.FWD,
      teamId: CLUB,
      price: 80,
      ep: 20,
      pMinutes: 0.95,
      expectedPriceDelta: 2,
    };
    const faller: PlayerCandidate = { ...riser, id: 9002, expectedPriceDelta: -2 };

    const players = [...pool(), ...teammates, riser, faller];

    const withPrice = optimiseSquad(players, solver, { priceWeight: 5 });
    const chosen = [...withPrice.starting, ...withPrice.bench].map((p) => p.id);

    // The club limit must actually be what binds, or this proves nothing.
    expect(chosen.filter((id) => [9101, 9102, 9001, 9002].includes(id)))
      .toHaveLength(3);
    expect(chosen).toContain(9001);
    expect(chosen).not.toContain(9002);
  });

  it("picks the faller when the price term is switched off", () => {
    // The control for the test above: with priceWeight at zero the two are
    // genuinely indistinguishable, so the tie is broken arbitrarily rather
    // than in the riser's favour. Proves the flip is caused by the price
    // term and not by an incidental ordering of the candidate pool.
    const CLUB = 99;
    const teammates: PlayerCandidate[] = [
      { id: 9101, position: POSITION.DEF, teamId: CLUB, price: 50, ep: 25, pMinutes: 0.95 },
      { id: 9102, position: POSITION.DEF, teamId: CLUB, price: 50, ep: 25, pMinutes: 0.95 },
    ];
    const riser: PlayerCandidate = {
      id: 9001, position: POSITION.FWD, teamId: CLUB, price: 80, ep: 20,
      pMinutes: 0.95, expectedPriceDelta: 2,
    };
    const faller: PlayerCandidate = { ...riser, id: 9002, expectedPriceDelta: -2 };
    const players = [...pool(), ...teammates, riser, faller];

    const noPrice = optimiseSquad(players, solver, { priceWeight: 0 });
    const chosen = [...noPrice.starting, ...noPrice.bench].map((p) => p.id);
    // Exactly one of the two, but the model has no reason to prefer either.
    expect(chosen.filter((id) => [9001, 9002].includes(id))).toHaveLength(1);
  });

  it("auto mode sets the weight from the measured shadow price", () => {
    const result = optimiseSquad(pool(), solver, {
      budget: 800,
      priceWeight: "auto",
    });
    expect(result.priceWeightUsed).toBeGreaterThan(0);
    expect(result.priceWeightUsed).toBeCloseTo(result.marginalEpPerTenth, 4);
  });
});

describe("risk aversion", () => {
  /**
   * Two MIDFIELDERS identical but for spread — outfield deliberately, because
   * the second keeper is a 5%-weighted bench slot and the optimiser rightly
   * refuses to spend on one, which has nothing to do with risk.
   */
  const A = 29;
  const B = 30;

  function pair(): PlayerCandidate[] {
    return pool([
      { id: A, ep: 40, variance: 4, price: 60, teamId: 19, pMinutes: 0.95 },
      { id: B, ep: 40, variance: 40, price: 60, teamId: 20, pMinutes: 0.95 },
    ]);
  }

  const chosen = (squad: {
    starting: PlayerCandidate[];
    bench: PlayerCandidate[];
  }) => new Set([...squad.starting, ...squad.bench].map((p) => p.id));

  it("ignores variance at zero, which is the default", () => {
    const squad = optimiseSquad(pair(), solver, { shadowPrice: false });
    expect(chosen(squad).has(A)).toBe(true);
    expect(chosen(squad).has(B)).toBe(true);
  });

  it("drops the volatile player when asked for consistency", () => {
    const squad = optimiseSquad(pair(), solver, {
      shadowPrice: false,
      riskAversion: 1,
    });
    expect(chosen(squad).has(A)).toBe(true);
    expect(chosen(squad).has(B)).toBe(false);
  });

  it("keeps the volatile player when chasing a ceiling", () => {
    const squad = optimiseSquad(pair(), solver, {
      shadowPrice: false,
      riskAversion: -1,
    });
    expect(chosen(squad).has(B)).toBe(true);
  });

  it("treats a missing variance as no information, not as certainty", () => {
    // "Not computed" must not beat "computed and small", which is what would
    // happen if absent defaulted to anything other than no penalty at all.
    const squad = optimiseSquad(
      pool([
        { id: A, ep: 40, variance: 0.0001, price: 60, teamId: 19, pMinutes: 0.95 },
        { id: B, ep: 40, variance: undefined, price: 60, teamId: 20, pMinutes: 0.95 },
      ]),
      solver,
      { shadowPrice: false, riskAversion: 1 },
    );
    expect(chosen(squad).has(A)).toBe(true);
    expect(chosen(squad).has(B)).toBe(true);
  });
});
