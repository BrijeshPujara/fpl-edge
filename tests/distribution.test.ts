import { describe, expect, it } from "vitest";
import {
  atLeast,
  atMost,
  bernoulli,
  convolve,
  doubled,
  MAX_POINTS,
  mean,
  mix,
  variance,
  poissonPoints,
  pointMass,
  quantile,
} from "@/lib/engine/distribution";

const total = (pmf: number[]) => pmf.reduce((a, b) => a + b, 0);

describe("building blocks", () => {
  it("point mass puts everything on one value", () => {
    expect(mean(pointMass(7))).toBe(7);
    expect(total(pointMass(7))).toBeCloseTo(1, 10);
  });

  it("handles negative scores, because red cards are real", () => {
    // A distribution clamped at zero would move that mass onto zero and
    // overstate the floor of exactly the defenders you are checking.
    expect(mean(pointMass(-3))).toBe(-3);
  });

  it("bernoulli has the mean it should", () => {
    expect(mean(bernoulli(0.25, 4))).toBeCloseTo(1, 10);
    expect(total(bernoulli(0.25, 4))).toBeCloseTo(1, 10);
  });

  it("poisson counts have the mean they should", () => {
    // Two points per event at rate 1.5 is three points expected.
    expect(mean(poissonPoints(1.5, 2))).toBeCloseTo(3, 3);
  });

  it("keeps truncated poisson mass rather than losing it", () => {
    expect(total(poissonPoints(4, 5))).toBeCloseTo(1, 10);
  });
});

describe("convolution", () => {
  it("adds means", () => {
    const sum = convolve(bernoulli(0.5, 4), poissonPoints(1, 3));
    expect(mean(sum)).toBeCloseTo(2 + 3, 3);
  });

  it("conserves probability", () => {
    expect(total(convolve(bernoulli(0.5, 4), poissonPoints(2, 2)))).toBeCloseTo(1, 10);
  });

  it("is identity against a zero point mass", () => {
    const a = poissonPoints(1.2, 5);
    const same = convolve(a, pointMass(0));
    for (let i = 0; i < a.length; i++) expect(same[i]).toBeCloseTo(a[i], 12);
  });

  it("adds negatives correctly", () => {
    const sum = convolve(pointMass(6), pointMass(-2));
    expect(mean(sum)).toBe(4);
  });
});

describe("mixture", () => {
  it("weights components", () => {
    const m = mix([
      { weight: 0.25, pmf: pointMass(8) },
      { weight: 0.75, pmf: pointMass(0) },
    ]);
    expect(mean(m)).toBeCloseTo(2, 10);
    expect(total(m)).toBeCloseTo(1, 10);
  });

  it("ignores zero-weight components", () => {
    const m = mix([
      { weight: 0, pmf: pointMass(50) },
      { weight: 1, pmf: pointMass(3) },
    ]);
    expect(mean(m)).toBe(3);
  });
});

describe("reading a distribution", () => {
  const skewed = mix([
    { weight: 0.8, pmf: pointMass(2) },
    { weight: 0.2, pmf: pointMass(12) },
  ]);

  it("separates the mean from the median on a skewed score", () => {
    // The whole reason this module exists. Mean 4, median 2 — the player
    // scores 2 four weeks in five.
    expect(mean(skewed)).toBeCloseTo(4, 10);
    expect(quantile(skewed, 0.5)).toBe(2);
  });

  it("answers the ceiling question", () => {
    expect(atLeast(skewed, 10)).toBeCloseTo(0.2, 10);
    expect(atLeast(skewed, 2)).toBeCloseTo(1, 10);
  });

  it("answers the floor question", () => {
    expect(atMost(skewed, 2)).toBeCloseTo(0.8, 10);
  });

  it("quantiles bracket the distribution", () => {
    expect(quantile(skewed, 0.1)).toBeLessThanOrEqual(quantile(skewed, 0.9));
  });

  it("saturates rather than running off the end", () => {
    expect(quantile(pointMass(2), 1.5)).toBe(MAX_POINTS);
  });
});

describe("doubling, which is what the armband does", () => {
  it("doubles every outcome and therefore the mean", () => {
    const d = doubled(skewedFixture());
    expect(mean(d)).toBeCloseTo(8, 10);
  });

  it("doubles the spread, not just the centre", () => {
    const plain = skewedFixture();
    const d = doubled(plain);
    // The haul becomes 24, so the ceiling moves twice as far as the mean.
    expect(atLeast(d, 24)).toBeCloseTo(0.2, 10);
  });

  function skewedFixture() {
    return mix([
      { weight: 0.8, pmf: pointMass(2) },
      { weight: 0.2, pmf: pointMass(12) },
    ]);
  }
});

describe("variance", () => {
  it("is zero for a certainty", () => {
    expect(variance(pointMass(6))).toBeCloseTo(0, 10);
  });

  it("matches the closed form for a coin flip", () => {
    // Bernoulli(p) scaled to {0, k} has variance k^2·p·(1-p).
    const pmf = bernoulli(0.3, 10, 0);
    expect(variance(pmf)).toBeCloseTo(100 * 0.3 * 0.7, 6);
  });

  it("adds under convolution, which is what makes the risk term linear", () => {
    // The property the optimiser objective depends on. If this stops holding,
    // summing per-player `ep - γ·variance` stops equalling
    // `E[total] - γ·Var[total]` and the whole term means something else.
    const a = bernoulli(0.4, 8, 1);
    const b = bernoulli(0.6, 5, 2);
    expect(variance(convolve(a, b))).toBeCloseTo(variance(a) + variance(b), 6);
  });

  it("separates two players who share a mean", () => {
    const steady = bernoulli(1, 6, 6);
    const streaky = bernoulli(0.25, 24, 0);
    expect(mean(steady)).toBeCloseTo(mean(streaky), 6);
    expect(variance(streaky)).toBeGreaterThan(variance(steady));
  });
});
