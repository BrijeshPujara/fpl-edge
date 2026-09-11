import { describe, expect, it } from "vitest";
import {
  compareCaptain,
  compareTransfer,
} from "@/lib/db/journal-comparison";
import type { DecisionRow } from "@/lib/db/decisions";

function decision(over: Partial<DecisionRow> = {}): DecisionRow {
  return {
    id: "d1",
    entry_id: 1,
    gw: 3,
    kind: "captain",
    player_in: 10,
    player_out: null,
    predicted_ep: 7,
    alternatives: [],
    rationale: "",
    source: "engine",
    created_at: "2026-08-28T00:00:00Z",
    ...over,
  } as DecisionRow;
}

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
      [{ inId: 20, outId: 21 }],
      points({ 10: 6, 11: 1, 20: 8, 21: 7 }),
    );
    expect(result.engineChoice?.points).toBe(5);
    expect(result.managerChoice?.points).toBe(1);
    expect(result.delta).toBe(4);
  });

  it("sums several manager moves against the engine's one", () => {
    const result = compareTransfer(
      decision({ kind: "transfer", player_in: 10, player_out: 11 }),
      [
        { inId: 20, outId: 21 },
        { inId: 22, outId: 23 },
      ],
      points({ 10: 6, 11: 1, 20: 2, 21: 5, 22: 4, 23: 1 }),
    );
    // Manager swing: (2-5) + (4-1) = 0. Engine: +5.
    expect(result.managerChoice?.points).toBe(0);
    expect(result.delta).toBe(5);
  });

  it("treats holding as a real position worth zero, not as missing data", () => {
    // The engine advised a hold and the manager transferred. Holding buys a
    // swing of zero, which is scoreable — dropping the row would hide a week
    // where the advice was to do nothing and doing nothing was right.
    const result = compareTransfer(
      decision({ kind: "hold", player_in: null, player_out: null }),
      [{ inId: 20, outId: 21 }],
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
      [],
      points({}),
    );
    expect(result.delta).toBe(0);
    expect(result.note).toBe("both held");
  });

  it("refuses to score when one of the manager's moves has no result", () => {
    const result = compareTransfer(
      decision({ kind: "transfer", player_in: 10, player_out: 11 }),
      [{ inId: 20, outId: 99 }],
      points({ 10: 6, 11: 1, 20: 2 }),
    );
    expect(result.delta).toBeNull();
  });
});
