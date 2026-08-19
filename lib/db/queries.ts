import "server-only";

import type { Db } from "./client";
import type { Tables } from "./types.generated";

/**
 * Read-side queries.
 *
 * Thin: these fetch rows and nothing else. Shaping them into something a screen
 * can render happens in `lib/squad/view.ts`, which is pure and therefore
 * testable without a database.
 */

export type PlayerRow = Tables<"players">;
export type TeamRow = Tables<"teams">;
export type FixtureRow = Tables<"fixtures">;
export type SquadRow = Tables<"squads">;
export type SquadPickRow = Tables<"squad_picks">;

export interface SquadWithPicks {
  squad: SquadRow;
  picks: SquadPickRow[];
}

/**
 * The most recent squad at or before a gameweek.
 *
 * Returns null when nothing has been synced — the state before the first
 * deadline, and one every caller has to handle rather than assume away.
 */
export async function getLatestSquad(
  db: Db,
  upToGw: number,
): Promise<SquadWithPicks | null> {
  const { data: squad, error } = await db
    .from("squads")
    .select("*")
    .lte("gw", upToGw)
    .order("gw", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to read squad: ${error.message}`);
  if (!squad) return null;

  const { data: picks, error: picksError } = await db
    .from("squad_picks")
    .select("*")
    .eq("squad_id", squad.id)
    .order("position", { ascending: true });

  if (picksError) {
    throw new Error(`Failed to read squad picks: ${picksError.message}`);
  }

  return { squad, picks: picks ?? [] };
}

export async function getPlayersByIds(
  db: Db,
  ids: number[],
): Promise<PlayerRow[]> {
  if (ids.length === 0) return [];
  const { data, error } = await db.from("players").select("*").in("id", ids);
  if (error) throw new Error(`Failed to read players: ${error.message}`);
  return data ?? [];
}

export async function getTeams(db: Db): Promise<TeamRow[]> {
  const { data, error } = await db.from("teams").select("*");
  if (error) throw new Error(`Failed to read teams: ${error.message}`);
  return data ?? [];
}

/**
 * Fixtures from a gameweek forward, for the difficulty strips.
 *
 * Unscheduled fixtures (gw is null, from postponements) are excluded — they
 * cannot be placed on a strip, and including them would silently shift every
 * subsequent fixture into the wrong column.
 */
export async function getFixturesFrom(
  db: Db,
  fromGw: number,
  throughGw: number,
): Promise<FixtureRow[]> {
  const { data, error } = await db
    .from("fixtures")
    .select("*")
    .gte("gw", fromGw)
    .lte("gw", throughGw)
    .not("gw", "is", null)
    .order("gw", { ascending: true });

  if (error) throw new Error(`Failed to read fixtures: ${error.message}`);
  return data ?? [];
}

/**
 * Per-gameweek history for a set of players, most recent first.
 *
 * Empty until gameweeks have been played. The expected-points model handles
 * that by falling back to its no-history priors, so callers do not need to
 * special-case it — but they should not present the result as a confident
 * projection either.
 */
export async function getRecentStats(
  db: Db,
  playerIds: number[],
  sinceGw: number,
): Promise<Tables<"player_gw_stats">[]> {
  if (playerIds.length === 0) return [];
  const { data, error } = await db
    .from("player_gw_stats")
    .select("*")
    .in("player_id", playerIds)
    .gte("gw", sinceGw)
    .order("gw", { ascending: false });

  if (error) throw new Error(`Failed to read player stats: ${error.message}`);
  return data ?? [];
}
