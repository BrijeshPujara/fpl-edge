import { describe, expect, it } from "vitest";
import { pointsDistribution, rankCaptains } from "@/lib/engine/captain";
import { atLeast, mean, quantile } from "@/lib/engine/distribution";
import {
  expectedPoints,
  type FixtureContext,
  type GameweekSample,
  type PlayerModelInput,
} from "@/lib/engine/expected-points";
import { POSITION } from "@/lib/rules";

function sample(over: Partial<GameweekSample> = {}): GameweekSample {
  return {
    minutes: 90, started: true,
    expectedGoals: 0.5, expectedAssists: 0.2,
    defensiveContribution: 4, bonus: 1, goalsConceded: 1,
    yellowCards: 0, redCards: 0,
    ...over,
  };
}

function player(over: Partial<PlayerModelInput> = {}): PlayerModelInput {
  return {
    playerId: 1,
    position: POSITION.FWD,
    teamId: 1,
    minutes: {
      status: "a",
      chanceOfPlayingNextRound: null,
      recentStarts: [true, true, true, true, true, true],
      recentMinutes: [90, 90, 90, 90, 90, 90],
    },
    recent: Array.from({ length: 6 }, () => sample()),
    priorSeason: null,
    ...over,
  };
}

function fixture(over: Partial<FixtureContext> = {}): FixtureContext {
  return {
    gw: 10, isHome: true,
    teamDefence: null, opponentAttack: null,
    leagueMeanAttack: null, leagueStdAttack: null,
    opponentDefence: null, leagueMeanDefence: null, leagueStdDefence: null,
    ...over,
  };
}

describe("pointsDistribution", () => {
  it("is a probability distribution", () => {
    const pmf = pointsDistribution(player(), fixture());
    expect(pmf.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 8);
    expect(pmf.every((p) => p >= 0)).toBe(true);
  });

  it("stays a probability distribution across the whole bonus range", () => {
    // The bug this pins: the bonus ladder used to sum past one above a mean of
    // two, so the whole distribution summed to as much as 1.5 and a captain
    // was reported with a blank probability of minus 26%.
    for (const bonus of [0, 0.5, 1, 2, 2.5, 3, 5]) {
      const pmf = pointsDistribution(
        player({
          recent: Array.from({ length: 6 }, () => sample({ bonus })),
        }),
        fixture(),
      );
      const total = pmf.reduce((a, b) => a + b, 0);
      expect(total).toBeCloseTo(1, 6);
    }
  });

  it("never reports a probability outside zero and one", () => {
    for (const bonus of [0, 1, 2, 3, 6]) {
      const [c] = rankCaptains([
        {
          playerId: 1,
          input: player({
            recent: Array.from({ length: 6 }, () =>
              sample({ bonus, expectedGoals: 1.2 }),
            ),
          }),
          fixtures: [fixture()],
        },
      ]);
      for (const p of [c.pHaul, c.pBlank, c.pNoShow]) {
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
  });

  it("has roughly the mean the model computed", () => {
    // The consistency test that matters. Two implementations of the same
    // player exist now — the mean model and this one — and if they disagree,
    // one of them is wrong and the screens contradict each other.
    const p = player();
    const f = fixture();
    expect(mean(pointsDistribution(p, f))).toBeCloseTo(
      expectedPoints(p, f).total,
      0,
    );
  });

  it("holds for a defender, where clean sheets and concessions both bite", () => {
    const p = player({
      position: POSITION.DEF,
      recent: Array.from({ length: 6 }, () =>
        sample({ expectedGoals: 0.05, expectedAssists: 0.1, defensiveContribution: 11 }),
      ),
    });
    const f = fixture({
      teamDefence: 1250, opponentAttack: 1100,
      leagueMeanAttack: 1150, leagueStdAttack: 90,
      opponentDefence: 1150, leagueMeanDefence: 1150, leagueStdDefence: 90,
    });
    expect(mean(pointsDistribution(p, f))).toBeCloseTo(
      expectedPoints(p, f).total,
      0,
    );
  });

  it("gives an unavailable player all its mass on zero", () => {
    const out = pointsDistribution(
      player({
        minutes: {
          status: "u",
          chanceOfPlayingNextRound: 0,
          recentStarts: [true], recentMinutes: [90],
        },
      }),
      fixture(),
    );
    expect(atLeast(out, 1)).toBe(0);
  });

  it("puts a rotation risk's mass on zero in proportion to the risk", () => {
    const risky = pointsDistribution(
      player({
        minutes: {
          status: "a", chanceOfPlayingNextRound: null,
          recentStarts: [false, false, true, false, false, false],
          recentMinutes: [0, 12, 90, 0, 8, 0],
        },
      }),
      fixture(),
    );
    // Most of the time this player does nothing at all.
    expect(atLeast(risky, 1)).toBeLessThan(0.6);
  });

  it("separates two players who share a mean but not a shape", () => {
    // The reason the screen exists. A steady defender and a volatile forward
    // can have the same expected points and completely different ceilings.
    const forward = pointsDistribution(
      player({
        position: POSITION.FWD,
        recent: Array.from({ length: 6 }, () =>
          sample({ expectedGoals: 0.7, expectedAssists: 0.1, defensiveContribution: 0 }),
        ),
      }),
      fixture(),
    );
    const defender = pointsDistribution(
      player({
        position: POSITION.DEF,
        recent: Array.from({ length: 6 }, () =>
          sample({ expectedGoals: 0.05, expectedAssists: 0.1, defensiveContribution: 12 }),
        ),
      }),
      fixture(),
    );

    expect(quantile(forward, 0.9)).toBeGreaterThan(quantile(defender, 0.9));
  });
});

describe("rankCaptains", () => {
  const candidates = [
    { playerId: 1, input: player(), fixtures: [fixture()] },
    {
      playerId: 2,
      input: player({
        recent: Array.from({ length: 6 }, () => sample({ expectedGoals: 0.05 })),
      }),
      fixtures: [fixture()],
    },
  ];

  it("orders by expected points", () => {
    const ranked = rankCaptains(candidates);
    expect(ranked[0].playerId).toBe(1);
    expect(ranked[0].ep).toBeGreaterThan(ranked[1].ep);
  });

  it("reports a floor no higher than the ceiling", () => {
    for (const c of rankCaptains(candidates)) {
      expect(c.floor).toBeLessThanOrEqual(c.ceiling);
      expect(c.median).toBeGreaterThanOrEqual(c.floor);
      expect(c.median).toBeLessThanOrEqual(c.ceiling);
    }
  });

  it("reports probabilities that are probabilities", () => {
    for (const c of rankCaptains(candidates)) {
      for (const p of [c.pHaul, c.pBlank, c.pNoShow]) {
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
  });

  it("counts a no-show inside the blank probability", () => {
    // A player who does not appear has blanked. Reporting the two as separate
    // risks would let a reader add them and double-count.
    const risky = rankCaptains([
      {
        playerId: 3,
        input: player({
          minutes: {
            status: "a", chanceOfPlayingNextRound: null,
            recentStarts: [false, false, false, false, false, false],
            recentMinutes: [0, 0, 12, 0, 0, 0],
          },
        }),
        fixtures: [fixture()],
      },
    ])[0];
    expect(risky.pBlank).toBeGreaterThanOrEqual(risky.pNoShow);
  });

  it("returns nothing for an empty squad", () => {
    expect(rankCaptains([])).toEqual([]);
  });
});

describe("double gameweeks", () => {
  const p = player();

  it("a double is worth more than a single", () => {
    const single = rankCaptains([
      { playerId: 1, input: p, fixtures: [fixture()] },
    ])[0];
    const double = rankCaptains([
      { playerId: 1, input: p, fixtures: [fixture(), fixture({ isHome: false })] },
    ])[0];

    expect(double.ep).toBeGreaterThan(single.ep);
    expect(double.fixtures).toBe(2);
  });

  it("a double raises the ceiling faster than the mean", () => {
    // The reason a double gameweek is when captaincy matters most. Two chances
    // at a haul is more than twice as likely to produce one.
    const single = rankCaptains([
      { playerId: 1, input: p, fixtures: [fixture()] },
    ])[0];
    const double = rankCaptains([
      { playerId: 1, input: p, fixtures: [fixture(), fixture()] },
    ])[0];

    expect(double.pHaul).toBeGreaterThan(single.pHaul * 2);
  });

  it("a double makes a total blank much less likely", () => {
    const single = rankCaptains([
      { playerId: 1, input: p, fixtures: [fixture()] },
    ])[0];
    const double = rankCaptains([
      { playerId: 1, input: p, fixtures: [fixture(), fixture()] },
    ])[0];

    expect(double.pBlank).toBeLessThan(single.pBlank);
  });

  it("a blank gameweek scores nothing at all", () => {
    const blank = rankCaptains([{ playerId: 1, input: p, fixtures: [] }])[0];
    expect(blank.ep).toBe(0);
    expect(blank.fixtures).toBe(0);
    expect(blank.pHaul).toBe(0);
  });
});
