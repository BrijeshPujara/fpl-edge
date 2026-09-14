import { describe, expect, it } from "vitest";
import { movesOf, recordDecisions, scoreDecision } from "@/lib/db/decisions";
import type { Db } from "@/lib/db/client";

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

  it("scores a multi-move plan against keeping everyone it sold", () => {
    const scored = scoreDecision(
      decision({
        kind: "transfer",
        player_in: 1,
        player_out: 9,
        moves: [
          { in: 1, out: 9 },
          { in: 2, out: 8 },
        ] as unknown as Decision["moves"],
        alternatives: [] as unknown as Decision["alternatives"],
      }),
      points({ 1: 3, 9: 1, 2: 6, 8: 2 }),
    )!;
    // Bought 3 + 6 = 9, sold 1 + 2 = 3.
    expect(scored.actual_points).toBe(9);
    expect(scored.best_alternative_points).toBe(3);
    expect(scored.delta).toBe(6);
  });

  it("refuses a legacy row that recorded only the first swap of several", () => {
    expect(
      scoreDecision(
        decision({
          kind: "transfer",
          player_in: 1,
          player_out: 9,
          rationale: "Semenyo, Hughes → Mundle, Mbeumo: 47.9 over 5 gameweeks, free.",
        }),
        points({ 1: 3, 9: 1 }),
      ),
    ).toBeNull();
  });

  it("takes the hit off the move", () => {
    const scored = scoreDecision(
      decision({
        kind: "transfer",
        player_in: 1,
        player_out: 9,
        hit_cost: 4,
        alternatives: [] as unknown as Decision["alternatives"],
      }),
      points({ 1: 10, 9: 2 }),
    )!;
    expect(scored.actual_points).toBe(6);
    expect(scored.delta).toBe(4);
  });
});

describe("movesOf", () => {
  it("reads a legacy one-move row as the whole plan", () => {
    expect(
      movesOf({ player_in: 1, player_out: 9, moves: [], rationale: "A → B: 3.0" }),
    ).toEqual([{ in: 1, out: 9 }]);
  });

  it("is not fooled by a comma in a captain's rationale", () => {
    // "Haaland — 5.1 expected, 13% chance of a haul." has a comma and no
    // arrow; it must not read as a truncated plan.
    expect(
      movesOf({
        player_in: 1,
        player_out: null,
        rationale: "Haaland — 5.1 expected, 13% chance of a haul.",
      }),
    ).toEqual([]);
  });
});

describe("recordDecisions", () => {
  it("stores the whole plan and stamps every write, not just the first", async () => {
    // `created_at` defaults on insert and an upsert onto an existing row is an
    // update, so it kept the first advice's time beside the last advice's
    // content. `updated_at` has to be sent on every write to mean anything.
    let written: Record<string, unknown>[] = [];
    let options: unknown;
    const db = {
      from: () => ({
        upsert: async (rows: Record<string, unknown>[], opts: unknown) => {
          written = rows;
          options = opts;
          return { error: null };
        },
      }),
    } as unknown as Db;

    const before = Date.now();
    await recordDecisions(db, 7, [
      {
        gw: 5,
        kind: "transfer",
        playerIn: 1,
        playerOut: 9,
        moves: [
          { in: 1, out: 9 },
          { in: 2, out: 8 },
        ],
        hitCost: 4,
        predictedEp: 3,
        alternatives: [],
        rationale: "",
      },
    ]);

    expect(written[0].moves).toEqual([
      { in: 1, out: 9 },
      { in: 2, out: 8 },
    ]);
    expect(written[0].hit_cost).toBe(4);
    expect(Date.parse(written[0].updated_at as string)).toBeGreaterThanOrEqual(before);
    expect(options).toEqual({ onConflict: "entry_id,gw,kind" });
  });
});
