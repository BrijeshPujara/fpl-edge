import { describe, expect, it } from "vitest";
import {
  activeChipWindow,
  classifyGameweek,
  countFixturesByTeam,
  countdownTo,
  gameweeksUntilExpiry,
  resolveChipWindows,
  resolveGameweekState,
} from "@/lib/fpl/gameweek";
import type { FplChip, FplEvent } from "@/lib/fpl/schemas";

function event(id: number, overrides: Partial<FplEvent> = {}): FplEvent {
  return {
    id,
    name: `Gameweek ${id}`,
    deadline_time: `2026-08-${String(20 + id).padStart(2, "0")}T17:30:00Z`,
    finished: false,
    is_previous: false,
    is_current: false,
    is_next: false,
    data_checked: false,
    average_entry_score: 0,
    highest_score: null,
    most_captained: null,
    most_selected: null,
    chip_plays: [],
    ...overrides,
  };
}

function chip(
  name: string,
  start: number,
  stop: number,
  number = 1,
): FplChip {
  return {
    id: start * 100 + number,
    name,
    number,
    start_event: start,
    stop_event: stop,
    chip_type: name === "wildcard" || name === "freehit" ? "transfer" : "team",
  };
}

describe("resolveGameweekState", () => {
  it("targets the next gameweek before the season starts", () => {
    const events = [event(1, { is_next: true }), event(2), event(3)];
    const state = resolveGameweekState(events);

    expect(state.current).toBeNull();
    expect(state.next?.id).toBe(1);
    expect(state.target.id).toBe(1);
    expect(state.isPreSeason).toBe(true);
  });

  it("targets the next gameweek once one is in progress", () => {
    const events = [
      event(1, { is_previous: true, finished: true }),
      event(2, { is_current: true }),
      event(3, { is_next: true }),
    ];
    const state = resolveGameweekState(events);

    expect(state.previous?.id).toBe(1);
    expect(state.current?.id).toBe(2);
    // Planning happens for the gameweek you can still change, not the live one.
    expect(state.target.id).toBe(3);
    expect(state.isPreSeason).toBe(false);
  });

  it("falls back to the final gameweek at season end", () => {
    const events = [event(37, { is_previous: true }), event(38, { is_current: true })];
    expect(resolveGameweekState(events).target.id).toBe(38);
  });

  it("throws rather than guessing when there are no events", () => {
    expect(() => resolveGameweekState([])).toThrow(/no events/i);
  });
});

describe("countdownTo", () => {
  it("breaks a duration into days, hours, minutes and seconds", () => {
    const now = new Date("2026-08-19T12:00:00Z");
    const target = new Date("2026-08-21T17:30:45Z");

    expect(countdownTo(target, now)).toEqual({
      days: 2,
      hours: 5,
      minutes: 30,
      seconds: 45,
      expired: false,
    });
  });

  it("reports expiry rather than negative time", () => {
    const now = new Date("2026-08-22T00:00:00Z");
    const target = new Date("2026-08-21T17:30:00Z");
    expect(countdownTo(target, now).expired).toBe(true);
    expect(countdownTo(target, now).days).toBe(0);
  });
});

describe("resolveChipWindows", () => {
  const chips = [
    chip("wildcard", 1, 19, 1),
    chip("wildcard", 20, 38, 2),
    chip("freehit", 1, 19, 1),
    chip("freehit", 20, 38, 2),
    chip("3xc", 1, 19, 1),
    chip("bboost", 1, 19, 1),
  ];

  it("numbers sets by window order, not by API ordering", () => {
    // Deliberately reversed to prove the sort, not the input order.
    const windows = resolveChipWindows([chips[1], chips[0]]);
    expect(windows).toEqual([
      { name: "wildcard", set: 1, startEvent: 1, stopEvent: 19 },
      { name: "wildcard", set: 2, startEvent: 20, stopEvent: 38 },
    ]);
  });

  it("ignores chip names it does not recognise", () => {
    const windows = resolveChipWindows([
      ...chips,
      chip("manager", 1, 19),
    ]);
    expect(windows.some((w) => (w.name as string) === "manager")).toBe(false);
  });

  it("finds the open window for a gameweek", () => {
    const windows = resolveChipWindows(chips);
    expect(activeChipWindow(windows, "wildcard", 12)?.set).toBe(1);
    expect(activeChipWindow(windows, "wildcard", 25)?.set).toBe(2);
  });

  it("counts gameweeks to expiry inclusively", () => {
    const windows = resolveChipWindows(chips);
    // At GW19 the chip can still be played this week: one gameweek remains.
    expect(gameweeksUntilExpiry(windows, "wildcard", 19)).toBe(1);
    expect(gameweeksUntilExpiry(windows, "wildcard", 12)).toBe(8);
  });

  it("returns null once a chip has no open window", () => {
    // Triple captain has only a first-half window in this fixture.
    const windows = resolveChipWindows(chips);
    expect(gameweeksUntilExpiry(windows, "3xc", 25)).toBeNull();
  });
});

describe("countFixturesByTeam / classifyGameweek", () => {
  const teamIds = [1, 2, 3, 4];

  it("counts two fixtures for a team in a double gameweek", () => {
    const counts = countFixturesByTeam(
      [
        { event: 25, team_h: 1, team_a: 2 },
        { event: 25, team_h: 3, team_a: 1 },
        { event: 25, team_h: 4, team_a: 2 },
      ],
      teamIds,
    );
    expect(counts.get(25)?.byTeam.get(1)).toBe(2);
    expect(classifyGameweek(counts.get(25))).toBe("double");
  });

  it("identifies a blank when a team has no fixture", () => {
    const counts = countFixturesByTeam(
      [{ event: 18, team_h: 1, team_a: 2 }],
      teamIds,
    );
    expect(counts.get(18)?.byTeam.get(3)).toBe(0);
    expect(classifyGameweek(counts.get(18))).toBe("blank");
  });

  it("classifies a full round as normal", () => {
    const counts = countFixturesByTeam(
      [
        { event: 5, team_h: 1, team_a: 2 },
        { event: 5, team_h: 3, team_a: 4 },
      ],
      teamIds,
    );
    expect(classifyGameweek(counts.get(5))).toBe("normal");
  });

  it("treats a gameweek with no fixtures at all as blank", () => {
    expect(classifyGameweek(undefined)).toBe("blank");
  });

  it("skips fixtures not yet assigned to a gameweek", () => {
    const counts = countFixturesByTeam(
      [
        { event: null, team_h: 1, team_a: 2 },
        { event: 5, team_h: 3, team_a: 4 },
      ],
      teamIds,
    );
    expect(counts.has(5)).toBe(true);
    expect(counts.size).toBe(1);
  });
});
