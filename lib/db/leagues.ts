import "server-only";

import type { FplEntryLeague } from "@/lib/fpl/schemas";
import type { Db } from "./client";
import type { Tables, TablesInsert } from "./types.generated";

/**
 * Mini-leagues.
 *
 * There is no configuration step and there should not be one. `entry/{id}/`
 * already lists every league a manager belongs to, and the app already fetches
 * that payload to register them — so joining a league on the FPL site is the
 * whole setup, and it has already happened.
 */

export type LeagueRow = Tables<"leagues">;

/** A league with this manager's position in it. */
export interface LeagueMembership {
  league: LeagueRow;
  rank: number | null;
  lastRank: number | null;
  /** True for a league someone joined, false for one the game enrolled them in. */
  isPrivate: boolean;
}

/** `league_type` as the API reports it. */
export const LEAGUE_TYPE = { private: "x", system: "s" } as const;

export function isPrivateLeague(league: { league_type: string }): boolean {
  return league.league_type === LEAGUE_TYPE.private;
}

/**
 * A rank of zero is not a rank.
 *
 * The API reports 0 for every league before a gameweek has been scored. Stored
 * as a number it sorts to the top and reads as first place, which is a lie the
 * moment anyone glances at the screen.
 */
function rankOrNull(value: number | null | undefined): number | null {
  return value === null || value === undefined || value <= 0 ? null : value;
}

/**
 * Record the leagues from an entry payload.
 *
 * Upserts rather than replaces: a league is shared between everyone in it, so
 * two managers registering the same mini-league must converge on one row rather
 * than fight over it.
 */
export async function saveEntryLeagues(
  db: Db,
  entryId: number,
  leagues: FplEntryLeague[],
): Promise<number> {
  if (leagues.length === 0) return 0;

  const now = new Date().toISOString();

  const leagueRows: TablesInsert<"leagues">[] = leagues.map((league) => ({
    id: league.id,
    name: league.name,
    league_type: league.league_type,
    scoring: league.scoring,
    start_event: league.start_event,
    updated_at: now,
  }));

  const { error: leagueError } = await db
    .from("leagues")
    .upsert(leagueRows, { onConflict: "id" });
  if (leagueError) {
    throw new Error(`Failed to save leagues: ${leagueError.message}`);
  }

  const memberships: TablesInsert<"league_memberships">[] = leagues.map(
    (league) => ({
      league_id: league.id,
      entry_id: entryId,
      entry_rank: rankOrNull(league.entry_rank),
      entry_last_rank: rankOrNull(league.entry_last_rank),
      updated_at: now,
    }),
  );

  const { error: membershipError } = await db
    .from("league_memberships")
    .upsert(memberships, { onConflict: "league_id,entry_id" });
  if (membershipError) {
    throw new Error(`Failed to save memberships: ${membershipError.message}`);
  }

  return leagues.length;
}

/**
 * A manager's leagues, private ones first.
 *
 * Ordering is the whole presentation decision. A manager is in five global
 * leagues they never chose and a handful they did, and the ones they chose are
 * the only ones they care about — so "Overall" never appears above the league
 * they run with their friends.
 */
export async function getEntryLeagues(
  db: Db,
  entryId: number,
): Promise<LeagueMembership[]> {
  const { data, error } = await db
    .from("league_memberships")
    .select("entry_rank, entry_last_rank, leagues (*)")
    .eq("entry_id", entryId);

  if (error) throw new Error(`Failed to read leagues: ${error.message}`);

  return (data ?? [])
    .flatMap((row) => {
      const league = row.leagues as LeagueRow | null;
      if (!league) return [];
      return [
        {
          league,
          rank: row.entry_rank,
          lastRank: row.entry_last_rank,
          isPrivate: isPrivateLeague(league),
        },
      ];
    })
    .sort((a, b) => {
      if (a.isPrivate !== b.isPrivate) return a.isPrivate ? -1 : 1;
      // Then smallest first: a league of twelve friends is more interesting
      // than one of nine million, and rank is the only size proxy to hand.
      return (a.rank ?? Infinity) - (b.rank ?? Infinity);
    });
}
