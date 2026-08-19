import "server-only";

import { getBootstrapStatic, getFixtures } from "@/lib/fpl/client";
import type { Db } from "./client";
import type { TablesInsert } from "./types.generated";

/**
 * Syncing FPL reference data into Postgres.
 *
 * Three rules govern everything here:
 *
 *  1. Upsert, never delete-and-reinsert. Player ids are stable across a season
 *     and `player_gw_stats` has foreign keys onto them. Truncating would
 *     cascade away the history this whole project exists to accumulate.
 *  2. Order matters. Teams before players and fixtures, because both reference
 *     teams. Postgres will reject the wrong order, but failing at 3am in a
 *     cron job is a worse way to learn it than a comment.
 *  3. Price history is append-only and deduplicated. A daily snapshot that
 *     records an unchanged price 38 times a month makes the price-change model
 *     harder to write, not easier.
 */

/** Supabase caps a single request body; large tables go up in chunks. */
const CHUNK_SIZE = 500;

async function upsertChunked<T>(
  db: Db,
  table: "teams" | "players" | "fixtures" | "price_history",
  rows: T[],
  onConflict: string,
): Promise<number> {
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const { error } = await db
      .from(table)
      // The generated row types are narrower than this helper's generic; the
      // caller builds them from TablesInsert, so the shape is checked there.
      .upsert(chunk as never, { onConflict });
    if (error) {
      throw new Error(
        `Failed to upsert ${chunk.length} rows into ${table}: ${error.message}`,
      );
    }
  }
  return rows.length;
}

export interface SyncStaticResult {
  teams: number;
  players: number;
  fixtures: number;
  priceSnapshots: number;
  /** The gameweek the API considers current or next, for logging. */
  targetGw: number | null;
}

/**
 * Pull bootstrap-static and fixtures into the database.
 *
 * This is the job behind `/api/cron/sync-static`. It is idempotent: running it
 * twice in a row changes nothing the second time except `updated_at`.
 */
export async function syncStatic(db: Db): Promise<SyncStaticResult> {
  // Bypass the Next data cache — a cron job that syncs a cached copy of the
  // data is a cron job that does nothing.
  const [bootstrap, fixtures] = await Promise.all([
    getBootstrapStatic({ revalidate: 0 }),
    getFixtures({ revalidate: 0 }),
  ]);

  const now = new Date().toISOString();

  const teamRows: TablesInsert<"teams">[] = bootstrap.teams.map((team) => ({
    id: team.id,
    name: team.name,
    short_name: team.short_name,
    strength: team.strength,
    strength_overall_home: team.strength_overall_home,
    strength_overall_away: team.strength_overall_away,
    strength_attack_home: team.strength_attack_home,
    strength_attack_away: team.strength_attack_away,
    strength_defence_home: team.strength_defence_home,
    strength_defence_away: team.strength_defence_away,
    updated_at: now,
  }));

  const playerRows: TablesInsert<"players">[] = bootstrap.elements.map(
    (element) => ({
      id: element.id,
      code: element.code,
      web_name: element.web_name,
      first_name: element.first_name,
      second_name: element.second_name,
      team_id: element.team,
      position: element.element_type,
      now_cost: element.now_cost,
      status: element.status,
      chance_of_playing_next_round: element.chance_of_playing_next_round,
      news: element.news,
      selected_by_percent: element.selected_by_percent,
      updated_at: now,
    }),
  );

  const fixtureRows: TablesInsert<"fixtures">[] = fixtures.map((fixture) => ({
    id: fixture.id,
    gw: fixture.event,
    home_team: fixture.team_h,
    away_team: fixture.team_a,
    kickoff: fixture.kickoff_time,
    started: fixture.started ?? false,
    finished: fixture.finished,
    home_score: fixture.team_h_score,
    away_score: fixture.team_a_score,
    home_difficulty: fixture.team_h_difficulty,
    away_difficulty: fixture.team_a_difficulty,
    updated_at: now,
  }));

  // Teams first: players and fixtures both reference them.
  await upsertChunked(db, "teams", teamRows, "id");
  await Promise.all([
    upsertChunked(db, "players", playerRows, "id"),
    upsertChunked(db, "fixtures", fixtureRows, "id"),
  ]);

  const priceSnapshots = await snapshotPrices(db, bootstrap.elements, now);

  const targetEvent =
    bootstrap.events.find((e) => e.is_next) ??
    bootstrap.events.find((e) => e.is_current) ??
    null;

  return {
    teams: teamRows.length,
    players: playerRows.length,
    fixtures: fixtureRows.length,
    priceSnapshots,
    targetGw: targetEvent?.id ?? null,
  };
}

/**
 * Record a price snapshot for every player whose price has moved.
 *
 * Only changes are stored. The table answers "when did this price change and
 * by how much", and a row per player per day of unchanged price would bury
 * that signal under ~250,000 rows of noise a season.
 */
async function snapshotPrices(
  db: Db,
  elements: { id: number; now_cost: number }[],
  recordedAt: string,
): Promise<number> {
  const { data: latest, error } = await db
    .from("price_history")
    .select("player_id, cost, recorded_at")
    .order("recorded_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to read price history: ${error.message}`);
  }

  // The query returns newest first, so the first row seen per player is the
  // most recent one.
  const lastKnown = new Map<number, number>();
  for (const row of latest ?? []) {
    if (!lastKnown.has(row.player_id)) lastKnown.set(row.player_id, row.cost);
  }

  const changed: TablesInsert<"price_history">[] = elements
    .filter((e) => lastKnown.get(e.id) !== e.now_cost)
    .map((e) => ({
      player_id: e.id,
      cost: e.now_cost,
      recorded_at: recordedAt,
    }));

  if (changed.length === 0) return 0;

  await upsertChunked(db, "price_history", changed, "player_id,recorded_at");
  return changed.length;
}
