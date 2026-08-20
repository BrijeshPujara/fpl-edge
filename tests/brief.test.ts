import { describe, expect, it } from "vitest";
import { buildPrompt, type BriefContext } from "@/lib/llm/brief";

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
      epGain: 16.6, hitCost: 0, netGain: 16.6,
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
          epGain: 0, hitCost: 0, netGain: 0,
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
    expect(prompt).toContain("minutes are not");
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
