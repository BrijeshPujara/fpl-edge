import { describe, expect, it, vi } from "vitest";
import { isPreviewEnabled, pickSquad } from "@/lib/preview/context";
import type { Candidate } from "@/lib/squad/candidates";
import {
  MAX_PLAYERS_PER_CLUB,
  POSITION,
  POSITION_SHORT,
  SQUAD_BUDGET,
  SQUAD_COMPOSITION,
  SQUAD_SIZE,
  type PositionId,
} from "@/lib/rules";

/**
 * A pool wide enough to build from: several players per position per club,
 * priced across the range the real game uses.
 */
function pool(): Candidate[] {
  const out: Candidate[] = [];
  let id = 1;
  for (const position of Object.values(POSITION)) {
    for (let club = 1; club <= 20; club++) {
      for (let tier = 0; tier < 3; tier++) {
        out.push({
          id: id++,
          name: `P${id}`,
          club: `C${club}`,
          teamId: club,
          position: position as PositionId,
          positionShort: POSITION_SHORT[position as PositionId],
          // £4.0m to £14.0m.
          price: 40 + tier * 50,
          ep: 10 + tier * 5,
          perGameweek: [],
          variance: null,
          pMinutes: 0.9,
          flag: null,
          unavailable: false,
          modelInput: {
            playerId: id,
            position: position as PositionId,
            teamId: club,
            minutes: {
              status: "a",
              chanceOfPlayingNextRound: null,
              recentStarts: [],
              recentMinutes: [],
            },
            recent: [],
            priorSeason: null,
          },
          thisGameweek: [],
        });
      }
    }
  }
  return out;
}

/** Last season's points, highest for the most expensive — as in real life. */
function seasonPoints(candidates: Candidate[]): Map<number, number> {
  return new Map(candidates.map((c) => [c.id, c.price]));
}

describe("isPreviewEnabled", () => {
  it("is off in production", () => {
    // The preview renders invented squads. If this ever returns true in
    // production, fabricated numbers reach a decision tool.
    const original = process.env.NODE_ENV;
    try {
      vi.stubEnv("NODE_ENV", "production");
      expect(isPreviewEnabled()).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      expect(process.env.NODE_ENV).toBe(original);
    }
  });

  it("is on in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(isPreviewEnabled()).toBe(true);
    vi.unstubAllEnvs();
  });
});

describe("pickSquad", () => {
  const candidates = pool();
  const squad = pickSquad(candidates, seasonPoints(candidates));

  it("returns a full fifteen", () => {
    // It once returned fourteen: the budget reserve was computed over only the
    // players with last-season points, which overstates the cheapest possible
    // completion, and the squad ended a forward short.
    expect(squad).toHaveLength(SQUAD_SIZE);
  });

  it("fills every position exactly", () => {
    for (const position of Object.values(POSITION)) {
      expect(
        squad.filter((c) => c.position === position),
      ).toHaveLength(SQUAD_COMPOSITION[position as PositionId]);
    }
  });

  it("stays inside the budget", () => {
    const spend = squad.reduce((sum, c) => sum + c.price, 0);
    expect(spend).toBeLessThanOrEqual(SQUAD_BUDGET);
  });

  it("respects the three-per-club limit", () => {
    const perClub = new Map<number, number>();
    for (const c of squad) {
      perClub.set(c.teamId, (perClub.get(c.teamId) ?? 0) + 1);
    }
    for (const count of perClub.values()) {
      expect(count).toBeLessThanOrEqual(MAX_PLAYERS_PER_CLUB);
    }
  });

  it("never picks the same player twice", () => {
    expect(new Set(squad.map((c) => c.id)).size).toBe(squad.length);
  });

  it("never picks an unavailable player", () => {
    const withInjuries = candidates.map((c, i) =>
      i % 2 === 0 ? { ...c, unavailable: true } : c,
    );
    const built = pickSquad(withInjuries, seasonPoints(withInjuries));
    expect(built.every((c) => !c.unavailable)).toBe(true);
  });

  it("still completes a fifteen when almost nobody has history", () => {
    // Only ten players carry last-season points; the rest are the cheap
    // enablers the fill pass exists for.
    const sparse = new Map(
      candidates.slice(0, 10).map((c) => [c.id, 100] as const),
    );
    const built = pickSquad(candidates, sparse);
    expect(built).toHaveLength(SQUAD_SIZE);
  });

  it("prefers the players who scored most last season", () => {
    // The whole point of picking this way: a squad built on the model's own EP
    // would already be optimal, and /transfers would have nothing to show.
    const spend = squad.reduce((sum, c) => sum + c.price, 0);
    expect(spend).toBeGreaterThan(SQUAD_BUDGET * 0.85);
  });
});
