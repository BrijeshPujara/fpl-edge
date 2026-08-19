import { describe, expect, it } from "vitest";
import { splitByFixture } from "@/lib/db/sync-results";
import type { FplLiveElement } from "@/lib/fpl/schemas";

/**
 * Double gameweeks happen a handful of times a season. If the split is wrong,
 * half the data silently disappears — the row keyed on (player_id, fixture_id)
 * simply overwrites itself — and it would not be noticed until the model
 * started producing nonsense months later.
 */

function stat(identifier: string, value: number, points = 0) {
  return { identifier, points, value };
}

function element(
  explain: FplLiveElement["explain"],
  stats: Partial<FplLiveElement["stats"]> = {},
): FplLiveElement {
  return {
    id: 1,
    explain,
    stats: {
      minutes: 0, goals_scored: 0, assists: 0, clean_sheets: 0,
      goals_conceded: 0, own_goals: 0, penalties_saved: 0,
      penalties_missed: 0, yellow_cards: 0, red_cards: 0, saves: 0,
      bonus: 0, bps: 0, starts: 0,
      expected_goals: 0, expected_assists: 0,
      expected_goal_involvements: 0, expected_goals_conceded: 0,
      defensive_contribution: 0, total_points: 0,
      ...stats,
    },
  };
}

describe("splitByFixture", () => {
  it("returns one entry for a normal single fixture", () => {
    const e = element(
      [{ fixture: 10, stats: [stat("minutes", 90, 2), stat("goals_scored", 1, 5)] }],
      { minutes: 90, starts: 1, total_points: 7 },
    );
    const split = splitByFixture(e);
    expect(split.size).toBe(1);
    expect(split.get(10)).toMatchObject({ minutes: 90, goals: 1, total_points: 7 });
  });

  it("splits a double gameweek into two rows keyed by fixture", () => {
    const e = element(
      [
        { fixture: 10, stats: [stat("minutes", 90, 2), stat("goals_scored", 1, 5)] },
        { fixture: 11, stats: [stat("minutes", 62, 2), stat("assists", 2, 6)] },
      ],
      { minutes: 152, starts: 2, total_points: 15 },
    );
    const split = splitByFixture(e);

    expect(split.size).toBe(2);
    expect(split.get(10)).toMatchObject({ minutes: 90, goals: 1, assists: 0 });
    expect(split.get(11)).toMatchObject({ minutes: 62, goals: 0, assists: 2 });
    // Points come from each fixture's own explain entry.
    expect(split.get(10)!.total_points).toBe(7);
    expect(split.get(11)!.total_points).toBe(8);
  });

  it("preserves total minutes across a double", () => {
    const e = element(
      [
        { fixture: 10, stats: [stat("minutes", 90)] },
        { fixture: 11, stats: [stat("minutes", 62)] },
      ],
      { minutes: 152 },
    );
    const total = [...splitByFixture(e).values()].reduce((s, x) => s + x.minutes, 0);
    expect(total).toBe(152);
  });

  it("reconciles a single fixture against the authoritative aggregate", () => {
    // The aggregate wins for a single fixture, so rounding inside explain
    // cannot drift the stored total away from what the game says.
    const e = element(
      [{ fixture: 10, stats: [stat("minutes", 88, 2), stat("bonus", 3, 3)] }],
      { minutes: 90, starts: 1, total_points: 12 },
    );
    const only = splitByFixture(e).get(10)!;
    expect(only.total_points).toBe(12);
    expect(only.minutes).toBe(90);
  });

  it("returns nothing for a player who was not involved", () => {
    // An unused squad member has no explain entries. There is no fixture to key
    // a row on, so none is written.
    expect(splitByFixture(element([])).size).toBe(0);
  });

  it("carries defensive contributions through per fixture", () => {
    const e = element([
      { fixture: 10, stats: [stat("minutes", 90, 2), stat("defensive_contribution", 12, 2)] },
      { fixture: 11, stats: [stat("minutes", 90, 2), stat("defensive_contribution", 6, 0)] },
    ]);
    const split = splitByFixture(e);
    expect(split.get(10)!.defensive_contribution).toBe(12);
    expect(split.get(11)!.defensive_contribution).toBe(6);
  });

  it("ignores identifiers it does not map, without losing their points", () => {
    // Saves and penalties saved score points but are not stored as columns.
    // Their points must still reach the per-fixture total.
    //
    // Tested on a DOUBLE deliberately: for a single fixture the aggregate is
    // authoritative and overwrites the summed explain points, so a single would
    // be testing the reconciliation instead of the summing.
    const e = element([
      { fixture: 10, stats: [stat("minutes", 90, 2), stat("saves", 6, 2), stat("penalties_saved", 1, 5)] },
      { fixture: 11, stats: [stat("minutes", 90, 2), stat("saves", 3, 1)] },
    ]);
    const split = splitByFixture(e);
    expect(split.get(10)!.total_points).toBe(9);
    expect(split.get(11)!.total_points).toBe(3);
  });

  it("lets the aggregate win over explain for a single fixture", () => {
    // FPL displays the aggregate, so it is authoritative. If explain and the
    // aggregate disagree — rounding, or a late bonus revision — the stored
    // total must match what the game shows the manager.
    const e = element(
      [{ fixture: 10, stats: [stat("minutes", 90, 2), stat("bonus", 1, 1)] }],
      { minutes: 90, total_points: 99 },
    );
    expect(splitByFixture(e).get(10)!.total_points).toBe(99);
  });
});
