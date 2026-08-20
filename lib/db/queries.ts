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

/**
 * Daily transfer snapshots for a set of players, oldest first.
 *
 * Ordered ascending because that is the order differencing wants, though
 * `netTransferDeltas` sorts defensively anyway — a series differenced in the
 * wrong order is silently sign-flipped rather than obviously broken.
 *
 * `lookbackDays` bounds the read: momentum older than a couple of months is
 * noise, and the table grows by ~600 rows a day.
 */
export async function getTransferSnapshots(
  db: Db,
  playerIds: number[],
  lookbackDays: number,
  now: Date = new Date(),
): Promise<Tables<"player_transfer_snapshots">[]> {
  if (playerIds.length === 0) return [];

  const since = new Date(now.getTime() - lookbackDays * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const { data, error } = await db
    .from("player_transfer_snapshots")
    .select("*")
    .in("player_id", playerIds)
    .gte("captured_on", since)
    .order("captured_on", { ascending: true });

  if (error) {
    throw new Error(`Failed to read transfer snapshots: ${error.message}`);
  }
  return data ?? [];
}

/**
 * The active manager count.
 *
 * Null when the row has never been written, which is a real state before the
 * first sync. Callers must not substitute a guess: the price model reads a zero
 * or missing manager count as "no scale information" and reports
 * `confidence: "none"`, which is the correct behaviour and is lost if a
 * plausible-looking default is invented here.
 */
export async function getTotalManagers(db: Db): Promise<number | null> {
  const { data, error } = await db
    .from("game_state")
    .select("total_players")
    .maybeSingle();

  if (error) throw new Error(`Failed to read game state: ${error.message}`);
  return data?.total_players ?? null;
}

/**
 * Every player. The optimiser's candidate pool.
 *
 * Unfiltered on purpose — including the injured and the suspended. Filtering
 * here would silently remove them from "who could I buy", but they still have
 * to appear in "who do I own", and the model already prices unavailability
 * through the minutes projection. One list, one truth.
 */
export async function getAllPlayers(db: Db): Promise<PlayerRow[]> {
  const { data, error } = await db.from("players").select("*");
  if (error) throw new Error(`Failed to read players: ${error.message}`);
  return data ?? [];
}

export interface ChipPlayed {
  gw: number;
  chip: string;
}

/**
 * Chips already used this season, from the stored squad rows.
 *
 * Which SET a chip belonged to is not stored, because it is derivable: the set
 * is whichever window contains the gameweek it was played in. Storing it would
 * be a second copy of a fact the API already reports, free to drift.
 */
export async function getChipsPlayed(db: Db): Promise<ChipPlayed[]> {
  const { data, error } = await db
    .from("squads")
    .select("gw, chip_played")
    .not("chip_played", "is", null)
    .order("gw", { ascending: true });

  if (error) throw new Error(`Failed to read chips played: ${error.message}`);
  return (data ?? [])
    .filter((r): r is { gw: number; chip_played: string } =>
      r.chip_played !== null,
    )
    .map((r) => ({ gw: r.gw, chip: r.chip_played }));
}
