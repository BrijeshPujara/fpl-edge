import { describe, expect, it } from "vitest";
import { liveSquad, provisionalBonus, type LivePick } from "@/lib/squad/live";
import type { FplLiveElement } from "@/lib/fpl/schemas";

const element = (
  id: number,
  over: {
    points?: number;
    bps?: number;
    minutes?: number;
    fixtures?: number[];
    /** Bonus FPL has already awarded, which lands inside total_points. */
    bonus?: number;
  } = {},
): FplLiveElement =>
  ({
    id,
    stats: {
      minutes: over.minutes ?? 90,
      bps: over.bps ?? 0,
      total_points: over.points ?? 0,
      bonus: over.bonus ?? 0,
    },
    explain: (over.fixtures ?? [1]).map((fixture) => ({
      fixture,
      stats: over.bonus
        ? [{ identifier: "bonus", points: over.bonus, value: over.bonus }]
        : [],
    })),
  }) as unknown as FplLiveElement;

const pick = (playerId: number, position: number, over: Partial<LivePick> = {}): LivePick => ({
  playerId,
  position,
  isCaptain: false,
  isVice: false,
  ...over,
});

/** Eleven starters and four bench, all scoring `each`. */
const fullSquad = (each: number) => ({
  picks: Array.from({ length: 15 }, (_, i) => pick(i + 1, i + 1)),
  elements: Array.from({ length: 15 }, (_, i) => element(i + 1, { points: each })),
});

describe("provisional bonus", () => {
  it("awards three, two and one", () => {
    const awarded = provisionalBonus(
      new Map([
        [1, 40],
        [2, 30],
        [3, 20],
        [4, 10],
      ]),
    );
    expect(awarded.get(1)).toBe(3);
    expect(awarded.get(2)).toBe(2);
    expect(awarded.get(3)).toBe(1);
    expect(awarded.has(4)).toBe(false);
  });

  it("ranks SCORES, not players, so a tie at the top pays two threes", () => {
    // FPL's actual rule, and the one that gets argued about: two players tied
    // on top BPS both get 3 and the next gets 1 — never 3, 3, 2.
    const awarded = provisionalBonus(
      new Map([
        [1, 40],
        [2, 40],
        [3, 30],
      ]),
    );
    expect(awarded.get(1)).toBe(3);
    expect(awarded.get(2)).toBe(3);
    expect(awarded.get(3)).toBe(2);
  });

  it("lets four players share bonus in one match", () => {
    const awarded = provisionalBonus(
      new Map([
        [1, 40],
        [2, 30],
        [3, 30],
        [4, 20],
      ]),
    );
    expect([...awarded.values()].sort()).toEqual([1, 2, 2, 3]);
  });

  it("ignores nobody having scored yet", () => {
    expect(provisionalBonus(new Map([[1, 0], [2, 0]])).size).toBe(0);
  });
});

describe("a live squad", () => {
  it("counts the eleven and doubles the captain", () => {
    const { picks, elements } = fullSquad(4);
    picks[0].isCaptain = true;

    const live = liveSquad({ picks, elements, startedFixtures: new Set([1, 2]) });
    // Eleven starters at four, plus the captain's extra four.
    expect(live.total).toBe(11 * 4 + 4);
    expect(live.benchTotal).toBe(4 * 4);
  });

  it("leaves the bench out until a bench boost", () => {
    const { picks, elements } = fullSquad(4);
    const plain = liveSquad({ picks, elements, startedFixtures: new Set([1, 2]) });
    const boosted = liveSquad({
      picks,
      elements,
      startedFixtures: new Set([1, 2]),
      chip: "bboost",
    });
    expect(boosted.total).toBe(plain.total + plain.benchTotal);
  });

  it("triples the captain under a triple captain", () => {
    const { picks, elements } = fullSquad(4);
    picks[0].isCaptain = true;
    const tripled = liveSquad({
      picks,
      elements,
      startedFixtures: new Set([1, 2]),
      chip: "3xc",
    });
    expect(tripled.total).toBe(11 * 4 + 8);
  });

  it("does NOT double a captain sitting on the bench", () => {
    const { picks, elements } = fullSquad(4);
    picks[14].isCaptain = true; // position 15
    const live = liveSquad({ picks, elements, startedFixtures: new Set([1, 2]) });
    expect(live.total).toBe(11 * 4);
  });
});

describe("bonus that has not been awarded yet", () => {
  const picks = [pick(1, 1), pick(2, 2)];
  const elements = [
    element(1, { points: 8, bps: 40 }),
    element(2, { points: 5, bps: 20 }),
    element(3, { points: 6, bps: 30 }),
  ];

  it("adds provisional bonus while the fixture is running", () => {
    const live = liveSquad({ picks, elements, startedFixtures: new Set([1, 2]) });
    // Top BPS of the three in the match, so three provisional points.
    expect(live.players[0].provisionalBonus).toBe(3);
    expect(live.players[0].points).toBe(11);
    expect(live.provisional).toBe(true);
  });

  it("stops once FPL awards the real bonus, rather than when the fixture ends", () => {
    // Caught against the live feed: Arsenal v Coventry sat at finished=false
    // with bonus already inside total_points. Gating on the fixture flag would
    // have added an estimate on top of the real thing, inflating exactly the
    // three players everyone is watching.
    const awarded = [
      element(1, { points: 11, bps: 40, bonus: 3 }),
      element(2, { points: 6, bps: 20, bonus: 1 }),
      element(3, { points: 8, bps: 30, bonus: 2 }),
    ];
    const live = liveSquad({ picks, elements: awarded, startedFixtures: new Set([1, 2]) });

    expect(live.players[0].provisionalBonus).toBe(0);
    expect(live.players[0].points).toBe(11);
    expect(live.provisional).toBe(false);
  });

  it("keeps estimating for a match whose bonus has not landed", () => {
    const live = liveSquad({ picks, elements, startedFixtures: new Set([1, 2]) });
    expect(live.players[0].provisionalBonus).toBe(3);
    expect(live.provisional).toBe(true);
  });

  it("handles a double where one match has bonus and the other does not", () => {
    // The reason bonus is detected per fixture rather than per player.
    const live = liveSquad({
      startedFixtures: new Set([1, 2]),
      picks: [pick(1, 1)],
      elements: [
        // Fixture 1 settled, fixture 2 still running.
        element(1, { points: 14, bps: 45, fixtures: [1], bonus: 3 }),
        element(1, { points: 14, bps: 45, fixtures: [2] }),
        element(9, { points: 4, bps: 10, fixtures: [2] }),
      ],
    });
    // Only the unsettled fixture contributes an estimate.
    expect(live.players[0].provisionalBonus).toBe(3);
  });

  it("ranks the whole match, not just the players in this squad", () => {
    // Player 3 is not owned but is second on BPS, so the owned player on 20
    // BPS is third and gets one point, not two.
    const live = liveSquad({ picks, elements, startedFixtures: new Set([1, 2]) });
    expect(live.players[1].provisionalBonus).toBe(1);
  });
});

describe("players who have not kicked off", () => {
  it("separates yet to play from played and blanked", () => {
    // The live feed gives EVERY player an explain entry from the moment the
    // gameweek opens, zero-filled — 600 of 600, verified against the real
    // endpoint. So this can only be answered from fixture state, and reading
    // it off the payload showed every unplayed player as having blanked.
    const picks = [pick(1, 1), pick(2, 2)];
    const elements = [
      element(1, { points: 0, minutes: 0, fixtures: [7] }), // kicks off later
      element(2, { points: 0, minutes: 90, fixtures: [1] }),
    ];
    const live = liveSquad({ picks, elements, startedFixtures: new Set([1]) });

    expect(live.players[0].started).toBe(false);
    expect(live.players[1].started).toBe(true);
    expect(live.toPlay).toBe(1);
  });

  it("counts a player as started once any of their fixtures has", () => {
    const live = liveSquad({
      picks: [pick(1, 1)],
      elements: [element(1, { fixtures: [1, 9] })],
      startedFixtures: new Set([9]),
    });
    expect(live.players[0].started).toBe(true);
  });

  it("scores a player the live feed has never heard of as zero", () => {
    const live = liveSquad({
      picks: [pick(99, 1)],
      elements: [],
      startedFixtures: new Set(),
    });
    expect(live.total).toBe(0);
    expect(live.players[0].started).toBe(false);
  });
});

describe("a double gameweek", () => {
  it("can collect provisional bonus from both fixtures", () => {
    const live = liveSquad({
      startedFixtures: new Set([1, 2]),
      picks: [pick(1, 1)],
      elements: [
        element(1, { points: 12, bps: 40, fixtures: [1, 2] }),
        element(2, { points: 4, bps: 10, fixtures: [1] }),
        element(3, { points: 4, bps: 10, fixtures: [2] }),
      ],
    });
    expect(live.players[0].provisionalBonus).toBe(6);
  });
});

describe("what a tile should print", () => {
  /*
   * `counted` is points times multiplier, so it is zero for every bench
   * player however well he played — which on screen looked like a broken feed
   * rather than a bench. Both numbers are on `LivePlayer` for that reason: the
   * squad total needs `counted`, a tile needs `points`.
   */
  it("keeps the raw score separate from what it counts for", () => {
    const picks = [
      pick(1, 1, { isCaptain: true }),
      pick(2, 2),
      pick(3, 12), // bench
    ];
    const elements = [
      element(1, { points: 9 }),
      element(2, { points: 5 }),
      element(3, { points: 7 }),
    ];
    const live = liveSquad({ picks, elements, startedFixtures: new Set([1]) });
    const [captain, starter, benched] = live.players;

    expect(captain.points).toBe(9);
    expect(captain.counted).toBe(18);

    expect(starter.points).toBe(5);
    expect(starter.counted).toBe(5);

    // The bench player scored seven and it counts for nothing. Both true.
    expect(benched.points).toBe(7);
    expect(benched.counted).toBe(0);
    expect(benched.multiplier).toBe(0);
  });

  it("counts the bench toward the total only under a bench boost", () => {
    const picks = [pick(1, 1), pick(2, 12)];
    const elements = [element(1, { points: 4 }), element(2, { points: 7 })];
    const started = new Set([1]);

    expect(liveSquad({ picks, elements, startedFixtures: started }).total).toBe(4);
    expect(
      liveSquad({ picks, elements, startedFixtures: started, chip: "bboost" })
        .total,
    ).toBe(11);
  });
});
