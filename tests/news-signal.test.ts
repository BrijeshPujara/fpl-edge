import { describe, expect, it } from "vitest";
import {
  clampNewsMultiplier,
  NO_NEWS_SIGNAL,
  readNewsSignal,
  verifyNewsSignal,
} from "@/lib/engine/news-signal";
import { projectMinutes } from "@/lib/engine/minutes";
import { NEWS_MULTIPLIER_BOUNDS } from "@/lib/engine/constants";

describe("readNewsSignal", () => {
  it("says nothing about an empty string", () => {
    expect(readNewsSignal("")).toEqual(NO_NEWS_SIGNAL);
    expect(readNewsSignal("   ")).toEqual(NO_NEWS_SIGNAL);
  });

  it("separates match fitness from a knock at the same percentage", () => {
    // The whole reason this module exists. Both appear at 75% and the
    // percentage cannot tell them apart: one is a substitute, one is a starter.
    const unfit = readNewsSignal("Lack of match fitness - 75% chance of playing");
    const knock = readNewsSignal("Knock - 75% chance of playing");

    expect(unfit.category).toBe("matchFitness");
    expect(knock.category).toBe("knock");
    expect(unfit.multiplier).toBeLessThan(knock.multiplier);
  });

  it("treats muscle injuries as carrying re-aggravation risk", () => {
    for (const text of [
      "Hamstring injury - 75% chance of playing",
      "Calf injury - 50% chance of playing",
      "Groin strain - 75% chance of playing",
      "Thigh injury - 75% chance of playing",
    ]) {
      expect(readNewsSignal(text).category).toBe("muscular");
    }
  });

  it("does not let a hamstring fall through to the generic injury rule", () => {
    // "Hamstring injury" matches both patterns; specificity has to win.
    const signal = readNewsSignal("Hamstring injury - 75% chance of playing");
    expect(signal.category).toBe("muscular");
  });

  it("recognises named non-muscular injuries", () => {
    for (const text of [
      "Ankle injury - 75% chance of playing",
      "Knee injury - 50% chance of playing",
      "Shoulder injury - 75% chance of playing",
      "Concussion - 25% chance of playing",
    ]) {
      expect(readNewsSignal(text).category).toBe("injury");
    }
  });

  it("stays silent on text it does not recognise", () => {
    // Inventing a discount for a transfer note or a suspension would be worse
    // than ignoring it.
    for (const text of [
      "Has joined Sheffield Wednesday on loan for the rest of the season",
      "Suspended for one match",
      "Personal reasons",
    ]) {
      expect(readNewsSignal(text).multiplier).toBe(1);
    }
  });

  it("never projects a player above the club's own percentage", () => {
    // The news text is the club explaining the number, not disagreeing with it.
    const samples = [
      "Lack of match fitness - 75% chance of playing",
      "Knock - 75% chance of playing",
      "Hamstring injury - 50% chance of playing",
      "Illness - 75% chance of playing",
      "Ankle injury - 25% chance of playing",
    ];
    for (const text of samples) {
      expect(readNewsSignal(text).multiplier).toBeLessThanOrEqual(1);
    }
  });

  it("cites the words it acted on", () => {
    const signal = readNewsSignal("Hamstring injury - 75% chance of playing");
    expect(signal.citedText.toLowerCase()).toBe("hamstring");
    expect(
      "Hamstring injury - 75% chance of playing"
        .toLowerCase()
        .includes(signal.citedText.toLowerCase()),
    ).toBe(true);
  });
});

describe("clampNewsMultiplier", () => {
  it("holds the bounds", () => {
    expect(clampNewsMultiplier(9)).toBe(NEWS_MULTIPLIER_BOUNDS.max);
    expect(clampNewsMultiplier(0)).toBe(NEWS_MULTIPLIER_BOUNDS.min);
    expect(clampNewsMultiplier(-3)).toBe(NEWS_MULTIPLIER_BOUNDS.min);
  });

  it("treats nonsense as no adjustment rather than as an extreme", () => {
    // NaN and Infinity are not opinions about a footballer, they are a broken
    // analyser. Clamping them to a bound would silently dress a failure up as
    // a confident judgement; returning 1 leaves the numeric model untouched.
    expect(clampNewsMultiplier(Number.NaN)).toBe(1);
    expect(clampNewsMultiplier(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampNewsMultiplier(Number.NEGATIVE_INFINITY)).toBe(1);
  });
});

describe("verifyNewsSignal", () => {
  const source = "Manager said Saka trained fully and will be assessed";

  it("accepts a signal that quotes its source", () => {
    const verified = verifyNewsSignal(
      { multiplier: 0.8, category: "other", citedText: "will be assessed" },
      source,
    );
    expect(verified?.multiplier).toBe(0.8);
  });

  it("rejects a citation the source does not contain", () => {
    // The anti-hallucination check. A confident sentence that quotes something
    // nobody wrote must not be allowed to move a projection.
    const verified = verifyNewsSignal(
      { multiplier: 0.4, category: "muscular", citedText: "ruptured achilles" },
      source,
    );
    expect(verified).toBeNull();
  });

  it("rejects a signal with no citation at all", () => {
    const verified = verifyNewsSignal(
      { multiplier: 0.5, category: "other", citedText: "" },
      source,
    );
    expect(verified).toBeNull();
  });

  it("clamps an out-of-range multiplier rather than trusting it", () => {
    const verified = verifyNewsSignal(
      { multiplier: 12, category: "other", citedText: "trained fully" },
      source,
    );
    expect(verified?.multiplier).toBe(NEWS_MULTIPLIER_BOUNDS.max);
  });

  it("ignores case and spacing when checking the citation", () => {
    const verified = verifyNewsSignal(
      { multiplier: 0.9, category: "other", citedText: "TRAINED   FULLY" },
      source,
    );
    expect(verified).not.toBeNull();
  });
});

describe("news feeding the minutes model", () => {
  const nailed = {
    status: "d",
    chanceOfPlayingNextRound: 75,
    recentStarts: [true, true, true, true],
    recentMinutes: [90, 90, 90, 90],
  };

  it("lowers a projection when the news implies a reduced role", () => {
    const plain = projectMinutes(nailed);
    const unfit = projectMinutes({
      ...nailed,
      newsMultiplier: readNewsSignal(
        "Lack of match fitness - 75% chance of playing",
      ).multiplier,
    });
    expect(unfit.pAppears).toBeLessThan(plain.pAppears);
    expect(unfit.expectedMinutes).toBeLessThan(plain.expectedMinutes);
  });

  it("composes with the club's percentage rather than replacing it", () => {
    // Both facts count: doubtful AND likely to be eased in.
    const fitWithNews = projectMinutes({
      ...nailed,
      chanceOfPlayingNextRound: null,
      status: "a",
      newsMultiplier: 0.7,
    });
    const doubtfulWithNews = projectMinutes({
      ...nailed,
      newsMultiplier: 0.7,
    });
    expect(doubtfulWithNews.pAppears).toBeLessThan(fitWithNews.pAppears);
  });

  it("clamps at the model boundary, not only at the source", () => {
    // A caller that forgets to be careful must not be able to do damage.
    const absurd = projectMinutes({ ...nailed, newsMultiplier: 100 });
    const bounded = projectMinutes({
      ...nailed,
      newsMultiplier: NEWS_MULTIPLIER_BOUNDS.max,
    });
    expect(absurd.pAppears).toBeCloseTo(bounded.pAppears, 10);
  });

  it("changes nothing when there is no news", () => {
    expect(projectMinutes({ ...nailed, newsMultiplier: 1 })).toEqual(
      projectMinutes(nailed),
    );
  });

  it("cannot resurrect a player the game rates at zero", () => {
    const p = projectMinutes({
      ...nailed,
      chanceOfPlayingNextRound: 0,
      newsMultiplier: NEWS_MULTIPLIER_BOUNDS.max,
    });
    expect(p.pAppears).toBe(0);
  });
});
