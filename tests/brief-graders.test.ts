import { describe, expect, it } from "vitest";
import type { BriefContext } from "@/lib/llm/brief";
import type { EvalCase } from "@/evals/brief/fixtures";
import {
  coverage,
  formRules,
  gradeDeterministic,
  groundedNumbers,
  knownNames,
  speculation,
} from "@/evals/brief/graders";

/**
 * Tests for the eval graders.
 *
 * A grader is code, and a grader that gates CI is code with authority. An
 * untested one fails in the direction nobody notices: too permissive, reporting
 * a clean corpus while briefs invent whatever they like.
 *
 * Every case here is drawn from something the first live run actually produced,
 * so these are regressions rather than hypotheses.
 */

function context(over: Partial<BriefContext> = {}): BriefContext {
  return {
    gw: 8,
    teamName: "White Rice & Salmon",
    starting: [
      { name: "Haaland", position: "FWD", club: "MCI", ep: 8.2 },
      { name: "Salah", position: "MID", club: "LIV", ep: 7.9 },
    ],
    bench: [{ name: "Pope", position: "GKP", club: "NEW", ep: 2.3 }],
    captain: {
      name: "Haaland",
      ep: 8.2,
      pHaul: 0.25,
      pBlank: 0.08,
      runnerUp: "Salah",
      runnerUpEp: 7.9,
    },
    transfer: {
      kind: "transfer",
      out: "Wood",
      in: "Watkins",
      epGain: 6.4,
      hitCost: 0,
      netGain: 6.4,
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

const messages = (findings: { message: string }[]) =>
  findings.map((f) => f.message).join(" | ");

describe("groundedNumbers", () => {
  it("accepts the numbers it was given, in every rendering the prose may use", () => {
    const text =
      "Haaland projects 8.2 with a 25% chance of 10+ and 8% of 2 or fewer. " +
      "Salah is on 7.9. The move gains 6.4. You have £0.5m and 1 free transfer.";
    expect(groundedNumbers(text, context())).toEqual([]);
  });

  it("accepts a correct total, because adding up a list is a derivation", () => {
    // 8.2 + 7.9. The prompt forbids calculation, but a total that is RIGHT is
    // a different failure from one that is invented, and only the second is
    // dangerous. Both are still reported — see the incorrect case below.
    expect(groundedNumbers("Your eleven projects 16.1 points.", context())).toEqual([]);
  });

  it("rejects an incorrect total", () => {
    // The exact failure from the first live run: a confident squad total that
    // is simply wrong, sitting in a sentence with nothing else amiss.
    const findings = groundedNumbers("Your eleven projects 57.3 points.", context());
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("fail");
    expect(findings[0]!.message).toContain("57.3");
  });

  it("rejects a number invented out of nothing", () => {
    const findings = groundedNumbers("Haaland has scored in 7 of his last 9.", context());
    expect(messages(findings)).toContain("7");
    expect(messages(findings)).toContain("9");
  });

  it("allows numbers the flag text itself supplies", () => {
    const withFlag = context({
      flagged: [
        { name: "Salah", position: "MID", club: "LIV", ep: 7.9, flag: "Knock - 75% chance" },
      ],
    });
    expect(groundedNumbers("Salah is a 75% chance.", withFlag)).toEqual([]);
  });
});

describe("knownNames", () => {
  it("passes a possessive", () => {
    expect(knownNames("The armband suits Haaland's ceiling.", context())).toEqual([]);
  });

  it("passes a club code written out in full", () => {
    // The record carries MCI and LIV; expanding a code it was given is not
    // invention.
    const text = "Your Manchester City and Liverpool pair carry the week.";
    expect(knownNames(text, context())).toEqual([]);
  });

  it("flags a footballer who is not in the squad", () => {
    const findings = knownNames("Consider bringing in Bruno instead.", context());
    expect(messages(findings)).toContain("Bruno");
  });

  it("does not flag a word merely because it starts a sentence", () => {
    expect(knownNames("Haaland is the pick. Salah runs close.", context())).toEqual([]);
  });
});

describe("formRules", () => {
  it("accepts four plain paragraphs", () => {
    expect(formRules("One.\n\nTwo.\n\nThree.\n\nFour.")).toEqual([]);
  });

  it("rejects a fifth", () => {
    const findings = formRules("One.\n\nTwo.\n\nThree.\n\nFour.\n\nFive.");
    expect(messages(findings)).toContain("5 paragraphs");
  });

  it("rejects headings and bullets", () => {
    expect(messages(formRules("## Captain\n\nHaaland."))).toContain("heading");
    expect(messages(formRules("Notes:\n\n- Haaland\n- Salah"))).toContain("bullet");
  });

  it("rejects the model describing its own instructions", () => {
    expect(messages(formRules("Based on the data provided, Haaland."))).toContain(
      "own input",
    );
    expect(messages(formRules("As an AI I cannot be certain."))).toContain("AI");
  });
});

describe("coverage", () => {
  it("is satisfied by a brief that names everything the context makes mandatory", () => {
    const text = "Haaland takes the armband. Wood makes way for Watkins.";
    expect(coverage(text, context())).toEqual([]);
  });

  it("fails a brief that never names the captain", () => {
    const findings = coverage("Wood out, Watkins in.", context());
    expect(messages(findings)).toContain("captain");
  });

  it("fails a hold the brief does not present as a decision", () => {
    const held = context({
      transfer: { kind: "hold", out: null, in: null, epGain: 0, hitCost: 0, netGain: 0 },
    });
    const findings = coverage("Haaland captains. Good luck.", held);
    expect(messages(findings)).toContain("hold");
  });

  it("accepts a hold described as rolling the transfer", () => {
    const held = context({
      transfer: { kind: "hold", out: null, in: null, epGain: 0, hitCost: 0, netGain: 0 },
    });
    expect(coverage("Haaland captains; roll the transfer.", held)).toEqual([]);
  });

  it("fails a hit that goes unmentioned", () => {
    // The first live run buried a four-point hit and then claimed a free
    // transfer that did not exist. This is that regression.
    const hit = context({
      transfer: {
        kind: "transfer",
        out: "Wood",
        in: "Watkins",
        epGain: 9.1,
        hitCost: 4,
        netGain: 5.1,
      },
      freeTransfers: 0,
    });
    const findings = coverage("Haaland captains. Wood to Watkins nets 5.1.", hit);
    expect(messages(findings)).toContain("hit");
  });

  it("fails silence about a flag on the best player in the squad", () => {
    const flagged = context({
      flagged: [
        { name: "Haaland", position: "FWD", club: "MCI", ep: 8.2, flag: "Knock - 75%" },
      ],
    });
    const findings = coverage("Salah looks strong. Wood to Watkins.", flagged);
    expect(findings.some((f) => f.severity === "fail")).toBe(true);
  });

  it("demotes a second, lesser flag to a warning", () => {
    // Four short paragraphs is a real budget. The flag that matters is a
    // failure; the one on a bench player is worth a look, not a red build.
    const flagged = context({
      flagged: [
        { name: "Haaland", position: "FWD", club: "MCI", ep: 8.2, flag: "Knock - 75%" },
        { name: "Pope", position: "GKP", club: "NEW", ep: 2.3, flag: "Doubtful - 25%" },
      ],
    });
    const findings = coverage(
      "Haaland is flagged but keeps the armband. Wood makes way for Watkins.",
      flagged,
    ).filter((f) => f.message.includes("flagged player"));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("Pope");
    expect(findings[0]!.severity).toBe("warn");
  });

  it("fails an unhedged brief when projections rest on last season", () => {
    const prior = context({ priorSeasonOnly: true });
    const findings = coverage("Haaland captains. Wood to Watkins.", prior);
    expect(messages(findings)).toContain("last season");
  });
});

describe("speculation", () => {
  it("flags form, which is nowhere in the context type", () => {
    const findings = speculation("Salah's underlying form justifies it.", context());
    expect(messages(findings)).toContain("form");
  });

  it("flags fixtures, opponents and venue", () => {
    expect(messages(speculation("The fixtures break well.", context()))).toContain(
      "fixtures",
    );
    expect(messages(speculation("He is at home to Burnley.", context()))).toContain(
      "venue",
    );
  });

  it("flags an invented injury prognosis", () => {
    const findings = speculation("He is expected back after the break.", context());
    expect(messages(findings)).toContain("prognosis");
  });

  it("stops treating minutes as invention once the prompt raises them", () => {
    // The prior-season note hands the model the word by name, so it stops
    // being evidence of anything.
    const prior = context({ priorSeasonOnly: true });
    expect(speculation("Rotation is unknowable this early.", prior)).toEqual([]);
    expect(messages(speculation("Rotation is a risk.", context()))).toContain("minutes");
  });

  it("never fails a build on its own", () => {
    const findings = speculation("The fixtures break well and he is in form.", context());
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.severity === "warn")).toBe(true);
  });
});

describe("gradeDeterministic", () => {
  const evalCase = (over: Partial<EvalCase> = {}): EvalCase => ({
    id: "test",
    why: "test",
    context: context(),
    ...over,
  });

  it("passes a brief that stays inside its input", () => {
    const text =
      "Haaland keeps the armband on 8.2, a 25% chance of 10+ against an 8% blank. " +
      "Salah at 7.9 is close enough to be a real alternative.\n\n" +
      "Wood makes way for Watkins, worth 6.4 over the horizon with no hit.";
    const result = gradeDeterministic(text, evalCase());
    expect(result.findings).toEqual([]);
  });

  it("enforces case-specific expectations", () => {
    const result = gradeDeterministic(
      "Haaland captains. Wood to Watkins.",
      evalCase({ forbid: ["Watkins"] }),
    );
    expect(messages(result.findings)).toContain("must not contain");
    expect(result.failures).toBeGreaterThan(0);
  });

  it("separates failures from warnings", () => {
    const result = gradeDeterministic(
      "Haaland captains on the back of good form. Wood to Watkins.",
      evalCase(),
    );
    expect(result.failures).toBe(0);
    expect(result.warnings).toBeGreaterThan(0);
  });
});
