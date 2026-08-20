import "server-only";

import { getEntry } from "@/lib/fpl/client";
import type { Db } from "./client";
import type { Tables, TablesInsert } from "./types.generated";
import { saveEntryLeagues } from "./leagues";

/**
 * Registering a manager.
 *
 * Someone types a team id; this is what turns that number into a row. It is
 * the only place the app calls `entry/{id}/`, deliberately — the squad sync
 * gets bank, value and transfer counts from the picks payload instead, so this
 * extra request happens once per manager rather than once per sync.
 */

export type EntryRow = Tables<"entries">;

export interface RegisterResult {
  entry: EntryRow;
  /** True when this manager had never been seen before. */
  created: boolean;
}

/**
 * How long a registration is considered fresh.
 *
 * A team name changes rarely and the FPL API is someone else's server, so
 * re-fetching on every page load would be rude for no benefit. Fifteen minutes
 * is short enough that a rename shows up quickly and long enough that a
 * refreshed page never triggers a second lookup.
 */
export const ENTRY_REFRESH_MS = 15 * 60 * 1000;

export async function getEntryRow(
  db: Db,
  entryId: number,
): Promise<EntryRow | null> {
  const { data, error } = await db
    .from("entries")
    .select("*")
    .eq("id", entryId)
    .maybeSingle();

  if (error) throw new Error(`Failed to read entry: ${error.message}`);
  return data;
}

/**
 * Look a manager up and remember them.
 *
 * Returns null when the FPL API does not recognise the id, which is the normal
 * outcome of a typo and must be reported as "no such team" rather than as a
 * server error — the number came from a person, and people mistype numbers.
 */
export async function registerEntry(
  db: Db,
  entryId: number,
): Promise<RegisterResult | null> {
  const existing = await getEntryRow(db, entryId);

  const fresh =
    existing !== null &&
    Date.now() - Date.parse(existing.last_synced_at) < ENTRY_REFRESH_MS;
  if (fresh && existing) return { entry: existing, created: false };

  const entry = await getEntry(entryId, { revalidate: 0 }).catch(() => null);
  if (entry === null) {
    // An unknown id and an upstream outage look identical from here. If we have
    // seen this manager before, keep them rather than deleting on a bad day.
    return existing ? { entry: existing, created: false } : null;
  }

  const row: TablesInsert<"entries"> = {
    id: entry.id,
    name: entry.name,
    manager_name:
      `${entry.player_first_name} ${entry.player_last_name}`.trim() ||
      "Unknown manager",
    last_synced_at: new Date().toISOString(),
  };

  const { data, error } = await db
    .from("entries")
    .upsert(row, { onConflict: "id" })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`Failed to register entry: ${error?.message ?? "no row"}`);
  }

  // Leagues come free in the same payload, so there is no reason to make
  // anyone type a league id. Head-to-head leagues are recorded alongside
  // classic ones — the app cannot rank them yet, but knowing they exist is
  // better than pretending they do not.
  await saveEntryLeagues(db, entry.id, [
    ...entry.leagues.classic,
    ...entry.leagues.h2h,
  ]);

  return { entry: data, created: existing === null };
}
