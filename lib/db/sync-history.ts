import "server-only";

import { getElementSummary } from "@/lib/fpl/client";
import type { Db } from "./client";
import { getAllPlayers, getSeasonHistoryCodes } from "./queries";
import type { TablesInsert } from "./types.generated";

/**
 * Pulling completed seasons into `player_season_history`.
 *
 * This is the one job that costs a request per player rather than a request
 * per league. `history_past` is only available from `element-summary/{id}`,
 * which is per-player, so filling six hundred rows means six hundred calls to
 * someone else's server.
 *
 * That is affordable precisely because it almost never needs doing: a
 * completed season does not change. The job runs when a player has no history
 * recorded, and skips everyone who already does — so the first run is six
 * hundred requests and every run after it is a handful, covering January
 * signings and promoted-club players who have arrived since.
 *
 * `force` re-reads everyone, for the once-a-year moment when last season
 * becomes a completed season.
 */

/** Requests in flight at once. Deliberately small — see the note below. */
const CONCURRENCY = 4;

/** Pause between batches, in milliseconds. */
const BATCH_DELAY_MS = 120;

export interface SyncHistoryResult {
  status: "synced";
  /** Players examined this run. */
  considered: number;
  /** Players actually fetched, after skipping those already recorded. */
  fetched: number;
  /** Season rows written. */
  seasons: number;
  /** Players the API refused or that returned nothing usable. */
  failed: number;
}

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function syncHistory(
  db: Db,
  options: { force?: boolean } = {},
): Promise<SyncHistoryResult> {
  const players = await getAllPlayers(db);

  // Who already has history. Keyed on code, because that is what the table is
  // keyed on and what survives FPL renumbering ids between seasons.
  const known = options.force
    ? new Set<number>()
    : await getSeasonHistoryCodes(db);

  const pending = players.filter((p) => !known.has(p.code));

  let seasons = 0;
  let failed = 0;

  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const batch = pending.slice(i, i + CONCURRENCY);

    const results = await Promise.all(
      batch.map(async (player) => {
        // A single player failing is not the job failing. A newly-added id can
        // 404, and one bad row must not cost the other five hundred.
        const summary = await getElementSummary(player.id, {
          revalidate: 0,
        }).catch(() => null);
        return summary?.history_past ?? null;
      }),
    );

    const rows: TablesInsert<"player_season_history">[] = [];
    for (const history of results) {
      if (history === null) {
        failed += 1;
        continue;
      }
      for (const season of history) {
        rows.push({
          // element_code from the payload, not the player id we asked with.
          // They are different numbers and only one of them is stable.
          player_code: season.element_code,
          season_name: season.season_name,
          minutes: season.minutes,
          starts: season.starts,
          goals_scored: season.goals_scored,
          assists: season.assists,
          clean_sheets: season.clean_sheets,
          goals_conceded: season.goals_conceded,
          expected_goals: season.expected_goals ?? null,
          expected_assists: season.expected_assists ?? null,
          defensive_contribution: season.defensive_contribution,
          bonus: season.bonus,
          total_points: season.total_points,
          updated_at: new Date().toISOString(),
        });
      }
    }

    if (rows.length > 0) {
      const { error } = await db
        .from("player_season_history")
        .upsert(rows, { onConflict: "player_code,season_name" });
      if (error) {
        throw new Error(`Failed to write season history: ${error.message}`);
      }
      seasons += rows.length;
    }

    // Politeness, not rate-limit avoidance. Six hundred requests as fast as
    // the event loop can issue them is rude to a service that costs nothing
    // and asks for nothing, and this job has no deadline to meet.
    if (i + CONCURRENCY < pending.length) await sleep(BATCH_DELAY_MS);
  }

  return {
    status: "synced",
    considered: players.length,
    fetched: pending.length,
    seasons,
    failed,
  };
}
