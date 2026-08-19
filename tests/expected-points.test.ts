import { describe, expect, it } from "vitest";
import {
  expectedConcededPenaltySteps,
  expectedPoints,
  expectedPointsOverHorizon,
  opponentAdjustment,
  poissonZero,
  shrinkageWeight,
  type FixtureContext,
  type GameweekSample,
  type PlayerModelInput,
} from "@/lib/engine/expected-points";
import { projectMinutes } from "@/lib/engine/minutes";
import { POSITION } from "@/lib/rules";

function sample(over: Partial<GameweekSample> = {}): GameweekSample {
  return {
    minutes: 90,
    started: true,
    expectedGoals: 0.3,
    expectedAssists: 0.2,
    defensiveContribution: 4,
    bonus: 1,
    goalsConceded: 1,
    yellowCards: 0,
    redCards: 0,
    ...over,
  };
}

function player(over: Partial<PlayerModelInput> = {}): PlayerModelInput {
  return {
    playerId: 1,
    position: POSITION.MID,
    teamId: 1,
    minutes: {
      status: "a",
      chanceOfPlayingNextRound: null,
      recentStarts: [true, true, true, true, true, true],
      recentMinutes: [90, 90, 90, 90, 90, 90],
    },
    recent: [sample(), sample(), sample(), sample(), sample(), sample()],
    priorSeason: null,
    ...over,
  };
}

/** A neutral fixture with no usable strength ratings — the pre-season state. */
function fixture(over: Partial<FixtureContext> = {}): FixtureContext {
  return {
    gw: 10,
    isHome: true,
    teamDefence: null,
    opponentAttack: null,
    leagueMeanAttack: null,
    leagueStdAttack: null,
    opponentDefence: null,
    leagueMeanDefence: null,
    leagueStdDefence: null,
    ...over,
  };
}

describe("minutes", () => {
  it("is a hard zero for anyone not available", () => {
    // The model must never hedge here. An injured player scores nothing, and a
    // model that gives them 30% of their output will recommend them.
    for (const status of ["i", "s", "u", "d"]) {
      const p = projectMinutes({
        status,
        chanceOfPlayingNextRound: 75,
        recentStarts: [true, true, true],
        recentMinutes: [90, 90, 90],
      });
      expect(p.pAppears).toBe(0);
    }
  });

  it("lets an explicit club statement outrank history", () => {
    const nailed = { status: "a", recentStarts: [true, true, true, true], recentMinutes: [90, 90, 90, 90] };
    const certain = projectMinutes({ ...nailed, chanceOfPlayingNextRound: null });
    const doubtful = projectMinutes({ ...nailed, chanceOfPlayingNextRound: 25 });
    expect(doubtful.pAppears).toBeLessThan(certain.pAppears);
  });

  it("sits mid-range, not at starter level, with no appearance history", () => {
    // Pre-season, or a new signing. The model has no role information, so it
    // must not project a certain starter — but nor should it assume a
    // bench-warmer, which would make every pre-season number useless.
    const unknown = projectMinutes({
      status: "a",
      chanceOfPlayingNextRound: null,
      recentStarts: [],
      recentMinutes: [],
    });
    const nailed = projectMinutes({
      status: "a",
      chanceOfPlayingNextRound: null,
      recentStarts: [true, true, true, true, true, true],
      recentMinutes: [90, 90, 90, 90, 90, 90],
    });

    expect(unknown.pSixty).toBeGreaterThan(0);
    expect(unknown.pSixty).toBeLessThan(nailed.pSixty * 0.7);
  });

  it("treats a reported chance of 100 exactly like no news", () => {
    // Both mean the club has no fitness concern, and neither says anything
    // about whether the player starts. Reading 100 as a positive signal put the
    // 13 players just cleared from injury above all 467 with no news at all.
    const base = {
      status: "a",
      recentStarts: [true, true, true, false, true, true],
      recentMinutes: [90, 88, 90, 0, 76, 90],
    };
    expect(projectMinutes({ ...base, chanceOfPlayingNextRound: 100 })).toEqual(
      projectMinutes({ ...base, chanceOfPlayingNextRound: null }),
    );
  });

  it("scales a nailed starter down when the club reports a doubt", () => {
    // Fitness multiplies role rather than replacing it, so a doubtful nailed
    // starter still outranks a doubtful fringe player.
    const nailed = { recentStarts: [true, true, true, true], recentMinutes: [90, 90, 90, 90] };
    const fringe = { recentStarts: [false, false, true, false], recentMinutes: [0, 0, 20, 0] };
    const a = projectMinutes({ status: "a", chanceOfPlayingNextRound: 50, ...nailed });
    const b = projectMinutes({ status: "a", chanceOfPlayingNextRound: 50, ...fringe });
    const full = projectMinutes({ status: "a", chanceOfPlayingNextRound: null, ...nailed });

    expect(a.pSixty).toBeLessThan(full.pSixty);
    expect(a.pSixty).toBeGreaterThan(b.pSixty);
  });
});

describe("shrinkageWeight", () => {
  it("leans on last season at GW1 and ignores it from GW6", () => {
    expect(shrinkageWeight(1)).toBeCloseTo(0.7, 6);
    expect(shrinkageWeight(6)).toBe(0);
    expect(shrinkageWeight(10)).toBe(0);
  });

  it("decays monotonically in between", () => {
    const weights = [1, 2, 3, 4, 5, 6].map(shrinkageWeight);
    for (let i = 1; i < weights.length; i++) {
      expect(weights[i]).toBeLessThan(weights[i - 1]);
    }
  });
});

describe("opponentAdjustment", () => {
  it("is exactly neutral when ratings carry no information", () => {
    // Pre-season every strength rating is zero. Neutral is the correct answer
    // here, not a fallback — and never a division by a zero league mean.
    expect(opponentAdjustment(null, null, null)).toBe(1);
    expect(opponentAdjustment(0, 0, 0)).toBe(1);
    expect(opponentAdjustment(1200, 1200, 0)).toBe(1);
  });

  it("raises output against a weak opponent and lowers it against a strong one", () => {
    const weak = opponentAdjustment(1000, 1200, 100);
    const strong = opponentAdjustment(1400, 1200, 100);
    expect(weak).toBeGreaterThan(1);
    expect(strong).toBeLessThan(1);
  });

  it("clamps so one fixture cannot dominate a horizon", () => {
    expect(opponentAdjustment(1, 1200, 10)).toBeLessThanOrEqual(1.5);
    expect(opponentAdjustment(9999, 1200, 10)).toBeGreaterThanOrEqual(0.6);
  });
});

describe("goals conceded", () => {
  it("costs a point per TWO goals, not per goal", () => {
    // E[floor(X/2)] is materially below lambda/2 at realistic rates. Getting
    // this wrong overstates the penalty on every defender in the game.
    const lambda = 1.4;
    expect(expectedConcededPenaltySteps(lambda)).toBeLessThan(lambda / 2);
    expect(expectedConcededPenaltySteps(lambda)).toBeGreaterThan(0.2);
  });

  it("rises with the expected goals against", () => {
    expect(expectedConcededPenaltySteps(2.5)).toBeGreaterThan(
      expectedConcededPenaltySteps(0.8),
    );
  });

  it("is near zero for a team that concedes almost nothing", () => {
    expect(expectedConcededPenaltySteps(0.05)).toBeLessThan(0.01);
  });
});

describe("poissonZero", () => {
  it("is the clean sheet probability", () => {
    expect(poissonZero(0)).toBe(1);
    expect(poissonZero(1.4)).toBeCloseTo(0.2466, 3);
    expect(poissonZero(3)).toBeLessThan(0.06);
  });
});

describe("expectedPoints", () => {
  it("returns a zeroed breakdown for an unavailable player", () => {
    const result = expectedPoints(
      player({
        minutes: {
          status: "i",
          chanceOfPlayingNextRound: 0,
          recentStarts: [true],
          recentMinutes: [90],
        },
      }),
      fixture(),
    );
    expect(result.total).toBe(0);
    expect(result.pMinutes).toBe(0);
  });

  it("sums its own components", () => {
    const r = expectedPoints(player(), fixture());
    const sum =
      r.appearance + r.goals + r.assists + r.cleanSheet + r.defcon + r.bonus +
      r.goalsConceded + r.cards;
    expect(r.total).toBeCloseTo(sum, 9);
  });

  it("prefers a nailed average player to a flagged brilliant one", () => {
    // The single most important behaviour in the model.
    const brilliant = player({
      recent: Array.from({ length: 6 }, () =>
        sample({ expectedGoals: 0.9, expectedAssists: 0.5, bonus: 2 }),
      ),
      minutes: {
        status: "a",
        chanceOfPlayingNextRound: 25,
        recentStarts: [true, true, true, true, true, true],
        recentMinutes: [90, 90, 90, 90, 90, 90],
      },
    });
    const nailed = player({
      recent: Array.from({ length: 6 }, () =>
        sample({ expectedGoals: 0.2, expectedAssists: 0.15, bonus: 0 }),
      ),
    });

    expect(expectedPoints(nailed, fixture()).total).toBeGreaterThan(
      expectedPoints(brilliant, fixture()).total,
    );
  });

  it("pays goalkeepers and defenders more for a clean sheet than midfielders", () => {
    const easy = fixture({
      teamDefence: 1400,
      opponentAttack: 900,
      leagueMeanAttack: 1200,
      leagueStdAttack: 150,
      leagueMeanDefence: 1200,
      leagueStdDefence: 150,
    });
    const def = expectedPoints(player({ position: POSITION.DEF }), easy);
    const mid = expectedPoints(player({ position: POSITION.MID }), easy);
    expect(def.cleanSheet).toBeGreaterThan(mid.cleanSheet);
  });

  it("penalises only goalkeepers and defenders for conceding", () => {
    const f = fixture();
    expect(expectedPoints(player({ position: POSITION.DEF }), f).goalsConceded)
      .toBeLessThan(0);
    expect(expectedPoints(player({ position: POSITION.FWD }), f).goalsConceded)
      .toBe(0);
  });

  it("gives forwards essentially no defensive contribution points", () => {
    const fwd = expectedPoints(
      player({ position: POSITION.FWD, recent: [] }),
      fixture(),
    );
    const def = expectedPoints(
      player({ position: POSITION.DEF, recent: [] }),
      fixture(),
    );
    expect(fwd.defcon).toBeLessThan(def.defcon);
  });

  it("leans on prior-season rates at GW1 and not at all by GW6", () => {
    // Weak current form, strong prior season. Early on the prior pulls the
    // projection up; by GW6 the shrinkage has decayed to zero and only this
    // season counts, so the same player projects lower.
    const p = player({
      recent: Array.from({ length: 6 }, () =>
        sample({ expectedGoals: 0.05, expectedAssists: 0.05, bonus: 0 }),
      ),
      priorSeason: {
        xGper90: 0.8,
        xAper90: 0.4,
        bonusPerAppearance: 1.5,
        defconHitRate: 0.1,
      },
    });
    const early = expectedPoints(p, fixture({ gw: 1 })).total;
    const later = expectedPoints(p, fixture({ gw: 6 })).total;
    expect(early).toBeGreaterThan(later);
  });

  it("uses the prior season in full when there is no current-season data", () => {
    // Deliberate, and worth pinning: shrinkage blends TOWARD the prior, it does
    // not blend toward zero. With no data this season the prior is the only
    // information available, so it is used at full weight at every gameweek —
    // whether that is GW1 or GW20. Judging that the player has stopped playing
    // is the minutes model's job, not the rate model's.
    const p = player({
      recent: [],
      priorSeason: {
        xGper90: 0.8,
        xAper90: 0.4,
        bonusPerAppearance: 1.5,
        defconHitRate: 0.1,
      },
    });
    expect(expectedPoints(p, fixture({ gw: 1 })).total).toBeCloseTo(
      expectedPoints(p, fixture({ gw: 20 })).total,
      9,
    );
  });
});

describe("expectedPointsOverHorizon", () => {
  const p = player();

  it("counts both fixtures in a double gameweek", () => {
    const single = expectedPointsOverHorizon(p, [fixture({ gw: 5 })], [5]);
    const double = expectedPointsOverHorizon(
      p,
      [fixture({ gw: 5 }), fixture({ gw: 5, isHome: false })],
      [5],
    );
    expect(double.perGameweek[0].fixtures).toBe(2);
    expect(double.total).toBeGreaterThan(single.total * 1.8);
  });

  it("scores a blank gameweek as zero rather than skipping it", () => {
    const result = expectedPointsOverHorizon(p, [fixture({ gw: 5 })], [5, 6]);
    expect(result.perGameweek).toHaveLength(2);
    expect(result.perGameweek[1]).toMatchObject({ gw: 6, ep: 0, fixtures: 0 });
  });

  it("discounts later gameweeks", () => {
    const fixtures = [1, 2, 3, 4, 5].map((gw) => fixture({ gw }));
    const result = expectedPointsOverHorizon(p, fixtures, [1, 2, 3, 4, 5]);
    for (let i = 1; i < result.perGameweek.length; i++) {
      expect(result.perGameweek[i].ep).toBeLessThan(
        result.perGameweek[i - 1].ep,
      );
    }
  });

  it("prefers steady fixtures to one great week and four bad ones", () => {
    // The behaviour that stops the model chasing last week's points.
    const ratings = {
      leagueMeanDefence: 1200,
      leagueStdDefence: 150,
      leagueMeanAttack: 1200,
      leagueStdAttack: 150,
      teamDefence: 1200,
      opponentAttack: 1200,
    };
    const spiky = [1, 2, 3, 4, 5].map((gw) =>
      fixture({ ...ratings, gw, opponentDefence: gw === 1 ? 850 : 1500 }),
    );
    const steady = [1, 2, 3, 4, 5].map((gw) =>
      fixture({ ...ratings, gw, opponentDefence: 1150 }),
    );
    const gws = [1, 2, 3, 4, 5];
    expect(expectedPointsOverHorizon(p, steady, gws).total).toBeGreaterThan(
      expectedPointsOverHorizon(p, spiky, gws).total,
    );
  });
});
