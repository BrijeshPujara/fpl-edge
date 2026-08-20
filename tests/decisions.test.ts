import { describe, expect, it } from "vitest";
import { scoreDecision } from "@/lib/db/decisions";

type Decision = Parameters<typeof scoreDecision>[0];

function decision(over: Partial<Decision> = {}): Decision {
  return {
    kind: "captain",
    player_in: 1,
    player_out: null,
    alternatives: [
      { playerId: 2, ep: 5, reason: "" },
      { playerId: 3, ep: 4, reason: "" },
    ] as unknown as Decision["alternatives"],
    ...over,
  };
}

const points = (map: Record<number, number>) => (id: number) =>
  id in map ? map[id] : null;

describe("scoreDecision", () => {
  it("credits a pick that beat every alternative", () => {
    const scored = scoreDecision(decision(), points({ 1: 12, 2: 5, 3: 2 }))!;
    expect(scored.actual_points).toBe(12);
    expect(scored.best_alternative_points).toBe(5);
    expect(scored.delta).toBe(7);
  });

  it("penalises a pick the alternative beat", () => {
    const scored = scoreDecision(decision(), points({ 1: 2, 2: 14, 3: 2 }))!;
    expect(scored.delta).toBe(-12);
  });

  it("scores a bad week with no better option as no mistake", () => {
    // The distinction the screen exists to draw. A captain who scores two
    // when every alternative also scored two made a fine decision.
    const scored = scoreDecision(decision(), points({ 1: 2, 2: 2, 3: 1 }))!;
    expect(scored.actual_points).toBe(2);
    expect(scored.delta).toBe(0);
  });

  it("counts the player sold as an alternative to a transfer", () => {
    // Keeping him was the option not taken, and it is usually the only one
    // that matters.
    const scored = scoreDecision(
      decision({
        kind: "transfer",
        player_in: 1,
        player_out: 9,
        alternatives: [] as unknown as Decision["alternatives"],
      }),
      points({ 1: 3, 9: 11 }),
    )!;
    expect(scored.best_alternative_points).toBe(11);
    expect(scored.delta).toBe(-8);
  });

  it("refuses to score a player with no recorded stats", () => {
    // Guessing zero would credit the engine for avoiding someone who may
    // simply be missing from the sync.
    expect(scoreDecision(decision(), points({ 2: 5 }))).toBeNull();
  });

  it("ignores alternatives with no stats rather than scoring them zero", () => {
    const scored = scoreDecision(decision(), points({ 1: 6, 2: 4 }))!;
    expect(scored.best_alternative_points).toBe(4);
  });

  it("scores against itself when no alternative can be scored", () => {
    // Nothing to compare with is a delta of zero, not a win.
    const scored = scoreDecision(decision(), points({ 1: 9 }))!;
    expect(scored.best_alternative_points).toBe(9);
    expect(scored.delta).toBe(0);
  });

  it("cannot score a hold, which moves nobody", () => {
    expect(
      scoreDecision(
        decision({ kind: "hold", player_in: null, player_out: null }),
        points({ 1: 5 }),
      ),
    ).toBeNull();
  });
});
