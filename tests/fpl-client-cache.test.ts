import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * How the FPL client caches, and in particular how it does NOT.
 *
 * `bootstrap-static` is ~2.3MB and Next's data cache refuses anything over
 * 2MB. Offered to that cache, a refresh silently fails to replace an older,
 * smaller copy, which is then served indefinitely: the app spent weeks showing
 * GW2 while every script saw GW5. These tests pin the fix — bootstrap never
 * goes near the data cache, and its in-process cache can only ever be as old as
 * the window a caller asked for.
 *
 * The schemas are passed through so the tests are about caching, not about
 * building a valid 2MB payload.
 */
vi.mock("@/lib/fpl/schemas", () => ({
  bootstrapStaticSchema: z.any(),
  elementSummarySchema: z.any(),
  entryHistorySchema: z.any(),
  entryTransfersSchema: z.any(),
  entryPicksSchema: z.any(),
  entrySchema: z.any(),
  eventLiveSchema: z.any(),
  fixturesSchema: z.any(),
  leagueStandingsSchema: z.any(),
}));

type Client = typeof import("@/lib/fpl/client");

const fetchMock = vi.fn();
let client: Client;

const ok = (body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

beforeEach(async () => {
  // A fresh module per test, so the in-process cache starts empty.
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  client = await import("@/lib/fpl/client");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("getBootstrapStatic", () => {
  it("never offers the response to Next's data cache", async () => {
    fetchMock.mockImplementation(() => ok({ events: [] }));
    await client.getBootstrapStatic();

    const init = fetchMock.mock.calls[0][1] as RequestInit & { next?: unknown };
    expect(init.cache).toBe("no-store");
    // `next.revalidate` alongside `no-store` is a conflict Next ignores both
    // halves of, so its absence is part of the contract.
    expect(init.next).toBeUndefined();
  });

  it("reuses one download within the window, including for parallel callers", async () => {
    fetchMock.mockImplementation(() => ok({ n: 1 }));
    const [a, b] = await Promise.all([
      client.getBootstrapStatic(),
      client.getBootstrapStatic(),
    ]);
    await client.getBootstrapStatic();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it("downloads again once the window has passed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T12:00:00Z"));
    fetchMock.mockImplementation(() => ok({}));

    await client.getBootstrapStatic({ revalidate: 900 });
    vi.setSystemTime(new Date("2026-09-14T12:15:01Z"));
    await client.getBootstrapStatic({ revalidate: 900 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("always downloads for revalidate: 0, and refreshes the cache for everyone else", async () => {
    fetchMock
      .mockImplementationOnce(() => ok({ gw: 4 }))
      .mockImplementationOnce(() => ok({ gw: 5 }));

    await client.getBootstrapStatic();
    const fresh = await client.getBootstrapStatic({ revalidate: 0 });
    const cached = await client.getBootstrapStatic();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fresh).toEqual({ gw: 5 });
    // The sync's fresh copy is what a page sees next, not the older one.
    expect(cached).toEqual({ gw: 5 });
  });

  it("does not keep a failure", async () => {
    fetchMock
      .mockImplementationOnce(() =>
        Promise.resolve(new Response("nope", { status: 404 })),
      )
      .mockImplementationOnce(() => ok({ recovered: true }));

    await expect(client.getBootstrapStatic()).rejects.toThrow(/404/);
    await expect(client.getBootstrapStatic()).resolves.toEqual({ recovered: true });
  });
});

describe("the smaller endpoints", () => {
  it("still use Next's data cache, which they fit inside", async () => {
    fetchMock.mockImplementation(() => ok([]));
    await client.getFixtures();

    const init = fetchMock.mock.calls[0][1] as RequestInit & {
      next?: { revalidate?: number };
    };
    expect(init.next?.revalidate).toBe(3600);
    expect(init.cache).toBeUndefined();
  });
});
