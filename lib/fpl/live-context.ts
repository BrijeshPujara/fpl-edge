import { cache } from "react";
import { getEventLive, getFixtures } from "./client";
import type { FplLiveElement } from "./schemas";

/**
 * This gameweek's live state, fetched once per request.
 *
 * Three places want it — the header readout, the dashboard panel and the squad
 * pitch — and all three read it uncached, because a cached live score is the
 * wrong answer. Without deduplication a single dashboard request made the same
 * two uncached calls to the FPL API three times over.
 *
 * `cache` is per-request, so this removes the duplication without making
 * anything stale: every new request still fetches fresh.
 */
export interface FixtureResult {
  home: number;
  away: number;
  /** True once the match is over. Scores are final at that point. */
  finished: boolean;
}

export interface LiveGameweek {
  elements: FplLiveElement[];
  /** Fixtures in this gameweek that have kicked off. */
  startedFixtures: Set<number>;
  /** True once any fixture has started. */
  anyStarted: boolean;
  /**
   * Scores for every fixture with one, by fixture id.
   *
   * From the API rather than our `fixtures` table, for the same reason fitness
   * flags are: the table is written by a daily sync, so a Friday night result
   * is not in it until Saturday morning. A scoreline board that cannot show
   * last night's score is not a scoreline board.
   */
  results: Map<number, FixtureResult>;
}

export const getLiveGameweek = cache(
  async (gw: number): Promise<LiveGameweek | null> => {
    const [live, fixtures] = await Promise.all([
      getEventLive(gw, { revalidate: 0 }).catch(() => null),
      getFixtures({ revalidate: 0 }).catch(() => null),
    ]);
    if (!live) return null;

    const thisWeek = (fixtures ?? []).filter((f) => f.event === gw);
    const started = thisWeek.filter((f) => f.started);

    const results = new Map<number, FixtureResult>();
    for (const fixture of thisWeek) {
      if (fixture.team_h_score === null || fixture.team_a_score === null) continue;
      results.set(fixture.id, {
        home: fixture.team_h_score,
        away: fixture.team_a_score,
        // `finished_provisional` flips at the final whistle; `finished` lags it
        // by an hour or more. A score does not change in that window — only
        // bonus does — so the earlier flag is the right one for a result.
        finished:
          fixture.finished ||
          (fixture as { finished_provisional?: boolean }).finished_provisional === true,
      });
    }

    return {
      elements: live.elements,
      startedFixtures: new Set(started.map((f) => f.id)),
      anyStarted: started.length > 0,
      results,
    };
  },
);
