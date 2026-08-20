import { describe, expect, it } from "vitest";
import {
  mostRecentRates,
  ratesFromSeason,
  type SeasonTotals,
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
