import { describe, expect, it } from "vitest";
import {
  freeTransfersFor,
  freeTransfersForStorage,
  type TransferHistoryEntry,
} from "@/lib/engine/free-transfers";

const gw = (
  event: number,
  eventTransfers: number,
  chip: string | null = null,
): TransferHistoryEntry => ({ event, eventTransfers, chip });

/** Convenience: assert a plain count. */
function count(result: ReturnType<typeof freeTransfersFor>): number {
  if (result.kind !== "count") {
    throw new Error(`expected a count, got ${result.kind}`);
  }
  return result.value;
}

describe("freeTransfersFor", () => {
  it("is unlimited before the first deadline", () => {
    expect(freeTransfersFor(1, [])).toEqual({ kind: "unlimited" });
  });

  it("gives exactly one for GW2, whatever happened in GW1", () => {
    // GW1 transfers are unlimited squad-building and consume nothing.
    expect(count(freeTransfersFor(2, [gw(1, 12)]))).toBe(1);
  });

  it("banks an unused transfer", () => {
    // GW2 used none, so GW3 has the rolled one plus the new one.
    expect(count(freeTransfersFor(3, [gw(1, 0), gw(2, 0)]))).toBe(2);
  });

  it("spends the balance down", () => {
    // GW2: 1 available, 1 used -> 0 left, +1 for GW3.
    expect(count(freeTransfersFor(3, [gw(2, 1)]))).toBe(1);
  });

  it("caps the bank at five", () => {
    // Eight quiet gameweeks would bank eight without the ceiling.
    const quiet = Array.from({ length: 9 }, (_, i) => gw(i + 1, 0));
    expect(count(freeTransfersFor(10, quiet))).toBe(5);
  });

  it("never goes negative when hits are taken", () => {
    // 1 free, 3 transfers made: two of them cost 4 points each. The balance
    // floors at zero — hits are bought with points, not borrowed from next week.
    expect(count(freeTransfersFor(3, [gw(2, 3)]))).toBe(1);
  });

  it("carries the balance through a wildcard", () => {
    // 3 banked going into GW4. The wildcard's 9 transfers are free and leave
    // the bank untouched, so GW5 is those 3 plus its own allowance.
    const history = [gw(2, 0), gw(3, 0), gw(4, 9, "wildcard")];
    expect(count(freeTransfersFor(5, history))).toBe(4);
  });

  it("carries the balance through a free hit", () => {
    const history = [gw(2, 0), gw(3, 0), gw(4, 11, "freehit")];
    expect(count(freeTransfersFor(5, history))).toBe(4);
  });

  it("charges a wildcard week's transfers if the chip is absent", () => {
    // The contrast case for the two above: same 9 transfers, no chip, so the
    // bank is emptied and GW5 has only its own allowance.
    const history = [gw(2, 0), gw(3, 0), gw(4, 9, null)];
    expect(count(freeTransfersFor(5, history))).toBe(1);
  });

  it("does NOT exempt bench boost or triple captain", () => {
    // These are team chips; they do not make transfers free.
    const history = [gw(2, 0), gw(3, 2, "bboost")];
    // GW3: 2 banked, 2 spent -> 0, +1 for GW4.
    expect(count(freeTransfersFor(4, history))).toBe(1);
  });

  it("treats a missing gameweek as no transfers made", () => {
    // A gap in the history must not be read as a spend.
    expect(count(freeTransfersFor(4, [gw(2, 0)]))).toBe(3);
  });

  it("ignores history at or beyond the target gameweek", () => {
    const history = [gw(2, 0), gw(3, 0), gw(4, 5), gw(5, 5)];
    // Only GW2 and GW3 count toward GW4's balance.
    expect(count(freeTransfersFor(4, history))).toBe(3);
  });

  it("is insensitive to history ordering", () => {
    const forwards = [gw(2, 1), gw(3, 0), gw(4, 0)];
    const backwards = [...forwards].reverse();
    expect(count(freeTransfersFor(5, backwards))).toBe(
      count(freeTransfersFor(5, forwards)),
    );
  });
});

describe("freeTransfersForStorage", () => {
  it("stores unlimited as the cap", () => {
    expect(freeTransfersForStorage({ kind: "unlimited" })).toBe(5);
  });

  it("stores a count as itself", () => {
    expect(freeTransfersForStorage({ kind: "count", value: 2 })).toBe(2);
  });
});
