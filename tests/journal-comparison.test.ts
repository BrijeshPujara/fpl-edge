import { describe, expect, it } from "vitest";
import {
  compareCaptain,
  compareTransfer,
  type ManagerWeek,
} from "@/lib/db/journal-comparison";
import type { DecisionRow } from "@/lib/db/decisions";
import { CHIP } from "@/lib/rules";

function decision(over: Partial<DecisionRow> = {}): DecisionRow {
  return {
    id: "d1",
    entry_id: 1,
    gw: 3,
    kind: "captain",
    player_in: 10,
    player_out: null,
    moves: [],
    hit_cost: 0,
    predicted_ep: 7,
    alternatives: [],
    rationale: "",
    source: "engine",
    created_at: "2026-08-28T00:00:00Z",
    updated_at: "2026-08-28T00:00:00Z",
    ...over,
  } as DecisionRow;
}

/** What the manager did that week. No hit and no chip unless a test says so. */
const week = (
  transfers: { inId: number; outId: number }[] = [],
  over: Partial<ManagerWeek> = {},
): ManagerWeek => ({ transfers, hitCost: 0, chip: null, ...over });

/** Points table for the gameweek being scored. Absent means "no result row". */
const points = (table: Record<number, number>) => (id: number) =>
  id in table ? table[id] : null;

describe("compareCaptain", () => {
  it("doubles both sides, so the delta is in real points", () => {
    // The engine picked 10 (scored 2), the manager picked 20 (scored 9). The
    // armband doubles both, so the gap is 14 and not 7.
    const result = compareCaptain(
      decision({ player_in: 10 }),
      20,
      points({ 10: 2, 20: 9 }),
    );
    expect(result.engineChoice?.points).toBe(4);
    expect(result.managerChoice?.points).toBe(18);
    expect(result.delta).toBe(-14);
  });

  it("says so when both sides picked the same player", () => {
    const result = compareCaptain(
      decision({ player_in: 10 }),
      10,
      points({ 10: 13 }),
    );
    expect(result.delta).toBe(0);
    expect(result.note).toBe("engine and manager agreed");
  });

  it("refuses to score a player with no result row", () => {
    // Guessing zero would credit whichever side avoided someone who may simply
    // be missing from the sync.
    const result = compareCaptain(
      decision({ player_in: 99 }),
      10,
      points({ 10: 5 }),
    );
    expect(result.delta).toBeNull();
    expect(result.note).toBe("a chosen player has no result row");
  });
});

describe("compareTransfer", () => {
  it("scores the SWING, not the incoming player alone", () => {
    // Engine: in 10 (6 pts) for out 11 (1 pt) = +5.
    // Manager: in 20 (8 pts) for out 21 (7 pts) = +1.
    // Comparing only the players bought would say the manager won by 2; the
    // swing says the engine won by 4, and the swing is what a transfer buys.
    const result = compareTransfer(
      decision({ kind: "transfer", player_in: 10, player_out: 11 }),
      week([{ inId: 20, outId: 21 }]),
      points({ 10: 6, 11: 1, 20: 8, 21: 7 }),
    );
    expect(result.engineChoice?.points).toBe(5);
    expect(result.managerChoice?.points).toBe(1);
    expect(result.delta).toBe(4);
  });

  it("sums several manager moves against the engine's one", () => {
    const result = compareTransfer(
      decision({ kind: "transfer", player_in: 10, player_out: 11 }),
      week([
        { inId: 20, outId: 21 },
        { inId: 22, outId: 23 },
      ]),
      points({ 10: 6, 11: 1, 20: 2, 21: 5, 22: 4, 23: 1 }),
    );
    // Manager swing: (2-5) + (4-1) = 0. Engine: +5.
    expect(result.managerChoice?.points).toBe(0);
    expect(result.managerChoice?.moves).toBe(2);
    expect(result.delta).toBe(5);
  });

  it("scores EVERY move in the engine's plan, not just the first", () => {
    // The GW3 bug: "Semenyo, Hughes → Mundle, Mbeumo" was scored as
    // Semenyo → Mundle alone, half the advice against all of the manager's.
    const result = compareTransfer(
      decision({
        kind: "transfer",
        player_in: 10,
        player_out: 11,
        moves: [
          { in: 10, out: 11 },
          { in: 12, out: 13 },
        ],
      }),
      week([{ inId: 20, outId: 21 }]),
      points({ 10: 6, 11: 1, 12: 5, 13: 2, 20: 3, 21: 3 }),
    );
    // Engine: (6-1) + (5-2) = 8. Manager: 0.
    expect(result.engineChoice?.points).toBe(8);
    expect(result.engineChoice?.moves).toBe(2);
    expect(result.delta).toBe(8);
  });

  it("takes hits off both sides", () => {
    // Engine: +5 swing, 4-point hit = +1.
    // Manager: (8-1) + (2-2) = +7 swing, 4-point hit = +3.
    const result = compareTransfer(
      decision({
        kind: "transfer",
        player_in: 10,
        player_out: 11,
        moves: [{ in: 10, out: 11 }],
        hit_cost: 4,
      }),
      week(
        [
          { inId: 20, outId: 21 },
          { inId: 22, outId: 23 },
        ],
        { hitCost: 4 },
      ),
      points({ 10: 6, 11: 1, 20: 8, 21: 1, 22: 2, 23: 2 }),
    );
    expect(result.engineChoice?.points).toBe(1);
    expect(result.managerChoice?.points).toBe(3);
    expect(result.delta).toBe(-2);
  });

  it.each([CHIP.wildcard, CHIP.freeHit])(
    "does not score a %s week against the engine's transfer",
    (chip) => {
      // A rebuild of fifteen outside the transfer rules is a different game
      // from the one the engine advised in. Scoring it would hand the verdict
      // thirteen free moves' worth of swing.
      const result = compareTransfer(
        decision({
          kind: "transfer",
          player_in: 10,
          player_out: 11,
          moves: [{ in: 10, out: 11 }],
        }),
        week(
          [
            { inId: 20, outId: 21 },
            { inId: 22, outId: 23 },
          ],
          { chip },
        ),
        points({ 10: 6, 11: 1, 20: 8, 21: 1, 22: 9, 23: 0 }),
      );
      expect(result.delta).toBeNull();
      expect(result.note).toContain(chip);
    },
  );

  it("refuses a legacy row whose rationale shows more moves than were stored", () => {
    // Written before `moves` existed: the pair is the first swap of two.
    const result = compareTransfer(
      decision({
        kind: "transfer",
        player_in: 10,
        player_out: 11,
        moves: [],
        rationale: "Semenyo, Hughes → Mundle, Mbeumo: 47.9 over 5 gameweeks, free.",
      }),
      week([{ inId: 20, outId: 21 }]),
      points({ 10: 6, 11: 1, 20: 8, 21: 7 }),
    );
    expect(result.delta).toBeNull();
    expect(result.note).toBe("only the first of the engine's moves was recorded");
  });

  it("still scores a legacy row that was a one-move plan", () => {
    const result = compareTransfer(
      decision({
        kind: "transfer",
        player_in: 10,
        player_out: 11,
        moves: [],
        rationale: "Pedro Porro → Guéhi: 17.9 over 5 gameweeks, free.",
      }),
      week([{ inId: 20, outId: 21 }]),
      points({ 10: 6, 11: 1, 20: 8, 21: 7 }),
    );
    expect(result.delta).toBe(4);
  });

  it("agrees when the manager made the same moves in a different order", () => {
    const result = compareTransfer(
      decision({
        kind: "transfer",
        player_in: 10,
        player_out: 11,
        moves: [
          { in: 10, out: 11 },
          { in: 12, out: 13 },
        ],
      }),
      week([
        { inId: 12, outId: 13 },
        { inId: 10, outId: 11 },
      ]),
      points({ 10: 6, 11: 1, 12: 5, 13: 2 }),
    );
    expect(result.delta).toBe(0);
    expect(result.note).toBe("engine and manager agreed");
  });

  it("treats holding as a real position worth zero, not as missing data", () => {
    // The engine advised a hold and the manager transferred. Holding buys a
    // swing of zero, which is scoreable — dropping the row would hide a week
    // where the advice was to do nothing and doing nothing was right.
    const result = compareTransfer(
      decision({ kind: "hold", player_in: null, player_out: null }),
      week([{ inId: 20, outId: 21 }]),
      points({ 20: 1, 21: 7 }),
    );
    expect(result.engineChoice?.points).toBe(0);
    expect(result.managerChoice?.points).toBe(-6);
    expect(result.delta).toBe(6);
    expect(result.note).toBe("engine held");
  });

  it("scores a week where neither side moved", () => {
    const result = compareTransfer(
      decision({ kind: "hold", player_in: null, player_out: null }),
      week(),
      points({}),
    );
    expect(result.delta).toBe(0);
    expect(result.note).toBe("both held");
  });

  it("refuses to score when one of the manager's moves has no result", () => {
    const result = compareTransfer(
      decision({ kind: "transfer", player_in: 10, player_out: 11 }),
      week([{ inId: 20, outId: 99 }]),
      points({ 10: 6, 11: 1, 20: 2 }),
    );
    expect(result.delta).toBeNull();
  });
});
