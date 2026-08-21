import { describe, expect, it } from "vitest";
import {
  basisFor,
  blendFits,
  blendSeasons,
  blendWeight,
  interpolate,
  fitRatings,
  fitTeamStrengths,
  priorForUnrated,
  unratedIn,
  type MatchResult,
} from "@/lib/engine/team-ratings";
import { expectedGoals, scoreline, outcomeProbabilities } from "@/lib/engine/scoreline";

/**
 * A synthetic league with known answers.
 *
 * Every club plays every other home and away, and goals are generated from
 * strengths the test knows — so the fit can be checked against the truth
 * rather than against itself.
 */
function syntheticLeague(
  truth: Record<string, { attack: number; defence: number }>,
  leagueMean = 1.4,
  homeAdvantage = 1.1,
): MatchResult[] {
  const teams = Object.keys(truth);
  const matches: MatchResult[] = [];

  for (const home of teams) {
    for (const away of teams) {
      if (home === away) continue;
      const lh = leagueMean * truth[home].attack * truth[away].defence * homeAdvantage;
      const la = (leagueMean * truth[away].attack * truth[home].defence) / homeAdvantage;
      // Expectations rather than samples: the fit should recover the
      // parameters exactly when handed noiseless data, and a test that has to
      // tolerate sampling noise cannot tell a bias from a seed.
      matches.push({
        home,
        away,
        homeGoals: lh,
        awayGoals: la,
        homeXg: lh,
        awayXg: la,
      });
    }
  }
  return matches;
}

const TRUTH = {
  Strong: { attack: 1.5, defence: 0.7 },
  Good: { attack: 1.2, defence: 0.9 },
  Average: { attack: 1.0, defence: 1.0 },
  Poor: { attack: 0.8, defence: 1.2 },
  Awful: { attack: 0.6, defence: 1.5 },
};

describe("fitting", () => {
  const fit = fitTeamStrengths(syntheticLeague(TRUTH), "goals", {
    ridge: 0,
    iterations: 20000,
  });

  it("recovers the strengths it was generated from", () => {
    for (const [team, truth] of Object.entries(TRUTH)) {
      const found = fit.strength.get(team)!;
      // Ratings are identified only up to a shared scale, which re-centring
      // pins — so these should land on the truth, not merely in proportion.
      expect(found.attack).toBeCloseTo(truth.attack, 1);
      expect(found.defence).toBeCloseTo(truth.defence, 1);
    }
  });

  it("recovers the league mean and home advantage", () => {
    expect(fit.leagueMean).toBeCloseTo(1.4, 1);
    expect(fit.homeAdvantage).toBeCloseTo(1.1, 1);
  });

  it("round-trips through the scoreline model", () => {
    // The fit's output is fed straight into `scoreline.ts` with no conversion,
    // so the two conventions have to agree. If `defence` were oriented the
    // other way this is the test that would catch it.
    const strong = fit.strength.get("Strong")!;
    const awful = fit.strength.get("Awful")!;
    const { home, away } = expectedGoals(strong, awful, {
      leagueMean: fit.leagueMean,
      homeAdvantage: fit.homeAdvantage,
    });

    expect(home).toBeCloseTo(1.4 * 1.5 * 1.5 * 1.1, 0);
    expect(away).toBeCloseTo((1.4 * 0.6 * 0.7) / 1.1, 1);
    expect(
      outcomeProbabilities(
        scoreline(strong, awful, {
          leagueMean: fit.leagueMean,
          homeAdvantage: fit.homeAdvantage,
        }),
      ).home,
    ).toBeGreaterThan(0.8);
  });

  it("orders clubs the way the truth does", () => {
    const byAttack = [...fit.strength.entries()].sort(
      (a, b) => b[1].attack - a[1].attack,
    );
    expect(byAttack.map(([t]) => t)).toEqual([
      "Strong",
      "Good",
      "Average",
      "Poor",
      "Awful",
    ]);
  });

  it("keeps ratings centred on one", () => {
    const attacks = [...fit.strength.values()].map((s) => s.attack);
    const geometricMean = Math.exp(
      attacks.reduce((sum, a) => sum + Math.log(a), 0) / attacks.length,
    );
    expect(geometricMean).toBeCloseTo(1, 6);
  });
});

describe("the ridge penalty", () => {
  it("stops an unbeaten club running away to infinity", () => {
    // Three matches, one club scoring in all of them and conceding nothing.
    // Unpenalised, the likelihood is maximised by sending its attack up and
    // the opponents' defence down without limit.
    const matches: MatchResult[] = [
      { home: "A", away: "B", homeGoals: 4, awayGoals: 0, homeXg: 4, awayXg: 0 },
      { home: "A", away: "C", homeGoals: 5, awayGoals: 0, homeXg: 5, awayXg: 0 },
      { home: "B", away: "C", homeGoals: 1, awayGoals: 1, homeXg: 1, awayXg: 1 },
    ];

    const loose = fitTeamStrengths(matches, "goals", { ridge: 0 });
    const tight = fitTeamStrengths(matches, "goals", { ridge: 0.2 });

    expect(tight.strength.get("A")!.attack).toBeLessThan(
      loose.strength.get("A")!.attack,
    );
    expect(tight.strength.get("A")!.attack).toBeGreaterThan(1);
    for (const s of tight.strength.values()) {
      expect(Number.isFinite(s.attack)).toBe(true);
      expect(Number.isFinite(s.defence)).toBe(true);
    }
  });
});

describe("nothing to fit", () => {
  it("returns everyone average rather than a NaN", () => {
    const fit = fitTeamStrengths([], "goals");
    expect(fit.matches).toBe(0);
    expect(fit.strength.size).toBe(0);
  });

  it("survives a goalless set of matches", () => {
    const fit = fitTeamStrengths(
      [{ home: "A", away: "B", homeGoals: 0, awayGoals: 0, homeXg: 0, awayXg: 0 }],
      "goals",
    );
    for (const s of fit.strength.values()) {
      expect(s.attack).toBe(1);
      expect(s.defence).toBe(1);
    }
  });
});

describe("blending", () => {
  it("sits between the two fits", () => {
    const matches = syntheticLeague(TRUTH).map((m) => ({
      ...m,
      // xG says this club is better than its goals did.
      homeXg: m.home === "Poor" ? m.homeGoals * 2 : m.homeGoals,
    }));

    const goals = fitTeamStrengths(matches, "goals");
    const xg = fitTeamStrengths(matches, "xg");
    const blended = blendFits(goals, xg, 0.65);

    const g = goals.strength.get("Poor")!.attack;
    const x = xg.strength.get("Poor")!.attack;
    const b = blended.strength.get("Poor")!.attack;

    expect(b).toBeGreaterThan(Math.min(g, x));
    expect(b).toBeLessThan(Math.max(g, x));
    // Weighted toward xG, which measured better — and GEOMETRIC, because
    // these are multipliers.
    expect(b).toBeCloseTo(g ** 0.35 * x ** 0.65, 10);
  });

  it("keeps a blend centred, which arithmetic mixing would not", () => {
    // The fit pins the geometric mean of every rating set to exactly 1.
    // Averaging two centred sets arithmetically drifts off centre, and a
    // league whose ratings average above 1 silently scores more goals.
    const a = fitTeamStrengths(syntheticLeague(TRUTH), "goals");
    const b = fitTeamStrengths(
      syntheticLeague({
        ...TRUTH,
        Strong: { attack: 2.2, defence: 0.5 },
      }),
      "goals",
    );

    const centre = (fit: typeof a) => {
      const values = [...fit.strength.values()].map((s) => s.attack);
      return Math.exp(
        values.reduce((sum, v) => sum + Math.log(v), 0) / values.length,
      );
    };
    expect(centre(blendSeasons(a, b, 0.5))).toBeCloseTo(1, 6);
  });

  it("fitRatings blends both targets", () => {
    const fit = fitRatings(syntheticLeague(TRUTH));
    expect(fit.strength.get("Strong")!.attack).toBeGreaterThan(
      fit.strength.get("Awful")!.attack,
    );
  });
});

describe("clubs the fit never saw", () => {
  const fit = fitTeamStrengths(syntheticLeague(TRUTH), "goals");
  // Two of the five went down; two new clubs came up.
  const current = ["Strong", "Good", "Average", "Promoted1", "Promoted2"];

  it("finds who is missing, in both directions", () => {
    expect(unratedIn(fit, current).sort()).toEqual(["Promoted1", "Promoted2"]);
    expect(unratedIn(fit, current, true).sort()).toEqual(["Awful", "Poor"]);
  });

  it("prices a promoted side like the clubs it replaced", () => {
    const prior = priorForUnrated(fit, current);
    const poor = fit.strength.get("Poor")!;
    const awful = fit.strength.get("Awful")!;

    expect(prior.attack).toBeCloseTo((poor.attack + awful.attack) / 2, 6);
    expect(prior.defence).toBeCloseTo((poor.defence + awful.defence) / 2, 6);
    // And that is a weak side, which is the point.
    expect(prior.attack).toBeLessThan(1);
    expect(prior.defence).toBeGreaterThan(1);
  });

  it("falls back to average when nobody left", () => {
    const prior = priorForUnrated(fit, Object.keys(TRUTH));
    expect(prior).toEqual({ attack: 1, defence: 1 });
  });
});

describe("moving from last season to this one", () => {
  it("counts nothing before anything is played", () => {
    expect(blendWeight(0)).toBe(0);
    expect(blendWeight(-1)).toBe(0);
    expect(blendWeight(Number.NaN)).toBe(0);
  });

  it("ramps to full weight over fifteen matches a club", () => {
    // Measured: a frozen prior DECAYS as the league drifts (RPS 0.2166 early
    // against 0.2295 late), and switching outright is far worse than doing
    // nothing early (0.2640 over GW1-6). Fifteen was the best of the sweep.
    expect(blendWeight(7.5)).toBeCloseTo(0.5, 10);
    expect(blendWeight(15)).toBe(1);
    expect(blendWeight(38)).toBe(1);
  });

  it("rises monotonically", () => {
    let previous = -1;
    for (const played of [0, 1, 3, 6, 10, 15, 20]) {
      const w = blendWeight(played);
      expect(w).toBeGreaterThanOrEqual(previous);
      previous = w;
    }
  });

  it("reports a basis the screens can print", () => {
    expect(basisFor(blendWeight(0))).toBe("prior-season");
    expect(basisFor(blendWeight(6))).toBe("blended");
    expect(basisFor(blendWeight(15))).toBe("this-season");
  });

  it("interpolates geometrically between the ends", () => {
    expect(interpolate(2, 8, 0)).toBeCloseTo(2, 10);
    expect(interpolate(2, 8, 1)).toBeCloseTo(8, 10);
    expect(interpolate(2, 8, 0.5)).toBeCloseTo(4, 10); // not 5
  });

  it("returns each end unchanged at the extremes", () => {
    const prior = fitTeamStrengths(syntheticLeague(TRUTH), "goals");
    const current = fitTeamStrengths(
      syntheticLeague({ ...TRUTH, Poor: { attack: 1.4, defence: 0.8 } }),
      "goals",
    );

    expect(blendSeasons(prior, current, 0).strength.get("Poor")!.attack).toBeCloseTo(
      prior.strength.get("Poor")!.attack,
      10,
    );
    expect(blendSeasons(prior, current, 1).strength.get("Poor")!.attack).toBeCloseTo(
      current.strength.get("Poor")!.attack,
      10,
    );
  });

  it("keeps a club that exists in only one of the two seasons", () => {
    // A promoted side has no prior and a relegated one has no current.
    // Dragging either toward a number that was never about it would be worse
    // than leaving it alone.
    const prior = fitTeamStrengths(syntheticLeague(TRUTH), "goals");
    const current = fitTeamStrengths(
      syntheticLeague({
        Strong: TRUTH.Strong,
        Good: TRUTH.Good,
        Average: TRUTH.Average,
        Promoted: { attack: 0.5, defence: 1.6 },
      }),
      "goals",
    );

    const blended = blendSeasons(prior, current, 0.4);
    expect(blended.strength.get("Promoted")).toEqual(
      current.strength.get("Promoted"),
    );
    expect(blended.strength.get("Awful")).toEqual(prior.strength.get("Awful"));
  });
});

describe("blending against the prior, not against the last blend", () => {
  const prior = fitTeamStrengths(syntheticLeague(TRUTH), "goals");
  const current = fitTeamStrengths(
    syntheticLeague({ ...TRUTH, Awful: { attack: 1.5, defence: 0.7 } }),
    "goals",
  );

  it("reaches the same answer however many times it runs", () => {
    // Every refit blends the STORED PRIOR with this season. Running it three
    // times at the same weight must land in the same place as running it once,
    // because nothing in between is allowed to move the prior.
    const once = blendSeasons(prior, current, 0.4);
    let repeated = blendSeasons(prior, current, 0.4);
    for (let i = 0; i < 2; i++) repeated = blendSeasons(prior, current, 0.4);

    expect(repeated.strength.get("Awful")!.attack).toBeCloseTo(
      once.strength.get("Awful")!.attack,
      12,
    );
  });

  it("would drift if it blended against its own output instead", () => {
    // The failure `prior_attack` exists to prevent, demonstrated rather than
    // described: feed each blend back in as the prior and the rating walks
    // toward this season with no schedule controlling it, ending somewhere
    // neither season supports.
    const correct = blendSeasons(prior, current, 0.4);

    let compounding = prior;
    for (let i = 0; i < 3; i++) {
      compounding = blendSeasons(compounding, current, 0.4);
    }

    const target = current.strength.get("Awful")!.attack;
    const start = prior.strength.get("Awful")!.attack;

    // Both move the same direction, but the compounding one has travelled
    // much further than the weight it was given.
    expect(Math.abs(compounding.strength.get("Awful")!.attack - target)).toBeLessThan(
      Math.abs(correct.strength.get("Awful")!.attack - target),
    );
    expect(Math.abs(correct.strength.get("Awful")!.attack - start)).toBeLessThan(
      Math.abs(compounding.strength.get("Awful")!.attack - start),
    );
  });
});
