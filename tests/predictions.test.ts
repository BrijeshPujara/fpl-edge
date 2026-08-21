import { describe, expect, it } from "vitest";
import { likelyScoresOf, scorePrediction, summarise } from "@/lib/db/predictions";
import type { PredictedFixture } from "@/lib/db/predictions";

/** A stored prediction, with only the fields scoring reads. */
const prediction = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    id: "p1",
    p_home: 0.6,
    p_draw: 0.25,
    p_away: 0.15,
    score_home: 2,
    score_away: 1,
    ...over,
  }) as Parameters<typeof scorePrediction>[0];

describe("scoring a stored prediction", () => {
  it("calls a correct result correct, and an exact one exact", () => {
    const scored = scorePrediction(prediction(), 2, 1);
    expect(scored.outcome_correct).toBe(true);
    expect(scored.exact_correct).toBe(true);
  });

  it("separates the right result from the right scoreline", () => {
    // 3-0 is a home win, which the prediction called; it is not 2-1.
    const scored = scorePrediction(prediction(), 3, 0);
    expect(scored.outcome_correct).toBe(true);
    expect(scored.exact_correct).toBe(false);
  });

  it("calls a wrong result wrong", () => {
    const scored = scorePrediction(prediction(), 0, 2);
    expect(scored.outcome_correct).toBe(false);
    expect(scored.exact_correct).toBe(false);
  });

  it("records the actual score whatever it was", () => {
    const scored = scorePrediction(prediction(), 4, 3);
    expect(scored.actual_home).toBe(4);
    expect(scored.actual_away).toBe(3);
  });

  it("scores a confident right answer better than a wrong one", () => {
    const right = scorePrediction(prediction(), 2, 0);
    const wrong = scorePrediction(prediction(), 0, 2);
    expect(Number(right.rps)).toBeLessThan(Number(wrong.rps));
    expect(Number(right.log_loss)).toBeLessThan(Number(wrong.log_loss));
  });

  it("reads probabilities that arrive as strings", () => {
    // Postgres numeric comes back as a string through PostgREST often enough
    // that assuming a number here would silently produce NaN scores.
    const scored = scorePrediction(
      prediction({ p_home: "0.6", p_draw: "0.25", p_away: "0.15" }),
      2,
      1,
    );
    expect(Number.isFinite(Number(scored.rps))).toBe(true);
    expect(Number(scored.rps)).toBeGreaterThan(0);
  });

  it("rounds to what the column can hold", () => {
    const scored = scorePrediction(prediction(), 1, 1);
    // numeric(6, 5) — anything longer is rounded by Postgres anyway, and
    // rounding here keeps the stored value equal to the computed one.
    expect(String(scored.rps).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(5);
  });
});

describe("the record", () => {
  const fixture = (
    outcomeCorrect: boolean,
    exactCorrect: boolean,
    rps: number,
  ): PredictedFixture =>
    ({
      prediction: { id: `p${rps}` },
      homeShort: "AAA",
      awayShort: "BBB",
      kickoff: null,
      outcome: {
        outcome_correct: outcomeCorrect,
        exact_correct: exactCorrect,
        rps,
        log_loss: 1,
      },
    }) as unknown as PredictedFixture;

  it("is null before anything has been scored", () => {
    expect(summarise([])).toBeNull();
    expect(
      summarise([{ outcome: null } as unknown as PredictedFixture]),
    ).toBeNull();
  });

  it("counts results and exact scores separately", () => {
    const record = summarise([
      fixture(true, true, 0.1),
      fixture(true, false, 0.2),
      fixture(false, false, 0.5),
    ])!;

    expect(record.scored).toBe(3);
    expect(record.outcomesRight).toBe(2);
    expect(record.exactRight).toBe(1);
    expect(record.meanRps).toBeCloseTo((0.1 + 0.2 + 0.5) / 3, 10);
  });

  it("ignores fixtures that have not been scored yet", () => {
    const record = summarise([
      fixture(true, true, 0.1),
      { outcome: null } as unknown as PredictedFixture,
    ])!;
    expect(record.scored).toBe(1);
  });
});

describe("reading the stored scorelines", () => {
  const row = (likely: unknown) =>
    ({ likely_scores: likely, score_home: 2, score_away: 1 }) as never;

  it("reads a well-formed list", () => {
    const scores = likelyScoresOf(
      row([
        { outcome: "home", home: 2, away: 1, p: 0.1 },
        { outcome: "draw", home: 1, away: 1, p: 0.09 },
      ]),
    );
    expect(scores).toHaveLength(2);
    expect(scores[0]).toMatchObject({ outcome: "home", home: 2, away: 1 });
  });

  it("drops entries with no result attached", () => {
    // Every stored scoreline belongs to a result, and the panel looks each one
    // up by that. An entry without it cannot be placed in a column, so it is
    // not a usable scoreline — predictions written before the shape changed
    // fall into this and the panel falls back to the single called score.
    expect(likelyScoresOf(row([{ home: 2, away: 1, p: 0.1 }]))).toEqual([]);
  });

  it("returns nothing for a prediction stored before the column existed", () => {
    // The default is an empty array, and the panel falls back to the single
    // called scoreline rather than rendering a blank cell.
    expect(likelyScoresOf(row([]))).toEqual([]);
  });

  it("refuses anything that is not the shape it expects", () => {
    // jsonb is untyped by definition, so this is checked rather than asserted.
    expect(likelyScoresOf(row(null))).toEqual([]);
    expect(likelyScoresOf(row("2-1"))).toEqual([]);
    expect(likelyScoresOf(row([{ nonsense: true }, 7, null]))).toEqual([]);
  });

  it("keeps the good entries and drops the bad ones", () => {
    expect(
      likelyScoresOf(
        row([{ outcome: "away", home: 1, away: 0, p: 0.1 }, { broken: 1 }]),
      ),
    ).toHaveLength(1);
  });
});
