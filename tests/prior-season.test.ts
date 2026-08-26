import { projectMinutes } from "@/lib/engine/minutes";
import { describe, expect, it } from "vitest";
import {
  mostRecentRates,
  ratesFromSeason,
  type SeasonTotals,
  mostRecentWorkload,
  workloadFromSeason,
} from "@/lib/engine/prior-season";
import {
  FIRST_XG_SEASON,
  PRIOR_SEASON_MIN_MINUTES,
} from "@/lib/engine/constants";

function season(over: Partial<SeasonTotals> = {}): SeasonTotals {
  return {
    seasonName: "2025/26",
    minutes: 2700,
    starts: 30,
    expectedGoals: 15,
    expectedAssists: 9,
    bonus: 21,
    ...over,
  };
}

describe("ratesFromSeason", () => {
  it("converts season totals to per-90 rates", () => {
    const rates = ratesFromSeason(season())!;
    // 15 xG in 2700 minutes is 0.5 per 90.
    expect(rates.xGper90).toBeCloseTo(0.5, 6);
    expect(rates.xAper90).toBeCloseTo(0.3, 6);
  });

  it("divides bonus by starts", () => {
    expect(ratesFromSeason(season())!.bonusPerAppearance).toBeCloseTo(0.7, 6);
  });

  it("refuses a season from before FPL published expected goals", () => {
    // Verified against live data: every player in 2021/22 and earlier reports
    // expected_goals of 0.00. That zero is missing data dressed as a
    // measurement, and believing it models a striker as no threat at all.
    expect(
      ratesFromSeason(season({ seasonName: "2021/22", expectedGoals: 0 })),
    ).toBeNull();
    expect(
      ratesFromSeason(season({ seasonName: "2019/20", expectedGoals: 0 })),
    ).toBeNull();
  });

  it("accepts the first season that has expected goals", () => {
    expect(ratesFromSeason(season({ seasonName: FIRST_XG_SEASON }))).not.toBeNull();
  });

  it("keeps a genuine zero from a season that does have the data", () => {
    // A goalkeeper really did register no expected goals in 2025/26. That is a
    // measurement, and his bonus prior is still worth having.
    const rates = ratesFromSeason(
      season({ seasonName: "2025/26", expectedGoals: 0, bonus: 12 }),
    )!;
    expect(rates).not.toBeNull();
    expect(rates.xGper90).toBe(0);
    expect(rates.bonusPerAppearance).toBeCloseTo(0.4, 6);
  });

  it("refuses a season with no expected-goals data", () => {
    // FPL did not publish xG before 2022/23. That season is unusable, not a
    // season of zeroes — zero would tell the model the player never threatened.
    expect(ratesFromSeason(season({ expectedGoals: null }))).toBeNull();
    expect(ratesFromSeason(season({ expectedAssists: null }))).toBeNull();
  });

  it("refuses a season too thin to rate", () => {
    // One good afternoon multiplied up, arriving weighted at 0.7 in gameweek
    // one, is how a fringe player opens the season projected as elite.
    const thin = season({ minutes: PRIOR_SEASON_MIN_MINUTES - 1 });
    expect(ratesFromSeason(thin)).toBeNull();
  });

  it("accepts a season exactly at the threshold", () => {
    const rates = ratesFromSeason(
      season({ minutes: PRIOR_SEASON_MIN_MINUTES }),
    );
    expect(rates).not.toBeNull();
  });

  it("survives a season with starts recorded as zero", () => {
    // Older seasons do not report starts at all. Dividing by it must not
    // produce Infinity and poison every blend downstream.
    const rates = ratesFromSeason(season({ starts: 0, bonus: 5 }))!;
    expect(Number.isFinite(rates.bonusPerAppearance)).toBe(true);
    expect(rates.bonusPerAppearance).toBe(5);
  });

  it("reports no DefCon rate, because a season total cannot carry one", () => {
    // defensive_contribution is a total of ACTIONS. A player averaging eleven
    // might clear twelve in half his matches or in none of them, and the
    // total cannot tell them apart.
    expect(ratesFromSeason(season())!.defconHitRate).toBe(0);
  });
});

describe("mostRecentRates", () => {
  it("takes the latest season, not an average of a career", () => {
    // Blending would hide a step change — a breakout, a new position, a move
    // to a better team — behind a number that describes neither season.
    const rates = mostRecentRates([
      season({ seasonName: "2023/24", expectedGoals: 3 }),
      season({ seasonName: "2025/26", expectedGoals: 27 }),
      season({ seasonName: "2024/25", expectedGoals: 9 }),
    ])!;
    expect(rates.xGper90).toBeCloseTo((27 / 2700) * 90, 6);
  });

  it("falls back past a season it cannot use", () => {
    const rates = mostRecentRates([
      season({ seasonName: "2025/26", minutes: 120 }),
      season({ seasonName: "2024/25", expectedGoals: 18 }),
    ])!;
    expect(rates.xGper90).toBeCloseTo((18 / 2700) * 90, 6);
  });

  it("falls back past a whole pre-xG era", () => {
    // A player returning from years abroad: his most recent Premier League
    // seasons are all from before xG existed, so there is no usable prior at
    // all, and the model should say so rather than invent one.
    expect(
      mostRecentRates([
        season({ seasonName: "2021/22", expectedGoals: 0 }),
        season({ seasonName: "2020/21", expectedGoals: 0 }),
      ]),
    ).toBeNull();
  });

  it("returns nothing when no season qualifies", () => {
    expect(
      mostRecentRates([
        season({ seasonName: "2021/22", expectedGoals: null }),
        season({ seasonName: "2025/26", minutes: 50 }),
      ]),
    ).toBeNull();
  });

  it("returns nothing for a player with no history at all", () => {
    // A new signing from abroad. The model falls back to its own priors, which
    // is the honest answer.
    expect(mostRecentRates([])).toBeNull();
  });
});

describe("workload — how much a player actually played", () => {
  const season = (over: Partial<SeasonTotals> = {}): SeasonTotals => ({
    seasonName: "2025/26",
    minutes: 3000,
    starts: 34,
    expectedGoals: 10,
    expectedAssists: 5,
    bonus: 20,
    ...over,
  });

  it("reads a start rate out of 38 matches", () => {
    expect(workloadFromSeason(season({ starts: 19 }))!.startRate).toBeCloseTo(
      0.5,
      6,
    );
    expect(workloadFromSeason(season({ starts: 38 }))!.startRate).toBe(1);
  });

  it("is NOT gated on minutes, unlike the rates", () => {
    // A per-90 rate from few appearances is one match's noise multiplied up,
    // which is why `ratesFromSeason` rejects it. A start rate from few
    // appearances is not noise — it is the answer, and it is the fact that
    // most distinguishes a fringe player from a starter.
    const fringe = season({ minutes: 300, starts: 2, expectedGoals: 1 });

    expect(ratesFromSeason(fringe)).toBeNull();
    expect(workloadFromSeason(fringe)!.startRate).toBeCloseTo(2 / 38, 6);
  });

  it("survives a player who only ever came off the bench", () => {
    const sub = workloadFromSeason(season({ minutes: 600, starts: 0 }))!;
    expect(sub.startRate).toBe(0);
    expect(Number.isFinite(sub.minutesPerStart)).toBe(true);
  });

  it("returns nothing for a season with no football in it", () => {
    expect(workloadFromSeason(season({ minutes: 0, starts: 0 }))).toBeNull();
  });

  it("bounds minutes per start, so one odd season cannot skew it", () => {
    const odd = workloadFromSeason(season({ minutes: 3400, starts: 1 }))!;
    expect(odd.minutesPerStart).toBeLessThanOrEqual(90);
  });

  it("takes the most recent season the player featured in", () => {
    const workload = mostRecentWorkload([
      season({ seasonName: "2023/24", starts: 38 }),
      season({ seasonName: "2025/26", starts: 4 }),
    ])!;
    // Broke into the side, or lost his place — either way last year describes
    // him and the year before does not.
    expect(workload.startRate).toBeCloseTo(4 / 38, 6);
  });

  it("skips back past a season he missed entirely", () => {
    const workload = mostRecentWorkload([
      season({ seasonName: "2024/25", starts: 30 }),
      season({ seasonName: "2025/26", minutes: 0, starts: 0 }),
    ])!;
    expect(workload.startRate).toBeCloseTo(30 / 38, 6);
  });
});

describe("workload reaching the minutes model", () => {
  it("separates an ever-present from a fringe player before a ball is kicked", () => {
    // The bug this fixes: with no prior-season input, both fell back to the
    // same flat prior. Measured on a real squad, all fifteen came out at 41
    // expected minutes — a 3,000-minute ever-present indistinguishable from a
    // squad player — which halved every projection downstream.
    const base = {
      status: "a",
      chanceOfPlayingNextRound: null,
      recentStarts: [],
      recentMinutes: [],
    };

    const nailed = projectMinutes({
      ...base,
      priorSeason: { startRate: 36 / 38, minutesPerStart: 88, cameoRate: 0.02 },
    });
    const fringe = projectMinutes({
      ...base,
      priorSeason: { startRate: 2 / 38, minutesPerStart: 60, cameoRate: 6 / 38 },
    });

    // The fringe player's own history says two starts and about six cameos in
    // thirty-eight, so roughly one appearance in five. Asserted against that
    // rather than a round number, so the test says what it means.
    expect(fringe.pAppears).toBeCloseTo((2 + 6) / 38, 2);
    expect(nailed.pAppears).toBeGreaterThan(0.9);

    // The gap is the point: before this, both were 0.675.
    expect(nailed.pAppears / fringe.pAppears).toBeGreaterThan(4);
    expect(nailed.expectedMinutes).toBeGreaterThan(80);
    expect(fringe.expectedMinutes).toBeLessThan(15);
  });

  it("still uses the flat prior for a player nobody has data on", () => {
    // A genuine new signing, or anyone promoted from outside the league.
    const unknown = projectMinutes({
      status: "a",
      chanceOfPlayingNextRound: null,
      recentStarts: [],
      recentMinutes: [],
    });
    expect(unknown.pAppears).toBeCloseTo(0.675, 3);
  });

  const fringeLastSeason = { startRate: 1 / 38, minutesPerStart: 45, cameoRate: 0.1 };

  it("lets a full window of this season override last season", () => {
    // Observed beats remembered, once there is enough of it. A player who has
    // started every game this season is a starter whatever last season says.
    const started = projectMinutes({
      status: "a",
      chanceOfPlayingNextRound: null,
      recentStarts: [true, true, true, true, true, true],
      recentMinutes: [90, 90, 88, 90, 90, 90],
      priorSeason: fringeLastSeason,
    });
    expect(started.pAppears).toBeGreaterThan(0.9);
  });

  it("does not let ONE appearance override a season", () => {
    /*
     * This test used to assert the opposite, and the opposite shipped.
     *
     * The morning GW1 was finalised, De Cuyper's start rate went from last
     * season's 0.45 to 1.00 on the strength of one match. Expected minutes
     * nearly doubled, and since everything downstream scales with minutes a
     * £4.6m defender came out at 8.8 points a gameweek — whereupon the
     * optimiser wanted an 8-point hit to buy him.
     *
     * One start is evidence. It is not six.
     */
    const once = projectMinutes({
      status: "a",
      chanceOfPlayingNextRound: null,
      recentStarts: [true],
      recentMinutes: [90],
      priorSeason: fringeLastSeason,
    });
    expect(once.pAppears).toBeLessThan(0.4);
    // But it is not ignored either — it moves him off last season's rate.
    expect(once.pAppears).toBeGreaterThan(0.15);
  });

  it("moves toward the observed rate as evidence accumulates", () => {
    const after = (n: number) =>
      projectMinutes({
        status: "a",
        chanceOfPlayingNextRound: null,
        recentStarts: Array<boolean>(n).fill(true),
        recentMinutes: Array<number>(n).fill(90),
        priorSeason: fringeLastSeason,
      }).pAppears;

    // Monotone, which is the property that matters: no gameweek should ever
    // move a player AWAY from what he has been observed doing.
    expect(after(1)).toBeLessThan(after(3));
    expect(after(3)).toBeLessThan(after(6));
    expect(after(6)).toBeGreaterThan(0.9);
  });

  it("shrinks minutes-per-start on the same schedule", () => {
    // Left unshrunk this undid half the fix: the start rate would be pulled
    // back toward last season while minutes-per-start stayed pinned at 90.
    const once = projectMinutes({
      status: "a",
      chanceOfPlayingNextRound: null,
      recentStarts: [true],
      recentMinutes: [90],
      priorSeason: { startRate: 1, minutesPerStart: 45, cameoRate: 0 },
    });
    const full = projectMinutes({
      status: "a",
      chanceOfPlayingNextRound: null,
      recentStarts: [true, true, true, true, true, true],
      recentMinutes: [90, 90, 90, 90, 90, 90],
      priorSeason: { startRate: 1, minutesPerStart: 45, cameoRate: 0 },
    });
    expect(once.expectedMinutes).toBeLessThan(full.expectedMinutes);
    expect(full.expectedMinutes).toBeGreaterThan(85);
  });

  it("does not resurrect an injured player", () => {
    const injured = projectMinutes({
      status: "i",
      chanceOfPlayingNextRound: 0,
      recentStarts: [],
      recentMinutes: [],
      priorSeason: { startRate: 1, minutesPerStart: 90, cameoRate: 0 },
    });
    expect(injured.pAppears).toBe(0);
  });
});
