import "server-only";

import { unstable_cache } from "next/cache";
import { getDb } from "./client";
import {
  getAllPlayers,
  getFixturesFrom,
  getRecentStats,
  getSeasonHistory,
  getTeams,
  type FixtureRow,
  type PlayerRow,
  type TeamRow,
} from "./queries";
import { loadPriceMomentumInputs } from "./price-momentum";
import { getTeamRatingRows } from "./ratings";

/**
 * The reads that are identical for every manager, cached between requests.
 *
 * Four screens — dashboard, transfers, captain, chips — need the same league
 * data before they can say anything, and each was fetching all of it from
 * scratch on every navigation. Measured against the live database:
 *
 *     getAllPlayers            504ms
 *     getSeasonHistory         336ms
 *     loadPriceMomentumInputs  121ms
 *     getRecentStats           104ms
 *     getTeams                  97ms
 *     getFixturesFrom           84ms
 *     ---
 *     buildCandidatePool        28ms
 *
 * So the lag was never the projections; 599 players project in 28ms. It was
 * six round trips to a remote database, some of them paged into three more.
 * That is a per-navigation cost of well over a second for data that changes
 * only when the sync job runs.
 *
 * WHY THESE AND NOT THE ASSEMBLED POOL. The cache serialises through JSON, and
 * a `Candidate` carries Maps and model inputs that would not survive the round
 * trip. Rows are plain arrays and do, and caching them removes 95% of the cost
 * while leaving every projection computed fresh from the current code — so a
 * change to the model is never served from a stale cache.
 *
 * Nothing per-manager is cached here. Squads, picks and predictions are read
 * uncached, and the live score deliberately so.
 */

/**
 * Long enough to make navigation feel instant, short enough that a sync's
 * results appear without anyone waiting for an invalidation.
 *
 * The sync runs four times a day, so a five minute window means the worst case
 * is a five minute delay on data that was already up to a day old.
 */
const TTL_SECONDS = 300;

/**
 * A cached reader that still works with no cache to read from.
 *
 * `unstable_cache` throws "Invariant: incrementalCache missing" outside a
 * Next.js request — and the sync scripts run in plain Node, importing the same
 * `loadDecisionContext` the screens use. Caching these reads without this
 * wrapper broke the nightly journal job, which is the one process here whose
 * failure is silent and whose output cannot be backfilled.
 *
 * So the cache is treated as an optimisation that may be absent, not as
 * infrastructure that must be present. In a request it caches; in a script it
 * reads through.
 */
function cachedOrDirect<A extends unknown[], T>(
  direct: (...args: A) => Promise<T>,
  keyParts: string[],
): (...args: A) => Promise<T> {
  const cached = unstable_cache(direct, keyParts, {
    revalidate: TTL_SECONDS,
    tags: ["league-data"],
  });

  return async (...args: A) => {
    try {
      return await cached(...args);
    } catch (error) {
      // Only the missing-cache invariant falls through; a real query failure
      // must still surface rather than being retried into the same error.
      if (
        error instanceof Error &&
        error.message.includes("incrementalCache")
      ) {
        return direct(...args);
      }
      throw error;
    }
  };
}

export const cachedPlayers = cachedOrDirect(
  async (): Promise<PlayerRow[]> => getAllPlayers(getDb()),
  ["all-players"],
);

export const cachedTeams = cachedOrDirect(
  async (): Promise<TeamRow[]> => getTeams(getDb()),
  ["all-teams"],
);

/**
 * The fitted team ratings the opponent adjustment runs on.
 *
 * Separate from `cachedTeams` because it is a different table with a different
 * update cadence — the sync refits these after results land, while the team
 * rows change almost never.
 */
export const cachedTeamRatings = cachedOrDirect(
  async () => getTeamRatingRows(getDb()),
  ["team-ratings"],
);

export const cachedFixtures = cachedOrDirect(
  async (from: number, through: number): Promise<FixtureRow[]> =>
    getFixturesFrom(getDb(), from, through),
  ["fixtures-range"],
);

/**
 * Season history for every player.
 *
 * The player CODES are not passed as an argument on purpose. They would make
 * the cache key a 599-element array, so a single transfer-listed player
 * changing the roster would miss the cache entirely — and the query wants the
 * whole table regardless. Fetching the ids inside keeps the key constant.
 */
export const cachedSeasonHistory = cachedOrDirect(
  async () => {
    const db = getDb();
    const players = await getAllPlayers(db);
    return getSeasonHistory(
      db,
      players.map((p) => p.code),
    );
  },
  ["season-history"],
);

export const cachedRecentStats = cachedOrDirect(
  async (fromGw: number) => {
    const db = getDb();
    const players = await getAllPlayers(db);
    return getRecentStats(
      db,
      players.map((p) => p.id),
      fromGw,
    );
  },
  ["recent-stats"],
);

export const cachedPriceMomentum = cachedOrDirect(
  async () => {
    const db = getDb();
    const players = await getAllPlayers(db);
    return loadPriceMomentumInputs(
      db,
      players.map((p) => p.id),
    );
  },
  ["price-momentum"],
);
