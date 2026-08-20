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

/**
 * PostgREST caps a response at 1000 rows by default, and it does so SILENTLY —
 * no error, no flag, just fewer rows than the table holds.
 *
 * That is the worst possible failure mode for this application. Two queries
 * here exceed it: season history (2,039 rows today) and recent gameweek stats
 * (595 players x 6 gameweeks is ~3,570 once a season is running). Both feed
 * the model directly, so a truncated read does not break anything visibly — it
 * just quietly makes every projection worse, for the players who happened to
 * sort last.
 *
 * Found by counting: a query expected to return 506 players' history returned
 * exactly 1000 rows covering 147 of them.
 */
const PAGE_SIZE = 1000;

/**
 * Read every row of a query, a page at a time.
 *
 * `fetchPage` receives an inclusive range and must apply it with `.range()`.
 * Paging stops when a page comes back short, which is the only reliable signal
 * PostgREST gives that there is nothing left.
 */
async function fetchAll<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{
    data: T[] | null;
    error: { message: string } | null;
  }>,
  label: string,
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await fetchPage(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Failed to read ${label}: ${error.message}`);

    const page = data ?? [];
    all.push(...page);
    if (page.length < PAGE_SIZE) return all;
  }
}

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
 * A manager's most recent squad at or before a gameweek.
 *
 * Returns null when nothing has been synced — the state before the first
 * deadline, and one every caller has to handle rather than assume away.
 *
 * `entryId` is required rather than optional. An optional filter on a
 * per-manager table is the kind of thing that works perfectly until there are
 * two managers in it, and then silently returns a stranger's squad.
 */
export async function getLatestSquad(
  db: Db,
  entryId: number,
  upToGw: number,
): Promise<SquadWithPicks | null> {
  const { data: squad, error } = await db
    .from("squads")
    .select("*")
    .eq("entry_id", entryId)
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

  // Paged: six gameweeks across the whole league is roughly 3,570 rows, well
  // past the 1000-row cap. An unpaged read here would silently drop most of
  // the form data the model runs on.
  return fetchAll(
    (from, to) =>
      db
        .from("player_gw_stats")
        .select("*")
        .in("player_id", playerIds)
        .gte("gw", sinceGw)
        .order("gw", { ascending: false })
        .order("player_id", { ascending: true })
        .range(from, to),
    "player stats",
  );
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

  // The largest read in the app once it has run for a while: 595 players by up
  // to 56 days is over 30,000 rows.
  return fetchAll(
    (from, to) =>
      db
        .from("player_transfer_snapshots")
        .select("*")
        .in("player_id", playerIds)
        .gte("captured_on", since)
        .order("captured_on", { ascending: true })
        .order("player_id", { ascending: true })
        .range(from, to),
    "transfer snapshots",
  );
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
export async function getChipsPlayed(
  db: Db,
  entryId: number,
): Promise<ChipPlayed[]> {
  const { data, error } = await db
    .from("squads")
    .select("gw, chip_played")
    .eq("entry_id", entryId)
    .not("chip_played", "is", null)
    .order("gw", { ascending: true });

  if (error) throw new Error(`Failed to read chips played: ${error.message}`);
  return (data ?? [])
    .filter((r): r is { gw: number; chip_played: string } =>
      r.chip_played !== null,
    )
    .map((r) => ({ gw: r.gw, chip: r.chip_played }));
}

export type SeasonHistoryRow = Tables<"player_season_history">;

/**
 * Completed seasons for a set of players, by CODE rather than id.
 *
 * `players.code` is stable across seasons; `players.id` is not. Callers hold
 * ids, so they have to map through the player rows first — which is friction,
 * and the right kind: it is exactly the step that stops last season's rates
 * being attached to whoever inherited a number.
 */
export async function getSeasonHistory(
  db: Db,
  playerCodes: number[],
): Promise<SeasonHistoryRow[]> {
  if (playerCodes.length === 0) return [];

  // Ordered as well as paged. Paging without a stable sort can repeat or skip
  // rows between pages, because the server is free to return them in any order.
  return fetchAll(
    (from, to) =>
      db
        .from("player_season_history")
        .select("*")
        .in("player_code", playerCodes)
        .order("player_code", { ascending: true })
        .order("season_name", { ascending: false })
        .range(from, to),
    "season history",
  );
}

/**
 * The most recent recorded cost per player.
 *
 * Paged, and it has to be. `price_history` grows by a row per player per actual
 * price change — a few thousand a season — and an unpaged read of it degrades
 * in a way that ACCELERATES: a player truncated out of the result looks like a
 * player with no known price, so a snapshot is written for them, which adds a
 * row, which makes the next truncation worse.
 */
export async function getLatestPrices(db: Db): Promise<Map<number, number>> {
  const rows = await fetchAll<{ player_id: number; cost: number }>(
    (from, to) =>
      db
        .from("price_history")
        .select("player_id, cost, recorded_at")
        .order("recorded_at", { ascending: false })
        .order("player_id", { ascending: true })
        .range(from, to),
    "price history",
  );

  // Newest first, so the first row seen for a player is their current price.
  const latest = new Map<number, number>();
  for (const row of rows) {
    if (!latest.has(row.player_id)) latest.set(row.player_id, row.cost);
  }
  return latest;
}

/**
 * Player codes that already have season history recorded.
 *
 * Paged: the table holds over two thousand rows already, so an unpaged read
 * sees under half of them and the "skip players we have" check re-fetches
 * hundreds of players from the FPL API on every run.
 */
export async function getSeasonHistoryCodes(db: Db): Promise<Set<number>> {
  const rows = await fetchAll<{ player_code: number }>(
    (from, to) =>
      db
        .from("player_season_history")
        .select("player_code")
        .order("player_code", { ascending: true })
        .order("season_name", { ascending: false })
        .range(from, to),
    "season history codes",
  );
  return new Set(rows.map((row) => row.player_code));
}

/**
 * Actual points per player for one gameweek, summed across fixtures.
 *
 * Paged, because a double gameweek is two rows per player and roughly 1,200
 * rows in total — over the cap. Summed rather than listed because a captain in
 * a double gameweek is captain for both fixtures.
 */
export async function getGameweekPoints(
  db: Db,
  gw: number,
): Promise<Map<number, number>> {
  const rows = await fetchAll<{ player_id: number; total_points: number }>(
    (from, to) =>
      db
        .from("player_gw_stats")
        .select("player_id, total_points")
        .eq("gw", gw)
        .order("player_id", { ascending: true })
        .order("fixture_id", { ascending: true })
        .range(from, to),
    `gameweek ${gw} points`,
  );

  const points = new Map<number, number>();
  for (const row of rows) {
    points.set(
      row.player_id,
      (points.get(row.player_id) ?? 0) + row.total_points,
    );
  }
  return points;
}
