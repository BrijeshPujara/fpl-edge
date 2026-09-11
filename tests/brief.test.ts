import { describe, expect, it } from "vitest";
import {
  buildPrompt,
  derivedFacts,
  SYSTEM,
  type BriefContext,
} from "@/lib/llm/brief";

function context(over: Partial<BriefContext> = {}): BriefContext {
  return {
    gw: 8,
    teamName: "White Rice & Salmon",
    starting: [
      { name: "Haaland", position: "FWD", club: "MCI", ep: 8.2 },
      { name: "Saka", position: "MID", club: "ARS", ep: 6.1 },
    ],
    bench: [{ name: "Pope", position: "GK", club: "NEW", ep: 2.3 }],
    captain: {
      name: "Haaland", ep: 8.2, pHaul: 0.25, pBlank: 0.08,
      runnerUp: "Saka", runnerUpEp: 6.1,
    },
    transfer: {
      kind: "transfer", out: "Morato", in: "De Cuyper",
      epGain: 16.6, hitCost: 0, netGain: 16.6, horizon: 5,
    },
    chip: null,
    freeTransfers: 1,
    bank: 5,
    flagged: [],
    record: null,
    priorSeasonOnly: false,
    ...over,
  };
}

describe("buildPrompt", () => {
  it("includes every number the model is allowed to use", () => {
    const prompt = buildPrompt(context());
    expect(prompt).toContain("8.2");
    expect(prompt).toContain("25% chance of 10+");
    expect(prompt).toContain("Morato");
    expect(prompt).toContain("De Cuyper");
    expect(prompt).toContain("£0.5m");
  });

  it("states a hold as a decision rather than an absence", () => {
    const prompt = buildPrompt(
      context({
        transfer: {
          kind: "hold", out: null, in: null,
          epGain: 0, hitCost: 0, netGain: 0, horizon: 5,
        },
      }),
    );
    expect(prompt).toContain("hold");
    expect(prompt).not.toContain("null");
  });

  it("surfaces flagged players so the prose can reconcile them", () => {
    // The single thing an LLM adds here: a strong projection sitting next to a
    // fitness flag is exactly what the arithmetic cannot weigh.
    const prompt = buildPrompt(
      context({
        flagged: [
          { name: "Saka", position: "MID", club: "ARS", ep: 6.1, flag: "Knock - 75%" },
        ],
      }),
    );
    expect(prompt).toContain("Flagged players");
    expect(prompt).toContain("Knock - 75%");
  });

  it("warns loudly when projections rest on last season", () => {
    const prompt = buildPrompt(context({ priorSeasonOnly: true }));
    expect(prompt).toContain("rests entirely on last season");
    // Names what last season cannot know, rather than overstating it as
    // knowing nothing. Minutes DO come from last season's workload.
    expect(prompt).toContain("summer transfer");
  });

  it("no longer tells the model that minutes are unknown", () => {
    // 996fa39 gave the minutes model last season's workload. The prompt went
    // on instructing the brief to say every player carried the same flat
    // starting probability for two days afterwards — an instruction to assert
    // something false, which is the one thing rule 1 exists to prevent.
    const prompt = buildPrompt(context({ priorSeasonOnly: true }));
    expect(prompt).not.toContain("flat starting probability");
    expect(prompt).not.toContain("minutes are not");
  });

  it("states a hit twice, because once was measurably not enough", () => {
    // Two of three samples described a 4-point hit by its net gain alone.
    const prompt = buildPrompt(
      context({
        transfer: {
          kind: "transfer", out: "Wood", in: "Watkins",
          epGain: 9.1, hitCost: 4, netGain: 5.1, horizon: 5,
        },
      }),
    );
    expect(prompt).toContain("4 points of hits");
    expect(prompt).toContain("THIS MOVE COSTS A 4-POINT HIT");
  });

  it("does not shout about a hit that is not being taken", () => {
    expect(buildPrompt(context())).not.toContain("POINT HIT");
  });

  it("says nothing about a chip when none is due", () => {
    expect(buildPrompt(context())).not.toContain("Chip:");
  });

  it("includes the chip when one is", () => {
    const prompt = buildPrompt(
      context({ chip: { name: "Bench Boost", gain: 14.2, margin: 3.6 } }),
    );
    expect(prompt).toContain("Bench Boost");
    expect(prompt).toContain("3.6 better");
  });

  it("carries the engine's own record when there is one", () => {
    const prompt = buildPrompt(
      context({ record: { scored: 12, better: 7, worse: 3, net: 14 } }),
    );
    expect(prompt).toContain("12 decisions scored");
    expect(prompt).toContain("+14 net points");
  });

  it("omits a record that does not exist yet", () => {
    expect(buildPrompt(context())).not.toContain("decisions scored");
  });

  it("never leaks an undefined into the prompt", () => {
    // A template hole reaching the model is how a brief ends up discussing
    // "undefined" as though it were a footballer.
    const prompt = buildPrompt(
      context({ captain: null, transfer: null, bench: [] }),
    );
    expect(prompt).not.toContain("undefined");
    expect(prompt).not.toContain("NaN");
  });
});

describe("derivedFacts", () => {
  /**
   * Every field here exists because a live brief invented it. These are
   * regressions against measured failures, not hypotheses about what a model
   * might do.
   */
  it("totals the eleven, so the prose does not have to", () => {
    // Two models between them stated 57.3 and 60.1 for elevens summing to
    // 60.1 and 60.8. Adding up is not the writer's job.
    expect(derivedFacts(context()).xiTotal).toBe(14.3);
  });

  it("applies the armband to the total the week actually scores", () => {
    expect(derivedFacts(context()).xiTotalWithArmband).toBe(22.5);
  });

  it("has no armband total when there is no captain", () => {
    expect(derivedFacts(context({ captain: null })).xiTotalWithArmband).toBeNull();
  });

  it("totals the eleven WITH the chip, so the prose does not add it on", () => {
    // Measured: given an armband total of 69.0 and a Triple Captain worth 8.2,
    // a live brief wrote 77.2. The sum is right and both halves are
    // this-gameweek quantities, so the model was not confusing time periods —
    // it was doing arithmetic to reach a number any reader wants. Supply it.
    const facts = derivedFacts(
      context({ chip: { name: "Triple Captain", gain: 4.0, margin: null } }),
    );
    expect(facts.xiTotalWithArmband).toBe(22.5);
    expect(facts.xiTotalWithChip).toBe(26.5);
  });

  it("builds the chip total on the armband, not instead of it", () => {
    // A chip is played on top of the captain. Basing it on the bare eleven
    // would understate the week by the captain's own projection.
    const facts = derivedFacts(
      context({ chip: { name: "Bench Boost", gain: 1.0, margin: null } }),
    );
    expect(facts.xiTotalWithChip).toBe(23.5);
  });

  it("has no chip total when no chip is advised", () => {
    expect(derivedFacts(context()).xiTotalWithChip).toBeNull();
  });

  it("names the best of the bench", () => {
    // "the only one above 2.5", written of a bench containing a 3.1.
    const facts = derivedFacts(
      context({
        bench: [
          { name: "Pope", position: "GKP", club: "NEW", ep: 2.3 },
          { name: "Mykolenko", position: "DEF", club: "EVE", ep: 3.1 },
        ],
      }),
    );
    expect(facts.benchBest).toEqual({ name: "Mykolenko", ep: 3.1 });
    expect(facts.benchTotal).toBe(5.4);
  });

  it("survives an empty bench", () => {
    const facts = derivedFacts(context({ bench: [] }));
    expect(facts.benchBest).toBeNull();
    expect(facts.benchTotal).toBe(0);
  });

  it("states the shape, so nobody refers to five defenders of a back three", () => {
    const facts = derivedFacts(
      context({
        starting: [
          { name: "Gabriel", position: "DEF", club: "ARS", ep: 5.0 },
          { name: "Timber", position: "DEF", club: "ARS", ep: 4.7 },
          { name: "Salah", position: "MID", club: "LIV", ep: 7.9 },
          { name: "Haaland", position: "FWD", club: "MCI", ep: 8.2 },
        ],
      }),
    );
    expect(facts.formation).toBe("2-1-1");
  });

  it("counts only the clubs with more than one player, most first", () => {
    const facts = derivedFacts(
      context({
        starting: [
          { name: "Gabriel", position: "DEF", club: "ARS", ep: 5.0 },
          { name: "Timber", position: "DEF", club: "ARS", ep: 4.7 },
          { name: "Saka", position: "MID", club: "ARS", ep: 6.1 },
          { name: "Salah", position: "MID", club: "LIV", ep: 7.9 },
          { name: "Van Dijk", position: "DEF", club: "LIV", ep: 4.6 },
          { name: "Haaland", position: "FWD", club: "MCI", ep: 8.2 },
        ],
      }),
    );
    expect(facts.clubCounts).toEqual([
      { club: "ARS", count: 3 },
      { club: "LIV", count: 2 },
    ]);
  });

  it("measures the captain's lead over the runner-up", () => {
    expect(derivedFacts(context()).captainGap).toBeCloseTo(2.1, 5);
  });

  it("has no gap when there is no runner-up", () => {
    const facts = derivedFacts(
      context({
        captain: {
          name: "Haaland", ep: 8.2, pHaul: 0.25, pBlank: 0.08,
          runnerUp: null, runnerUpEp: null,
        },
      }),
    );
    expect(facts.captainGap).toBeNull();
  });

  it("puts every derived number into the prompt", () => {
    // The point of deriving them is that the model reads them. A fact computed
    // and not rendered is worse than none: the grader would allow a number the
    // model was never given.
    const prompt = buildPrompt(context());
    expect(prompt).toContain("14.3");
    expect(prompt).toContain("22.5");
    expect(prompt).toContain("2.1 clear of the runner-up");
    expect(prompt).toContain("0-1-1 outfield");
  });

  it("says which time period every number belongs to", () => {
    /*
     * The failure this prevents produced a number rather than an omission.
     *
     * Unlabelled, "9.1 gained over the horizon" sat next to a one-gameweek
     * squad total and the model added them, writing "89.6 for the gameweek"
     * out of a five-gameweek figure and a one-week one. Both inputs were
     * correct and the output was nonsense.
     */
    const prompt = buildPrompt(context());
    expect(prompt).toContain("THIS GAMEWEEK ONLY");
    expect(prompt).toContain("ACROSS THE NEXT 5 GAMEWEEKS");
    expect(prompt).toContain("not added to this gameweek's total");
  });

  it("labels the horizon from the value, not from an assumption", () => {
    const prompt = buildPrompt(
      context({
        transfer: {
          kind: "transfer", out: "Wood", in: "Watkins",
          epGain: 9.1, hitCost: 0, netGain: 9.1, horizon: 3,
        },
      }),
    );
    expect(prompt).toContain("ACROSS THE NEXT 3 GAMEWEEKS");
    expect(prompt).not.toContain("NEXT 5 GAMEWEEKS");
  });

  it("forbids adding a gameweek figure to a horizon figure", () => {
    // The rule lives in the instructions, not the data — the instructions are
    // identical between managers and are what gets cached.
    expect(SYSTEM).toContain("never be added together");
    expect(SYSTEM).toContain("TWO DIFFERENT TIME PERIODS");
  });

  it("forbids the model from working anything out", () => {
    expect(buildPrompt(context())).toContain("quote these rather than");
  });
});
