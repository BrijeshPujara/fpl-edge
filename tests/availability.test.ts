import { describe, expect, it } from "vitest";
import {
  applyAvailability,
  availabilityFrom,
  type Flaggable,
} from "@/lib/fpl/availability";
import { projectMinutes } from "@/lib/engine/minutes";
import { PLAYER_STATUS } from "@/lib/rules";

const stored = (over: Partial<Flaggable> = {}): Flaggable => ({
  id: 1,
  status: "a",
  chance_of_playing_next_round: null,
  news: "",
  ...over,
});

const element = (
  id: number,
  status: string,
  chance: number | null,
  news: string,
) =>
  ({
    id,
    status,
    chance_of_playing_next_round: chance,
    news,
  }) as never;

describe("current fitness overrides what the sync stored", () => {
  it("replaces a stale available flag with the real one", () => {
    // The case that shipped: Pedro Porro read `status=a` from an overnight
    // sync while the API said injured, chance 0, back on the 29th.
    const map = availabilityFrom({
      elements: [
        element(1, "i", 0, "Lack of match fitness - Expected back 29 Aug"),
      ],
    });
    const [player] = applyAvailability([stored()], map);

    expect(player.status).toBe("i");
    expect(player.chance_of_playing_next_round).toBe(0);
    expect(player.news).toContain("match fitness");
  });

  it("clears a flag that has been lifted", () => {
    // The overlay has to work in both directions, or a recovered player stays
    // unbuyable until the next sync.
    const map = availabilityFrom({ elements: [element(1, "a", null, "")] });
    const [player] = applyAvailability(
      [stored({ status: "i", chance_of_playing_next_round: 0, news: "Knock" })],
      map,
    );

    expect(player.status).toBe("a");
    expect(player.chance_of_playing_next_round).toBeNull();
    expect(player.news).toBe("");
  });

  it("keeps the stored flag for a player the API did not mention", () => {
    // An absent id means the API said nothing, and inventing fitness from
    // silence is the failure this exists to prevent.
    const flagged = stored({ status: "i", chance_of_playing_next_round: 0 });
    const map = availabilityFrom({ elements: [element(999, "a", null, "")] });

    expect(applyAvailability([flagged], map)[0]).toEqual(flagged);
  });

  it("changes nothing when the API could not be reached", () => {
    const flagged = stored({ status: "d", chance_of_playing_next_round: 50 });
    expect(applyAvailability([flagged], new Map())[0]).toEqual(flagged);
  });

  it("does not mutate the rows it was given", () => {
    const rows = [stored()];
    const map = availabilityFrom({ elements: [element(1, "i", 0, "Injured")] });
    applyAvailability(rows, map);
    expect(rows[0].status).toBe("a");
  });
});

describe("the overlay reaches the projection, not just the badge", () => {
  it("takes an injured player's minutes to zero", () => {
    // The reason this matters more than a red dot: `projectMinutes` reads the
    // same three fields, so a stale flag left an injured player projected as a
    // normal starter and a legitimate transfer target.
    const stale = projectMinutes({
      status: PLAYER_STATUS.available,
      chanceOfPlayingNextRound: null,
      recentStarts: [],
      recentMinutes: [],
    });
    const current = projectMinutes({
      status: "i",
      chanceOfPlayingNextRound: 0,
      recentStarts: [],
      recentMinutes: [],
    });

    expect(stale.pAppears).toBeGreaterThan(0.5);
    expect(current.pAppears).toBe(0);
  });
});
