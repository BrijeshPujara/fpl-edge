import { describe, expect, it } from "vitest";
import { rankMovement, visibleStandings } from "@/lib/leagues/table";

const row = (entry: number, rank: number, last_rank = 0) => ({
  entry,
  rank,
  last_rank,
});

const table = (size: number) =>
  Array.from({ length: size }, (_, i) => row(1000 + i, i + 1));

describe("visibleStandings", () => {
  it("shows the whole table when it fits", () => {
    const rows = table(6);
    const view = visibleStandings(rows, 1002, 10);
    expect(view.top).toHaveLength(6);
    expect(view.pinned).toBeNull();
    expect(view.showGap).toBe(false);
  });

  it("truncates a long table to the limit", () => {
    const view = visibleStandings(table(200), 1000, 10);
    expect(view.top).toHaveLength(10);
  });

  it("does not pin a manager who is already visible", () => {
    const view = visibleStandings(table(200), 1003, 10);
    expect(view.pinned).toBeNull();
  });

  it("pins a manager who fell below the cut", () => {
    // The whole point: forty-seventh in a league of two hundred should not
    // have to scroll to find out.
    const view = visibleStandings(table(200), 1046, 10);
    expect(view.pinned?.entry).toBe(1046);
    expect(view.pinned?.rank).toBe(47);
    expect(view.showGap).toBe(true);
  });

  it("draws no gap when nothing was skipped", () => {
    // Eleventh in a table showing ten. There is no "..." to draw, because
    // there is nothing between the tenth row and theirs.
    const view = visibleStandings(table(200), 1010, 10);
    expect(view.pinned?.rank).toBe(11);
    expect(view.showGap).toBe(false);
  });

  it("pins nothing for a manager who is not in the league", () => {
    const view = visibleStandings(table(50), 999999, 10);
    expect(view.pinned).toBeNull();
    expect(view.showGap).toBe(false);
  });

  it("handles an empty table", () => {
    const view = visibleStandings([], 1000, 10);
    expect(view.top).toEqual([]);
    expect(view.pinned).toBeNull();
    expect(view.showGap).toBe(false);
  });
});

describe("rankMovement", () => {
  it("reports places gained as positive", () => {
    expect(rankMovement(3, 8)).toBe(5);
  });

  it("reports places lost as negative", () => {
    expect(rankMovement(8, 3)).toBe(-5);
  });

  it("reports no movement as zero", () => {
    expect(rankMovement(4, 4)).toBe(0);
  });

  it("says nothing when there was no previous position", () => {
    // last_rank is 0 in the first scored gameweek. Subtracting from it would
    // credit every manager in the league with a spectacular rise.
    expect(rankMovement(4, 0)).toBeNull();
  });

  it("says nothing when there is no current position either", () => {
    expect(rankMovement(0, 0)).toBeNull();
  });
});
