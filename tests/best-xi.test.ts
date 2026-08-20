import { describe, expect, it } from "vitest";
import { bestXi, type XiPlayer } from "@/lib/engine/best-xi";
import { POSITION, SQUAD_COMPOSITION, STARTING_XI_SIZE } from "@/lib/rules";

type P = XiPlayer;
let nextId = 1;

function squad(eps: Partial<Record<keyof typeof POSITION, number[]>> = {}): P[] {
  nextId = 1;
  const spec: [keyof typeof POSITION, number][] = [
    ["GK", SQUAD_COMPOSITION[POSITION.GK]],
    ["DEF", SQUAD_COMPOSITION[POSITION.DEF]],
    ["MID", SQUAD_COMPOSITION[POSITION.MID]],
    ["FWD", SQUAD_COMPOSITION[POSITION.FWD]],
  ];
  const out: P[] = [];
  for (const [key, count] of spec) {
    const given = eps[key];
    for (let i = 0; i < count; i++) {
      out.push({
        id: nextId++,
        position: POSITION[key],
        ep: given ? given[i] : 3,
      });
    }
  }
  return out;
}

describe("bestXi", () => {
  it("fields eleven and benches four", () => {
    const xi = bestXi(squad());
    expect(xi.starting).toHaveLength(STARTING_XI_SIZE);
    expect(xi.bench).toHaveLength(4);
  });

  it("starts exactly one goalkeeper", () => {
    const xi = bestXi(squad({ GK: [1, 9] }));
    const keepers = xi.starting.filter((p) => p.position === POSITION.GK);
    expect(keepers).toHaveLength(1);
    // The better one, even though he was listed second.
    expect(keepers[0].ep).toBe(9);
  });

  it("picks the formation the players call for, not a default", () => {
    // Five excellent defenders, poor midfielders: the answer is 5-2-3, and a
    // model that assumed 3-5-2 would leave nine points on the bench.
    const xi = bestXi(
      squad({
        DEF: [9, 9, 9, 9, 9],
        MID: [1, 1, 1, 1, 1],
        FWD: [8, 8, 8],
      }),
    );
    expect(xi.formation).toBe("5-2-3");
    expect(xi.starting.filter((p) => p.position === POSITION.DEF)).toHaveLength(5);
  });

  it("finds the other extreme too", () => {
    const xi = bestXi(
      squad({
        DEF: [1, 1, 1, 1, 1],
        MID: [9, 9, 9, 9, 9],
        FWD: [8, 1, 1],
      }),
    );
    expect(xi.formation).toBe("3-5-2");
  });

  it("never breaks the formation bounds", () => {
    // Forwards are worth far more than anyone, but only three may start.
    const xi = bestXi(
      squad({ DEF: [1, 1, 1, 1, 1], MID: [1, 1, 1, 1, 1], FWD: [99, 99, 99] }),
    );
    expect(xi.starting.filter((p) => p.position === POSITION.FWD)).toHaveLength(3);
    expect(
      xi.starting.filter((p) => p.position === POSITION.DEF).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("is optimal — no bench player beats a starter in the same position", () => {
    const xi = bestXi(
      squad({
        GK: [2, 5],
        DEF: [6, 1, 4, 2, 7],
        MID: [3, 8, 1, 5, 2],
        FWD: [4, 9, 1],
      }),
    );
    for (const benched of xi.bench) {
      const worseStarter = xi.starting.find(
        (s) => s.position === benched.position && s.ep < benched.ep,
      );
      expect(worseStarter).toBeUndefined();
    }
  });

  it("splits EP between the eleven and the four with nothing lost", () => {
    const s = squad({
      GK: [2, 5],
      DEF: [6, 1, 4, 2, 7],
      MID: [3, 8, 1, 5, 2],
      FWD: [4, 9, 1],
    });
    const xi = bestXi(s);
    const total = s.reduce((sum, p) => sum + p.ep, 0);
    expect(xi.startingEp + xi.benchEp).toBeCloseTo(total, 10);
  });

  it("names the highest-EP starter as captain", () => {
    const xi = bestXi(squad({ MID: [3, 12, 1, 5, 2] }));
    expect(xi.captain?.ep).toBe(12);
  });

  it("does not captain someone on the bench", () => {
    // A brilliant fourth forward cannot start under any legal shape, so he
    // cannot wear the armband either.
    const xi = bestXi(squad({ FWD: [1, 1, 1] }));
    expect(xi.bench.some((b) => b.id === xi.captain?.id)).toBe(false);
  });

  it("reports honestly when the squad cannot field a legal eleven", () => {
    // Two keepers and nothing else. Returning a nine-man XI with a plausible
    // total would be far worse than saying so.
    const partial: P[] = [
      { id: 1, position: POSITION.GK, ep: 4 },
      { id: 2, position: POSITION.GK, ep: 3 },
    ];
    const xi = bestXi(partial);
    expect(xi.starting).toEqual([]);
    expect(xi.formation).toBe("—");
    expect(xi.captain).toBeNull();
    expect(xi.benchEp).toBe(7);
  });

  it("handles an all-zero squad without crashing", () => {
    const xi = bestXi(squad({ GK: [0, 0], DEF: [0, 0, 0, 0, 0], MID: [0, 0, 0, 0, 0], FWD: [0, 0, 0] }));
    expect(xi.starting).toHaveLength(STARTING_XI_SIZE);
    expect(xi.startingEp).toBe(0);
    expect(xi.captain).not.toBeNull();
  });
});
