import { describe, expect, it } from "vitest";
import { scoreFinalGameweek, type FinalPick } from "@/lib/engine/auto-subs";
import { sellingPrice } from "@/lib/engine/selling-price";
import { CHIP, POSITION, type PositionId } from "@/lib/rules";

/**
 * A legal 3-4-3 with a bench of GK, DEF, MID, FWD. Everyone plays and scores 2
 * unless a test says otherwise; player ids equal their slot.
 */
function squad(over: Record<number, Partial<FinalPick>> = {}): FinalPick[] {
  const shape: PositionId[] = [
    POSITION.GK,
    POSITION.DEF, POSITION.DEF, POSITION.DEF,
    POSITION.MID, POSITION.MID, POSITION.MID, POSITION.MID,
    POSITION.FWD, POSITION.FWD, POSITION.FWD,
    POSITION.GK, POSITION.DEF, POSITION.MID, POSITION.FWD,
  ];
  return shape.map((position, i) => ({
    playerId: i + 1,
    slot: i + 1,
    position,
    played: true,
    points: 2,
    isCaptain: i + 1 === 9,
    isVice: i + 1 === 10,
    ...over[i + 1],
  }));
}

describe("scoreFinalGameweek", () => {
  it("doubles the captain", () => {
    // Eleven starters at 2, captain's 2 counted again.
    expect(scoreFinalGameweek(squad(), null).total).toBe(24);
  });

  it("brings the bench on in order, and only where the formation stays legal", () => {
    // A defender misses. The first outfield bench player is the DEF in slot 13
    // (the keeper in 12 cannot cover an outfielder), and a 3-4-3 needs three
    // defenders, so only a defender keeps it legal.
    const result = scoreFinalGameweek(
      squad({ 2: { played: false, points: 0 }, 13: { points: 7 } }),
      null,
    );
    expect(result.autoSubs).toBe(1);
    // 24 with everyone playing, less the missing defender's 2, plus the sub's 7.
    expect(result.total).toBe(24 - 2 + 7);
  });

  it("gives the armband to the vice only when the captain did not play", () => {
    const result = scoreFinalGameweek(
      squad({ 9: { played: false, points: 0 }, 10: { points: 6 } }),
      null,
    );
    expect(result.armband).toBe(10);
  });

  it("gives the armband to nobody if neither captain played, never to a sub", () => {
    const result = scoreFinalGameweek(
      squad({
        9: { played: false, points: 0 },
        10: { played: false, points: 0 },
        13: { played: false, points: 0 },
        14: { played: false, points: 0 },
        15: { points: 9 },
      }),
      null,
    );
    expect(result.armband).toBeNull();
    // Forward 15 subs in for one of them and counts once, not doubled. The
    // other nine starters score 2 each.
    expect(result.total).toBe(9 * 2 + 9);
  });

  it("counts all fifteen under Bench Boost and substitutes nobody", () => {
    const result = scoreFinalGameweek(squad({ 2: { played: false, points: 0 } }), CHIP.benchBoost);
    expect(result.autoSubs).toBe(0);
    expect(result.total).toBe(14 * 2 + 2);
  });

  it("triples the captain under Triple Captain", () => {
    expect(scoreFinalGameweek(squad({ 9: { points: 10 } }), CHIP.tripleCaptain).total).toBe(
      10 * 2 + 10 * 3,
    );
  });
});

describe("sellingPrice", () => {
  it("keeps half a rise, rounded down", () => {
    expect(sellingPrice(50, 53)).toBe(51);
    expect(sellingPrice(50, 54)).toBe(52);
  });

  it("bears a fall in full", () => {
    expect(sellingPrice(50, 48)).toBe(48);
  });

  it("pays the purchase price when nothing moved", () => {
    expect(sellingPrice(50, 50)).toBe(50);
  });
});
