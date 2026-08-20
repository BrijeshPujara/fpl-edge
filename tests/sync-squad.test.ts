import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The write path in `syncSquad` cannot be exercised against the live API
 * before the first deadline — picks 404 until then. These tests stub the FPL
 * client so the mapping, the settled-gameweek resolution and the
 * delete-then-insert ordering are all actually run rather than merely compiled.
 */

const mocks = vi.hoisted(() => ({
  getBootstrapStatic: vi.fn(),
  getEntry: vi.fn(),
  getEntryHistory: vi.fn(),
  getEntryPicksIfAvailable: vi.fn(),
}));

vi.mock("@/lib/fpl/client", () => mocks);

const { syncSquad } = await import("@/lib/db/sync-squad");
type Db = Parameters<typeof syncSquad>[0];

function event(id: number, flags: Partial<Record<string, boolean>> = {}) {
  return {
    id,
    name: `Gameweek ${id}`,
    deadline_time: "2026-08-21T17:30:00Z",
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
    ...flags,
  };
}

function picksPayload(activeChip: string | null = null) {
  return {
    active_chip: activeChip,
    entry_history: {
      event: 3,
      points: 60,
      total_points: 180,
      rank: 100,
      overall_rank: 41208,
      bank: 14,
      value: 1032,
      event_transfers: 1,
      event_transfers_cost: 0,
      points_on_bench: 5,
    },
    picks: Array.from({ length: 15 }, (_, i) => ({
      element: 100 + i,
      position: i + 1,
      multiplier: i === 0 ? 2 : 1,
      is_captain: i === 0,
      is_vice_captain: i === 1,
    })),
  };
}

/** Records every call so ordering and payloads can be asserted. */
function fakeDb() {
  const calls: { op: string; table: string; payload?: unknown }[] = [];

  const db = {
    from(table: string) {
      return {
        // Only `entries` is read back, by registerEntry checking whether this
        // manager is already known. Returning null means "never seen", which
        // is the path worth exercising.
        select() {
          return {
            eq: () => ({
              maybeSingle: async () => {
                calls.push({ op: "select", table });
                return { data: null, error: null };
              },
            }),
          };
        },
        upsert(payload: unknown) {
          calls.push({ op: "upsert", table, payload });
          // Leagues are upserted without a select; the awaited result must
          // still be a thenable carrying an `error`.
          const result = {
            error: null,
            select: () => ({
              single: async () => ({
                data:
                  table === "entries"
                    ? { id: 4278347, name: "Test", manager_name: "A Manager" }
                    : { id: "squad-uuid-1" },
                error: null,
              }),
            }),
          };
          return result as typeof result & PromiseLike<{ error: null }>;
        },
        delete() {
          return {
            eq: async (_col: string, value: string) => {
              calls.push({ op: "delete", table, payload: value });
              return { error: null };
            },
          };
        },
        async insert(payload: unknown) {
          calls.push({ op: "insert", table, payload });
          return { error: null };
        },
      };
    },
  };

  return { db: db as unknown as Db, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEntry.mockResolvedValue({
    id: 4278347,
    name: "Test",
    player_first_name: "A",
    player_last_name: "Manager",
    // The real schema defaults this, but a mock bypasses Zod entirely — so the
    // fixture has to carry the shape the code is entitled to expect.
    leagues: {
      classic: [
        {
          id: 605034,
          name: "A Mini-League",
          league_type: "x",
          scoring: "c",
          start_event: 1,
          entry_rank: null,
          entry_last_rank: null,
        },
      ],
      h2h: [],
    },
  });
  mocks.getEntryHistory.mockResolvedValue({ current: [], chips: [] });
});

describe("syncSquad", () => {
  it("reports no-picks-yet before any deadline has passed", async () => {
    mocks.getBootstrapStatic.mockResolvedValue({
      events: [event(1, { is_next: true }), event(2)],
    });
    const { db, calls } = fakeDb();

    const result = await syncSquad(db, 4278347);

    expect(result.status).toBe("no-picks-yet");
    // The MANAGER is registered even here — deliberately, since a squad cannot
    // be written for an unknown entry and waiting until the first deadline
    // would leave every team anonymous until then. No squad or picks, though.
    expect(calls.filter((c) => c.table === "squads")).toHaveLength(0);
    expect(calls.filter((c) => c.table === "squad_picks")).toHaveLength(0);
    expect(calls.some((c) => c.op === "upsert" && c.table === "entries")).toBe(
      true,
    );
    expect(mocks.getEntryPicksIfAvailable).not.toHaveBeenCalled();
  });

  it("reports no-picks-yet when the API has no picks for a settled gameweek", async () => {
    mocks.getBootstrapStatic.mockResolvedValue({
      events: [event(1, { is_current: true }), event(2, { is_next: true })],
    });
    mocks.getEntryPicksIfAvailable.mockResolvedValue(null);
    const { db, calls } = fakeDb();

    const result = await syncSquad(db, 4278347);

    expect(result).toMatchObject({ status: "no-picks-yet", gw: 1 });
    // The manager is registered; nothing about a squad is written.
    expect(calls.filter((c) => c.table.startsWith("squad"))).toHaveLength(0);
  });

  it("writes the squad and all fifteen picks", async () => {
    mocks.getBootstrapStatic.mockResolvedValue({
      events: [
        event(3, { is_current: true }),
        event(4, { is_next: true }),
      ],
    });
    mocks.getEntryPicksIfAvailable.mockResolvedValue(picksPayload());
    mocks.getEntryHistory.mockResolvedValue({
      current: [
        { event: 2, event_transfers: 0 },
        { event: 3, event_transfers: 1 },
      ],
      chips: [],
    });
    const { db, calls } = fakeDb();

    const result = await syncSquad(db, 4278347);

    expect(result).toMatchObject({
      status: "synced",
      gw: 3,
      picks: 15,
      captainId: 100,
      viceCaptainId: 101,
      bank: 14,
      teamValue: 1032,
    });

    // Picks must be cleared before reinsertion, or the unique constraint on
    // (squad_id, position) collides when a player changes bench slot.
    // The order is all foreign keys. A squad cannot reference an unknown
    // entry, and a membership cannot reference an unknown league or entry, so
    // registration and league discovery both have to land first.
    expect(calls.map((c) => `${c.op}:${c.table}`)).toEqual([
      "select:entries",
      "upsert:entries",
      "upsert:leagues",
      "upsert:league_memberships",
      "upsert:squads",
      "delete:squad_picks",
      "insert:squad_picks",
    ]);

    // Found by table rather than by index, so inserting another write earlier
    // in the sequence does not silently retarget this assertion.
    const inserted = calls.find(
      (c) => c.op === "insert" && c.table === "squad_picks",
    )!.payload as { squad_id: string; position: number }[];
    expect(inserted).toHaveLength(15);
    expect(inserted.every((p) => p.squad_id === "squad-uuid-1")).toBe(true);
    expect(inserted.map((p) => p.position)).toEqual(
      Array.from({ length: 15 }, (_, i) => i + 1),
    );
  });

  it("derives free transfers for the gameweek being planned, not the one played", async () => {
    mocks.getBootstrapStatic.mockResolvedValue({
      events: [event(3, { is_current: true }), event(4, { is_next: true })],
    });
    mocks.getEntryPicksIfAvailable.mockResolvedValue(picksPayload());
    // GW2 and GW3 both quiet -> GW4 has two banked plus its own allowance
    // would be 3, but GW2 starts at 1: 1 -> 2 (GW3) -> 3 (GW4).
    mocks.getEntryHistory.mockResolvedValue({
      current: [
        { event: 2, event_transfers: 0 },
        { event: 3, event_transfers: 0 },
      ],
      chips: [],
    });
    const { db } = fakeDb();

    const result = await syncSquad(db, 4278347);
    expect(result).toMatchObject({ status: "synced", freeTransfers: 3 });
  });

  it("credits a wildcard so the bank is not spent", async () => {
    mocks.getBootstrapStatic.mockResolvedValue({
      events: [event(3, { is_current: true }), event(4, { is_next: true })],
    });
    mocks.getEntryPicksIfAvailable.mockResolvedValue(picksPayload("wildcard"));
    mocks.getEntryHistory.mockResolvedValue({
      current: [
        { event: 2, event_transfers: 0 },
        { event: 3, event_transfers: 9 },
      ],
      chips: [{ name: "wildcard", event: 3, time: "2026-09-01T00:00:00Z" }],
    });
    const { db } = fakeDb();

    const result = await syncSquad(db, 4278347);
    // Without the chip credit those 9 transfers would zero the bank and this
    // would be 1.
    expect(result).toMatchObject({
      status: "synced",
      chipPlayed: "wildcard",
      freeTransfers: 3,
    });
  });
});
