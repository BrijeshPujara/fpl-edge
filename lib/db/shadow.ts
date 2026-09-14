import "server-only";

import type { Db } from "./client";
import { fetchAll } from "./queries";
import type { Tables } from "./types.generated";
import type { Move } from "./decisions";
import type { ShadowPick } from "@/lib/shadow/plan";

/**
 * Reading the shadow manager. Writing it is `sync-shadow.ts`.
 */

export type ShadowSquadRow = Tables<"shadow_squads">;

export interface ShadowWeek {
  row: ShadowSquadRow;
  picks: ShadowPick[];
  moves: Move[];
}

/** Every shadow week for a manager, oldest first. */
export async function getShadowWeeks(
  db: Db,
  entryId: number,
): Promise<ShadowWeek[]> {
  const { data, error } = await db
    .from("shadow_squads")
    .select("*")
    .eq("entry_id", entryId)
    .order("gw", { ascending: true });

  if (error) throw new Error(`Failed to read shadow squads: ${error.message}`);

  // Both jsonb columns are written only by `sync-shadow`, from typed values,
  // so they are read back as those types rather than re-validated.
  return (data ?? []).map((row) => ({
    row,
    picks: row.picks as unknown as ShadowPick[],
    moves: row.moves as unknown as Move[],
  }));
}

/**
 * Points and minutes per player for a checked gameweek.
 *
 * Summed across fixtures, so a double gameweek is one entry. An empty map
 * means the gameweek has not been checked yet — `syncResults` writes nothing
 * until FPL sets `data_checked` — and must be read as "not yet", never as a
 * week in which everyone scored zero.
 */
export async function getGameweekResults(
  db: Db,
  gw: number,
): Promise<Map<number, { points: number; minutes: number }>> {
  const rows = await fetchAll<{
    player_id: number;
    total_points: number;
    minutes: number;
  }>(
    (from, to) =>
      db
        .from("player_gw_stats")
        .select("player_id, total_points, minutes")
        .eq("gw", gw)
        .order("player_id", { ascending: true })
        .order("fixture_id", { ascending: true })
        .range(from, to),
    `gameweek ${gw} results`,
  );

  const results = new Map<number, { points: number; minutes: number }>();
  for (const row of rows) {
    const existing = results.get(row.player_id) ?? { points: 0, minutes: 0 };
    results.set(row.player_id, {
      points: existing.points + row.total_points,
      minutes: existing.minutes + row.minutes,
    });
  }
  return results;
}
