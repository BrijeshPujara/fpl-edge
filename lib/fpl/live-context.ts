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
export interface LiveGameweek {
  elements: FplLiveElement[];
  /** Fixtures in this gameweek that have kicked off. */
  startedFixtures: Set<number>;
  /** True once any fixture has started. */
  anyStarted: boolean;
}

export const getLiveGameweek = cache(
  async (gw: number): Promise<LiveGameweek | null> => {
    const [live, fixtures] = await Promise.all([
      getEventLive(gw, { revalidate: 0 }).catch(() => null),
      getFixtures({ revalidate: 0 }).catch(() => null),
    ]);
    if (!live) return null;

    const started = (fixtures ?? []).filter(
      (f) => f.event === gw && f.started,
    );
    return {
      elements: live.elements,
      startedFixtures: new Set(started.map((f) => f.id)),
      anyStarted: started.length > 0,
    };
  },
);
