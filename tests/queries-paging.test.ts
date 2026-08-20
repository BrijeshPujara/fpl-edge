import { describe, expect, it } from "vitest";
import { getSeasonHistory } from "@/lib/db/queries";

type Db = Parameters<typeof getSeasonHistory>[0];

/**
 * PostgREST caps a response at 1000 rows and does so silently — no error, no
 * flag. These tests drive the real query path against a fake that enforces the
 * same cap, because the failure mode is invisible in production: the model
 * simply gets worse for whichever players sorted last.
 */
function fakeDb(totalRows: number) {
  const rows = Array.from({ length: totalRows }, (_, i) => ({
    player_code: 100000 + i,
    season_name: "2025/26",
  }));
  const ranges: [number, number][] = [];

  const db = {
    from() {
      const builder = {
        select: () => builder,
        in: () => builder,
        gte: () => builder,
        order: () => builder,
        range: async (from: number, to: number) => {
          ranges.push([from, to]);
          // The server never returns more than the cap, whatever was asked.
          const size = Math.min(to - from + 1, 1000);
          return { data: rows.slice(from, from + size), error: null };
        },
      };
      return builder;
    },
  };

  return { db: db as unknown as Db, ranges };
}

describe("paged reads", () => {
  it("returns everything when the table exceeds one page", () => {
    // The bug this exists for: 2,039 rows came back as exactly 1000, covering
    // 147 players instead of 506, and nothing reported a problem.
    return (async () => {
      const { db } = fakeDb(2039);
      const result = await getSeasonHistory(db, [1, 2, 3]);
      expect(result).toHaveLength(2039);
    })();
  });

  it("stops as soon as a page comes back short", async () => {
    const { db, ranges } = fakeDb(1500);
    await getSeasonHistory(db, [1]);
    // Two pages: 0-999 full, 1000-1999 short.
    expect(ranges).toHaveLength(2);
  });

  it("makes exactly one request when everything fits", async () => {
    const { db, ranges } = fakeDb(40);
    const result = await getSeasonHistory(db, [1]);
    expect(result).toHaveLength(40);
    expect(ranges).toHaveLength(1);
  });

  it("issues one more request when the total is an exact multiple", async () => {
    // 2000 rows fills two pages exactly, so the only way to know there is no
    // third is to ask for one.
    const { db, ranges } = fakeDb(2000);
    const result = await getSeasonHistory(db, [1]);
    expect(result).toHaveLength(2000);
    expect(ranges).toHaveLength(3);
  });

  it("never repeats or skips a row across pages", async () => {
    const { db } = fakeDb(2039);
    const result = await getSeasonHistory(db, [1]);
    const codes = result.map((r) => r.player_code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes[0]).toBe(100000);
    expect(codes.at(-1)).toBe(100000 + 2038);
  });

  it("asks for nothing when there are no ids", async () => {
    const { db, ranges } = fakeDb(2039);
    expect(await getSeasonHistory(db, [])).toEqual([]);
    expect(ranges).toHaveLength(0);
  });
});
