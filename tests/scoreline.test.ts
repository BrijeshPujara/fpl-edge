import { describe, expect, it } from "vitest";
import {
  bothTeamsToScore,
  cleanSheetProbabilities,
  expectedGoals,
  expectedSupremacy,
  mostLikelyScores,
  ACTIVE_SCORE_SUMMARY,
  SCORE_SUMMARIES,
  captionFor,
  expectedScoreByOutcome,
  mostLikelyScoreByOutcome,
  outcomeOf,
  outcomeProbabilities,
  overUnder,
  logLoss,
  rankedProbabilityScore,
  scoreline,
  scorelineFrom,
  totalGoalsDistribution,
  type TeamStrength,
} from "@/lib/engine/scoreline";
import { poissonZero } from "@/lib/engine/expected-points";
import {
  DIXON_COLES_RHO,
  HOME_ADVANTAGE,
  LEAGUE_MEAN_GOALS_PER_TEAM,
  MAX_GOALS,
} from "@/lib/engine/constants";

const AVERAGE: TeamStrength = { attack: 1, defence: 1 };
const total = (grid: number[][]) =>
  grid.reduce((sum, row) => sum + row.reduce((a, b) => a + b, 0), 0);

describe("expected goals", () => {
  it("splits home advantage evenly, so the league mean survives it", () => {
    const { home, away } = expectedGoals(AVERAGE, AVERAGE);

    // The ratio between the sides is the SQUARE of the constant, because one
    // side is multiplied and the other divided.
    expect(home / away).toBeCloseTo(HOME_ADVANTAGE ** 2, 10);
    expect(Math.sqrt(home * away)).toBeCloseTo(LEAGUE_MEAN_GOALS_PER_TEAM, 10);
  });

  it("crosses attack against the OPPONENT's defence", () => {
    // The silent bug this guards: multiplying a team by its own defence leaves
    // every number plausible and every ranking wrong.
    const leaky: TeamStrength = { attack: 1, defence: 2 };
    const { home, away } = expectedGoals(leaky, AVERAGE);
    const base = expectedGoals(AVERAGE, AVERAGE);

    expect(home).toBeCloseTo(base.home, 10); // his own leakiness must not help him
    expect(away).toBeCloseTo(base.away * 2, 10); // it helps his opponent
  });

  it("multiplies attack and opponent weakness together", () => {
    const strong: TeamStrength = { attack: 1.5, defence: 1 };
    const weak: TeamStrength = { attack: 1, defence: 1.2 };
    const { home } = expectedGoals(strong, weak);

    expect(home).toBeCloseTo(
      LEAGUE_MEAN_GOALS_PER_TEAM * 1.5 * 1.2 * HOME_ADVANTAGE,
      10,
    );
  });

  it("never returns a rate of zero, because no fixture is a certainty", () => {
    const dead: TeamStrength = { attack: 0, defence: 0 };
    const { home, away } = expectedGoals(dead, dead);
    expect(home).toBeGreaterThan(0);
    expect(away).toBeGreaterThan(0);
  });

  it("survives a rate that is not a number", () => {
    const broken = { attack: Number.NaN, defence: 1 } as TeamStrength;
    expect(expectedGoals(broken, AVERAGE).home).toBeGreaterThan(0);
  });
});

describe("the grid", () => {
  it("sums to one, corrected or not", () => {
    for (const rho of [0, DIXON_COLES_RHO]) {
      for (const [h, a] of [[0.4, 0.3], [1.5, 1.2], [3.2, 0.6]]) {
        expect(total(scorelineFrom(h, a, { rho }).grid)).toBeCloseTo(1, 10);
      }
    }
  });

  it("folds the tail into the top cell rather than losing it", () => {
    // At this rate there is real mass beyond ten goals. Discarding it would
    // leave the grid summing to less than one and every probability read off
    // it fractionally low.
    const { grid } = scorelineFrom(8, 8, { rho: 0 });
    expect(total(grid)).toBeCloseTo(1, 10);
    expect(grid[MAX_GOALS][MAX_GOALS]).toBeGreaterThan(0);
  });

  it("is exactly independent when the correction is off", () => {
    const { grid } = scorelineFrom(1.8, 1.1, { rho: 0 });
    const marginal = (lambda: number, k: number) => {
      let mass = Math.exp(-lambda);
      for (let i = 1; i <= k; i++) mass = (mass * lambda) / i;
      return mass;
    };

    for (const [h, a] of [[0, 0], [2, 1], [3, 3]]) {
      expect(grid[h][a]).toBeCloseTo(marginal(1.8, h) * marginal(1.1, a), 12);
    }
  });
});

describe("agreement with the rest of the engine", () => {
  it("gives the same clean sheet as poissonZero when uncorrected", () => {
    // `expected-points.ts` computes clean sheets as exp(-lambda). If these two
    // ever disagree the app has two models of the same match, and the screens
    // built on them will quietly contradict each other.
    const s = scorelineFrom(1.7, 0.9, { rho: 0 });
    const cs = cleanSheetProbabilities(s);

    expect(cs.home).toBeCloseTo(poissonZero(0.9), 12);
    expect(cs.away).toBeCloseTo(poissonZero(1.7), 12);
  });

  it("moves clean sheets only slightly once corrected", () => {
    // The correction reweights the low-scoring corner, so the marginals shift.
    // Small, but real — worth pinning so a future change to rho cannot quietly
    // swing clean sheets around.
    const cs = cleanSheetProbabilities(scorelineFrom(1.7, 0.9));
    expect(cs.home).toBeGreaterThan(poissonZero(0.9) - 0.03);
    expect(cs.home).toBeLessThan(poissonZero(0.9) + 0.03);
  });
});

describe("outcomes", () => {
  it("sums to one", () => {
    const { home, draw, away } = outcomeProbabilities(scoreline(AVERAGE, AVERAGE));
    expect(home + draw + away).toBeCloseTo(1, 10);
  });

  it("is symmetric between identical teams on a neutral ground", () => {
    const o = outcomeProbabilities(
      scoreline(AVERAGE, AVERAGE, { homeAdvantage: 1 }),
    );
    expect(o.home).toBeCloseTo(o.away, 10);
    expect(o.draw).toBeGreaterThan(0.2);
  });

  it("favours the home side between identical teams on a real ground", () => {
    const o = outcomeProbabilities(scoreline(AVERAGE, AVERAGE));
    expect(o.home).toBeGreaterThan(o.away);
  });

  it("rises monotonically with home attack", () => {
    let previous = 0;
    for (const attack of [0.6, 0.8, 1.0, 1.3, 1.6]) {
      const o = outcomeProbabilities(scoreline({ attack, defence: 1 }, AVERAGE));
      expect(o.home).toBeGreaterThan(previous);
      previous = o.home;
    }
  });

  it("rises with the opponent's leakiness too", () => {
    const tight = outcomeProbabilities(
      scoreline(AVERAGE, { attack: 1, defence: 0.7 }),
    );
    const leaky = outcomeProbabilities(
      scoreline(AVERAGE, { attack: 1, defence: 1.4 }),
    );
    expect(leaky.home).toBeGreaterThan(tight.home);
  });
});

describe("the low-score correction", () => {
  it("raises the chance of a draw, which is the whole reason it exists", () => {
    // Independent Poissons predicted draws in 23.6% of 2025/26 matches when
    // 29.6% were drawn. This is the fix, and its direction is the part the
    // measurement establishes firmly.
    const uncorrected = outcomeProbabilities(scorelineFrom(1.5, 1.2, { rho: 0 }));
    const corrected = outcomeProbabilities(scorelineFrom(1.5, 1.2));

    expect(corrected.draw).toBeGreaterThan(uncorrected.draw);
  });

  it("moves mass onto the level low scores and off the 1-0s", () => {
    const plain = scorelineFrom(1.5, 1.2, { rho: 0 }).grid;
    const fixed = scorelineFrom(1.5, 1.2).grid;

    expect(fixed[0][0]).toBeGreaterThan(plain[0][0]);
    expect(fixed[1][1]).toBeGreaterThan(plain[1][1]);
    expect(fixed[1][0]).toBeLessThan(plain[1][0]);
    expect(fixed[0][1]).toBeLessThan(plain[0][1]);
  });

  it("keeps every cell a probability even when the correction overshoots", () => {
    // tau goes negative once |rho| * lambda passes one. Negative mass would be
    // smeared over the whole grid by normalisation and be very hard to spot.
    const { grid } = scorelineFrom(6, 6, { rho: -0.9 });
    for (const row of grid) for (const cell of row) expect(cell).toBeGreaterThanOrEqual(0);
    expect(total(grid)).toBeCloseTo(1, 10);
  });
});

describe("derived markets", () => {
  it("both-teams-to-score matches a direct count over the grid", () => {
    const s = scorelineFrom(1.6, 1.1);
    let direct = 0;
    for (let h = 1; h <= MAX_GOALS; h++) {
      for (let a = 1; a <= MAX_GOALS; a++) direct += s.grid[h][a];
    }
    expect(bothTeamsToScore(s)).toBeCloseTo(direct, 10);
  });

  it("totals sum to one and average out at the two rates combined", () => {
    const totals = totalGoalsDistribution(scorelineFrom(1.6, 1.1, { rho: 0 }));
    expect(totals.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);

    const mean = totals.reduce((sum, p, goals) => sum + p * goals, 0);
    expect(mean).toBeCloseTo(1.6 + 1.1, 4);
  });

  it("runs a hair under the true mean, because the tail is folded flat", () => {
    // Folding "eleven or more" into the ten cell counts it as exactly ten, so
    // the grid's mean sits fractionally below lambda. Named here rather than
    // hidden behind a loose tolerance: the bias is real, one-directional, and
    // about a millionth of a goal, which is why the fold is the right trade.
    const totals = totalGoalsDistribution(scorelineFrom(1.6, 1.1, { rho: 0 }));
    const mean = totals.reduce((sum, p, goals) => sum + p * goals, 0);

    expect(mean).toBeLessThan(1.6 + 1.1);
    expect(1.6 + 1.1 - mean).toBeLessThan(1e-4);
  });

  it("over and under partition the line", () => {
    const s = scorelineFrom(1.6, 1.1);
    const { over, under } = overUnder(s, 2.5);
    expect(over + under).toBeCloseTo(1, 10);
    expect(over).toBeGreaterThan(0.4);
    expect(over).toBeLessThan(0.6);
  });

  it("finds more goals in a higher-scoring fixture", () => {
    expect(overUnder(scorelineFrom(2.4, 1.8), 2.5).over).toBeGreaterThan(
      overUnder(scorelineFrom(0.9, 0.7), 2.5).over,
    );
  });

  it("refuses a whole goal line, because it can push", () => {
    expect(() => overUnder(scorelineFrom(1.5, 1.2), 3)).toThrow(/half/);
  });

  it("reports supremacy from the grid, matching the rates when uncorrected", () => {
    expect(expectedSupremacy(scorelineFrom(2.1, 0.9, { rho: 0 }))).toBeCloseTo(
      2.1 - 0.9,
      4,
    );
    expect(expectedSupremacy(scorelineFrom(0.9, 2.1))).toBeLessThan(0);
  });
});

describe("most likely scores", () => {
  it("comes back sorted, and honours the count", () => {
    const scores = mostLikelyScores(scorelineFrom(1.8, 1.0), 6);
    expect(scores).toHaveLength(6);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1].probability).toBeGreaterThanOrEqual(
        scores[i].probability,
      );
    }
    expect(mostLikelyScores(scorelineFrom(1.8, 1.0), 0)).toHaveLength(0);
  });

  it("puts a strong home side ahead in its own most likely score", () => {
    const [best] = mostLikelyScores(
      scoreline({ attack: 1.6, defence: 0.7 }, { attack: 0.7, defence: 1.4 }),
    );
    expect(best.home).toBeGreaterThan(best.away);
  });

  it("still calls two weak sides level", () => {
    const [best] = mostLikelyScores(
      scoreline({ attack: 0.7, defence: 1 }, { attack: 0.7, defence: 1 }),
    );
    expect(best.home).toBe(best.away);
  });
});

describe("against real fitted ratings", () => {
  // Attack and defence fitted by Poisson MLE on all 380 matches of 2025/26,
  // using team xG. Anchors the module to numbers that came out of real data
  // rather than to a hand-picked example.
  const CITY: TeamStrength = { attack: 1.36, defence: 0.86 };
  const EVERTON: TeamStrength = { attack: 0.89, defence: 1.06 };
  const OBSERVED_LEAGUE_MEAN = 1.375;

  const s = scoreline(CITY, EVERTON, { leagueMean: OBSERVED_LEAGUE_MEAN });

  it("produces sane rates", () => {
    expect(s.lambdaHome).toBeCloseTo(2.18, 2);
    expect(s.lambdaAway).toBeCloseTo(0.96, 2);
  });

  it("makes City clear favourites without making it a certainty", () => {
    const o = outcomeProbabilities(s);
    expect(o.home).toBeGreaterThan(0.6);
    expect(o.home).toBeLessThan(0.75);
    expect(o.away).toBeGreaterThan(0.1);
  });

  it("rates the home clean sheet far above the away one", () => {
    const cs = cleanSheetProbabilities(s);
    expect(cs.home).toBeGreaterThan(0.3);
    expect(cs.away).toBeLessThan(0.15);
  });
});

describe("the most likely score within each outcome", () => {
  const lopsided = scorelineFrom(2.25, 1.15);

  it("is the answer to the 1-1 problem", () => {
    // The unconditional mode of this fixture is 1-1, even though the home side
    // wins 60% of the time — draws concentrate on a few cells while wins are
    // spread over many. Conditioning removes that comparison.
    expect(mostLikelyScores(lopsided, 1)[0]).toMatchObject({ home: 1, away: 1 });
    expect(mostLikelyScoreByOutcome(lopsided).home).toMatchObject({
      home: 2,
      away: 1,
    });
  });

  it("returns a score consistent with each outcome", () => {
    const { home, draw, away } = mostLikelyScoreByOutcome(lopsided);
    expect(home.home).toBeGreaterThan(home.away);
    expect(draw.home).toBe(draw.away);
    expect(away.home).toBeLessThan(away.away);
  });

  it("keeps probabilities joint, so the three are comparable", () => {
    const { home, draw, away } = mostLikelyScoreByOutcome(lopsided);
    const o = outcomeProbabilities(lopsided);

    // Each is one cell inside its outcome, so it cannot exceed the outcome.
    expect(home.probability).toBeLessThan(o.home);
    expect(draw.probability).toBeLessThan(o.draw);
    expect(away.probability).toBeLessThan(o.away);
    // And the favoured outcome's best score outranks the outsider's.
    expect(home.probability).toBeGreaterThan(away.probability);
  });

  it("finds the best cell on the diagonal for the draw", () => {
    const { grid } = lopsided;
    const { draw } = mostLikelyScoreByOutcome(lopsided);
    for (let k = 0; k <= MAX_GOALS; k++) {
      expect(grid[k][k]).toBeLessThanOrEqual(draw.probability);
    }
  });

  it("still answers for a fixture nobody is expected to win", () => {
    const level = mostLikelyScoreByOutcome(
      scoreline({ attack: 1, defence: 1 }, { attack: 1, defence: 1 }, {
        homeAdvantage: 1,
      }),
    );
    expect(level.home.home).toBeGreaterThan(level.home.away);
    expect(level.away.home).toBeLessThan(level.away.away);
    expect(level.home.probability).toBeCloseTo(level.away.probability, 10);
  });
});

describe("scoring a prediction", () => {
  const confidentHome = { home: 0.8, draw: 0.15, away: 0.05 };
  const clueless = { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };

  it("reads the outcome off a scoreline", () => {
    expect(outcomeOf(2, 1)).toBe("home");
    expect(outcomeOf(1, 1)).toBe("draw");
    expect(outcomeOf(0, 3)).toBe("away");
  });

  it("scores a perfect forecast at zero and a wrong one at one", () => {
    expect(rankedProbabilityScore({ home: 1, draw: 0, away: 0 }, "home")).toBe(0);
    expect(rankedProbabilityScore({ home: 1, draw: 0, away: 0 }, "away")).toBe(1);
  });

  it("rewards being right", () => {
    expect(rankedProbabilityScore(confidentHome, "home")).toBeLessThan(
      rankedProbabilityScore(confidentHome, "away"),
    );
  });

  it("rewards being CLOSE, which is why it beats accuracy here", () => {
    // Two forecasts equally confident of a home win, differing only in where
    // they put the rest. When the match is drawn, the one that saw a draw
    // coming should score better — a distinction plain accuracy cannot make,
    // since both called the winner wrong.
    const drawIsSecond = { home: 0.6, draw: 0.3, away: 0.1 };
    const awayIsSecond = { home: 0.6, draw: 0.1, away: 0.3 };

    expect(rankedProbabilityScore(drawIsSecond, "draw")).toBeLessThan(
      rankedProbabilityScore(awayIsSecond, "draw"),
    );
  });

  it("punishes a confident miss harder than an uncertain one", () => {
    expect(rankedProbabilityScore(confidentHome, "away")).toBeGreaterThan(
      rankedProbabilityScore(clueless, "away"),
    );
  });

  it("log loss disagrees with RPS about ordering, on purpose", () => {
    // Log loss treats the three outcomes as unordered, so it cannot see that a
    // draw sits between two wins. Both are stored because the disagreement is
    // informative.
    const drawIsSecond = { home: 0.6, draw: 0.3, away: 0.1 };
    const awayIsSecond = { home: 0.6, draw: 0.1, away: 0.3 };

    expect(rankedProbabilityScore(drawIsSecond, "away")).not.toBeCloseTo(
      rankedProbabilityScore(awayIsSecond, "away"),
      6,
    );
    expect(logLoss(drawIsSecond, "home")).toBeCloseTo(
      logLoss(awayIsSecond, "home"),
      12,
    );
  });

  it("never returns infinity for an outcome it ruled out", () => {
    // An unfloored log loss would poison every average it entered.
    expect(Number.isFinite(logLoss({ home: 1, draw: 0, away: 0 }, "away"))).toBe(
      true,
    );
  });

  it("scores a real grid better than a coin flip, when it is right", () => {
    const s = scorelineFrom(2.4, 0.8);
    const o = outcomeProbabilities(s);
    expect(rankedProbabilityScore(o, "home")).toBeLessThan(
      rankedProbabilityScore(clueless, "home"),
    );
  });
});

describe("the expected scoreline, which is what the screens show", () => {
  const lopsided = scorelineFrom(2.15, 1.06);

  it("shows a bigger win than the mode does", () => {
    // The finding this exists for: goals are right-skewed, so the modal
    // scoreline sits below the average one and understates every decisive
    // result. Measured, the mode showed a mean margin of 1.29 against an
    // actual 1.93.
    const mode = mostLikelyScoreByOutcome(lopsided).home;
    const expected = expectedScoreByOutcome(lopsided).home;

    expect(mode.home - mode.away).toBe(1);
    expect(expected.home - expected.away).toBeGreaterThan(
      mode.home - mode.away,
    );
  });

  it("can say comfortable win, which the mode effectively cannot", () => {
    // 49% of real home wins had the winner scoring 3+. The mode produced a 3+
    // scoreline in 2% of them, because 2-1 and 2-0 always edge out 3-1 and 3-0
    // on a flat distribution.
    const heavy = expectedScoreByOutcome(scorelineFrom(2.7, 0.5));
    expect(heavy.home.home).toBeGreaterThanOrEqual(3);
  });

  it("still returns a score consistent with each outcome", () => {
    for (const rates of [[2.15, 1.06], [0.9, 0.8], [1.2, 1.15], [0.4, 3.0]]) {
      const { home, draw, away } = expectedScoreByOutcome(
        scorelineFrom(rates[0], rates[1]),
      );
      expect(home.home).toBeGreaterThan(home.away);
      expect(draw.home).toBe(draw.away);
      expect(away.home).toBeLessThan(away.away);
    }
  });

  it("nudges the winner up when rounding would erase the win", () => {
    // A mean home win of 1.4-1.2 rounds to 1-1, which is not a home win at
    // all. Rounding the loser down instead would understate further.
    const tight = expectedScoreByOutcome(scorelineFrom(0.7, 0.65));
    expect(tight.home.home).toBeGreaterThan(tight.home.away);
    expect(tight.away.away).toBeGreaterThan(tight.away.home);
  });

  it("tracks the rates, so a heavier favourite gets a heavier scoreline", () => {
    const mild = expectedScoreByOutcome(scorelineFrom(1.4, 1.2)).home;
    const heavy = expectedScoreByOutcome(scorelineFrom(3.2, 0.5)).home;
    expect(heavy.home - heavy.away).toBeGreaterThan(mild.home - mild.away);
  });

  it("carries the probability of the scoreline it names", () => {
    const { home } = expectedScoreByOutcome(lopsided);
    expect(home.probability).toBeGreaterThan(0);
    expect(home.probability).toBeLessThan(0.25);
  });
});

describe("a statistic and the words describing it cannot drift apart", () => {
  /*
   * These exist because the caption on the scorelines panel went stale three
   * times in one feature. Each time a statistic changed and the sentence
   * explaining it did not, leaving the page stating something false with
   * nothing to reveal it. Re-wording was not a fix; this is the guard.
   */

  it("gives every summary a caption", () => {
    for (const [id, summary] of Object.entries(SCORE_SUMMARIES)) {
      expect(summary.id).toBe(id);
      expect(summary.caption.trim().length).toBeGreaterThan(0);
    }
  });

  it("captions the summary that is actually in use", () => {
    expect(captionFor(ACTIVE_SCORE_SUMMARY.id)).toBe(
      ACTIVE_SCORE_SUMMARY.caption,
    );
  });

  it("keeps describing an old prediction by the summary that made it", () => {
    // The version of this bug that survives every re-wording: a row written
    // under one summary being relabelled by whatever the code does later.
    expect(captionFor("modal")).toBe(SCORE_SUMMARIES.modal.caption);
    expect(captionFor("modal")).not.toBe(SCORE_SUMMARIES.expected.caption);
  });

  it("says something safe for a method it does not recognise", () => {
    // A prediction from a future version, read by an older deploy. Better a
    // vague truth than a confident falsehood.
    expect(captionFor("something-new").length).toBeGreaterThan(0);
    expect(captionFor(null)).toBe(captionFor(undefined));
  });

  it("describes the mode as a mode and the mean as a mean", () => {
    // The captions have to survive someone reading them beside the numbers.
    // A lopsided fixture is where the two summaries visibly disagree.
    const lopsided = scorelineFrom(2.15, 1.06);
    const mode = SCORE_SUMMARIES.modal.summarise(lopsided).home;
    const mean = SCORE_SUMMARIES.expected.summarise(lopsided).home;

    expect(mean.home - mean.away).toBeGreaterThan(mode.home - mode.away);
    expect(SCORE_SUMMARIES.modal.caption).toMatch(/likely/);
    expect(SCORE_SUMMARIES.expected.caption).toMatch(/average/);
  });
});
