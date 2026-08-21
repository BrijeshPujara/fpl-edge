import { getBootstrapStatic } from "./client";
import type { FplBootstrapStatic } from "./schemas";

/**
 * Fitness flags, read from the API rather than from our own tables.
 *
 * The sync stores `status`, `chance_of_playing_next_round` and `news` once a
 * day. That is fine for prices and fixtures, and badly wrong for availability:
 * flags change continuously — press conferences, warm-ups, late scans — and a
 * flag that appears at midday is invisible here until 02:00 the next morning.
 *
 * Observed: Pedro Porro read `status=a` from a sync at 02:52, while the API
 * said `status=i, chance=0, "Lack of match fitness - Expected back 29 Aug"`.
 * Twenty-one hours in which an injured player looked fully fit — and not only
 * on the badge. `projectMinutes` reads the same fields, so he was projected as
 * a normal starter and remained a legitimate transfer target.
 *
 * The fix costs nothing, which is the embarrassing part: every page already
 * fetches `bootstrap-static` to resolve the gameweek, and that payload carries
 * every player's flag. The fresh data was in memory and being ignored in
 * favour of a day-old copy.
 *
 * This does NOT write back to the database. The stored row is a record of what
 * the sync saw, and the daily history built on it stays honest; this is an
 * overlay applied at read time, which is where freshness actually matters.
 */

export interface Availability {
  status: string;
  chanceOfPlayingNextRound: number | null;
  news: string;
}

export type AvailabilityMap = Map<number, Availability>;

/** Current flags for every player, keyed by FPL id. */
export async function getAvailability(): Promise<AvailabilityMap> {
  // Deliberately not `revalidate: 0`. Flags matter to the minute only in the
  // last hour before a deadline, and every page already pays for this call at
  // its default freshness — making it uncacheable would add a round trip to
  // every navigation to buy fifteen minutes.
  const bootstrap = await getBootstrapStatic().catch(() => null);
  return bootstrap === null ? new Map() : availabilityFrom(bootstrap);
}

/** Pure, so the overlay can be tested without the network. */
export function availabilityFrom(
  bootstrap: Pick<FplBootstrapStatic, "elements">,
): AvailabilityMap {
  return new Map(
    bootstrap.elements.map((element) => [
      element.id,
      {
        status: element.status,
        chanceOfPlayingNextRound: element.chance_of_playing_next_round,
        news: element.news,
      },
    ]),
  );
}

/** A row shape carrying the three fields an overlay replaces. */
export interface Flaggable {
  id: number;
  status: string;
  chance_of_playing_next_round: number | null;
  news: string;
}

/**
 * Replace stored flags with current ones.
 *
 * A player missing from the map keeps what the database had, rather than being
 * treated as available — an absent id means the API did not mention him, and
 * inventing fitness from silence is the failure this exists to prevent.
 */
export function applyAvailability<T extends Flaggable>(
  players: T[],
  availability: AvailabilityMap,
): T[] {
  if (availability.size === 0) return players;

  return players.map((player) => {
    const current = availability.get(player.id);
    if (current === undefined) return player;

    return {
      ...player,
      status: current.status,
      chance_of_playing_next_round: current.chanceOfPlayingNextRound,
      news: current.news,
    };
  });
}
