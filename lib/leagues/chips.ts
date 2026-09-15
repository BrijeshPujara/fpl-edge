import { CHIP, type ChipName } from "@/lib/rules";

/**
 * What a rival did in a gameweek: which chip, and how many points in hits.
 *
 * Neither is in a standings row — FPL's league table carries only points and
 * ranks — so both come from each manager's own history. Pure over that
 * payload, so the table logic can be tested without the network.
 */

export const CHIP_SHORT: Record<ChipName, string> = {
  [CHIP.wildcard]: "WC",
  [CHIP.freeHit]: "FH",
  [CHIP.benchBoost]: "BB",
  [CHIP.tripleCaptain]: "TC",
};

/**
 * The two-letter label for a chip.
 *
 * An unrecognised chip is labelled from its own name rather than dropped. FPL
 * has added chips before; a new one rendering as "no chip" would be a quiet
 * wrong answer, where a slightly odd label is a visible one.
 */
export function chipShort(name: string): string {
  return CHIP_SHORT[name as ChipName] ?? name.slice(0, 2).toUpperCase();
}

export interface ManagerWeek {
  /** The chip's API name, or null when none was played. */
  chip: string | null;
  /** Points deducted for transfers that gameweek. */
  hits: number;
}

export function managerWeek(
  history: {
    current: { event: number; event_transfers_cost: number }[];
    chips: { name: string; event: number }[];
  },
  gw: number,
): ManagerWeek {
  return {
    chip: history.chips.find((c) => c.event === gw)?.name ?? null,
    hits: history.current.find((r) => r.event === gw)?.event_transfers_cost ?? 0,
  };
}
