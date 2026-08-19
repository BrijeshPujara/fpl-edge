import {
  CHIP,
  FREE_TRANSFERS_PER_GW,
  MAX_BANKED_FREE_TRANSFERS,
} from "@/lib/rules";

/**
 * Free-transfer accounting.
 *
 * The FPL API does not report how many free transfers you have. It reports how
 * many transfers you *made* each gameweek, and the chip you played. The
 * remaining balance has to be reconstructed from that, and it is the number the
 * optimiser needs most — it decides whether a move is free or costs four points.
 *
 * Pure, no I/O. Rules for 2026/27:
 *
 *  - One free transfer per gameweek.
 *  - Unused transfers roll over, banked to a maximum of five.
 *  - Transfers beyond the balance cost points but never push the balance below
 *    zero — you cannot go into debt.
 *  - Wildcard and Free Hit make that week's transfers free AND the banked
 *    balance carries over untouched.
 *  - Before the first deadline transfers are unlimited, so the concept does not
 *    apply at all.
 */

/** One settled gameweek, as reported by `entry/{id}/history/`. */
export interface TransferHistoryEntry {
  event: number;
  /** Transfers made that gameweek, including any that incurred a hit. */
  eventTransfers: number;
  /** The chip played that gameweek, if any. */
  chip: string | null;
}

export type FreeTransfers =
  /** Before the first deadline: no limit applies. */
  | { kind: "unlimited" }
  | { kind: "count"; value: number };

/** Chips that make a gameweek's transfers free and preserve the bank. */
function preservesBalance(chip: string | null): boolean {
  return chip === CHIP.wildcard || chip === CHIP.freeHit;
}

/**
 * Free transfers available for `targetGw`, given every settled gameweek before
 * it.
 *
 * History entries for gameweeks at or after the target are ignored, so this can
 * be called with a full season's history without slicing it first.
 */
export function freeTransfersFor(
  targetGw: number,
  history: TransferHistoryEntry[],
): FreeTransfers {
  // Squad creation is unlimited; the first deadline is what starts the clock.
  if (targetGw <= 1) return { kind: "unlimited" };

  const settled = history
    .filter((entry) => entry.event < targetGw)
    .sort((a, b) => a.event - b.event);

  // Gameweek 2 is the first gameweek with a balance, and it is always one:
  // whatever happened in GW1 was unlimited and consumed nothing.
  let balance = FREE_TRANSFERS_PER_GW;

  // Walk forward from GW2 to the target, applying each settled gameweek's
  // spend and then the following week's allowance.
  for (let gw = 2; gw < targetGw; gw++) {
    const entry = settled.find((e) => e.event === gw);
    const spent =
      entry && !preservesBalance(entry.chip) ? entry.eventTransfers : 0;

    // Hits are extra transfers bought with points, not borrowed against next
    // week's allowance, so the balance floors at zero rather than going
    // negative.
    const remaining = Math.max(0, balance - spent);
    balance = Math.min(MAX_BANKED_FREE_TRANSFERS, remaining + FREE_TRANSFERS_PER_GW);
  }

  return { kind: "count", value: balance };
}

/**
 * The number to store in the database.
 *
 * `squads.free_transfers` is a smallint, so "unlimited" has to be represented
 * somehow. It is stored as the cap, because that is operationally what
 * unlimited means for an optimiser bounded by a 15-man squad — you will never
 * want more than five moves in a week you are not wildcarding.
 */
export function freeTransfersForStorage(value: FreeTransfers): number {
  return value.kind === "unlimited" ? MAX_BANKED_FREE_TRANSFERS : value.value;
}
