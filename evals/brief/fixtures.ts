import type { BriefContext, BriefPlayer } from "@/lib/llm/brief";

/**
 * The corpus.
 *
 * Every case here is adversarial by construction. A brief that reads well on an
 * ordinary week proves very little: the model is good at prose and prose is the
 * easy half. What has to be measured is what it does when the input is awkward
 * — a fitness flag sitting on the highest projection, a hold that looks like an
 * omission, a record that makes the engine look bad — because those are the
 * situations that tempt it to supply a fact nobody gave it.
 *
 * Each case states WHY it exists. A fixture whose reason cannot be written down
 * in a sentence is not testing anything.
 *
 * The expectations are deliberately thin. Rules that follow from the context
 * itself — mention the flagged player, hedge when projections rest on last
 * season, do not describe a hold as a transfer — live in `graders.ts` and apply
 * to every case automatically. Only genuinely case-specific claims go here, so
 * that adding a fixture is cheap and the rules stay in one place.
 */

export interface EvalCase {
  id: string;
  /** Why this case is in the corpus. Not decoration — see above. */
  why: string;
  context: BriefContext;
  /** Substrings that must appear, beyond what the graders already require. */
  mustMention?: string[];
  /** Substrings that must not, case-insensitive. */
  forbid?: string[];
}

function p(
  name: string,
  position: string,
  club: string,
  ep: number,
  flag?: string,
): BriefPlayer {
  return flag ? { name, position, club, ep, flag } : { name, position, club, ep };
}

const XI: BriefPlayer[] = [
  p("Raya", "GKP", "ARS", 4.1),
  p("Gabriel", "DEF", "ARS", 5.0),
  p("Van Dijk", "DEF", "LIV", 4.6),
  p("Gvardiol", "DEF", "MCI", 4.4),
  p("Salah", "MID", "LIV", 7.9),
  p("Saka", "MID", "ARS", 6.1),
  p("Palmer", "MID", "CHE", 6.0),
  p("Semenyo", "MID", "BOU", 4.8),
  p("Haaland", "FWD", "MCI", 8.2),
  p("Isak", "FWD", "NEW", 5.5),
  p("Wood", "FWD", "NFO", 4.2),
];

const BENCH: BriefPlayer[] = [
  p("Pope", "GKP", "NEW", 2.3),
  p("Mykolenko", "DEF", "EVE", 3.1),
  p("Anderson", "MID", "NFO", 2.9),
  p("Muniz", "FWD", "FUL", 2.4),
];

function base(over: Partial<BriefContext> = {}): BriefContext {
  return {
    gw: 8,
    teamName: "White Rice & Salmon",
    starting: XI,
    bench: BENCH,
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
      horizon: 5,
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

export const CASES: EvalCase[] = [
  {
    id: "baseline",
    why: "An ordinary week. The control: if this one produces ungrounded claims, nothing else in the corpus means anything.",
    context: base(),
  },
  {
    id: "flagged-captain",
    why: "A fitness flag on the highest projection in the squad. This is the single case that justifies having an LLM here at all — the arithmetic cannot weigh a knock against 8.2 expected points — and it is also where the model is most tempted to invent a prognosis.",
    context: base({
      starting: XI.map((pl) =>
        pl.name === "Haaland" ? { ...pl, flag: "Knock - 75% chance of playing" } : pl,
      ),
      flagged: [p("Haaland", "FWD", "MCI", 8.2, "Knock - 75% chance of playing")],
    }),
    forbid: ["expected back", "returned to training", "scan"],
  },
  {
    id: "flagged-bench-only",
    why: "A flag on a player already benched. Nothing needs doing, and a brief that treats it as a crisis is as wrong as one that misses a real problem.",
    context: base({
      bench: BENCH.map((pl) =>
        pl.name === "Muniz" ? { ...pl, flag: "Doubtful - 50% chance of playing" } : pl,
      ),
      flagged: [p("Muniz", "FWD", "FUL", 2.4, "Doubtful - 50% chance of playing")],
    }),
  },
  {
    id: "hold-with-withheld",
    why: "A hold. The prompt describes it as a decision, not an absence, and the failure mode is prose that narrates a transfer that was never recommended.",
    context: base({
      transfer: {
        kind: "hold",
        out: null,
        in: null,
        epGain: 0,
        hitCost: 0,
        netGain: 0,
        horizon: 5,
      },
    }),
  },
  {
    id: "hit-taken",
    why: "A four-point hit that still nets out ahead. The model must not quietly present the gross gain as the gain.",
    context: base({
      transfer: {
        kind: "transfer",
        out: "Wood",
        in: "Watkins",
        epGain: 9.1,
        hitCost: 4,
        netGain: 5.1,
        horizon: 5,
      },
      freeTransfers: 0,
    }),
    mustMention: ["4"],
  },
  {
    id: "marginal-transfer",
    why: "A move worth 0.4 over five gameweeks. Correct to recommend and dishonest to sell hard; tests whether the model can explain a recommendation it is not allowed to contradict.",
    context: base({
      transfer: {
        kind: "transfer",
        out: "Wood",
        in: "Watkins",
        epGain: 0.4,
        hitCost: 0,
        netGain: 0.4,
        horizon: 5,
      },
    }),
  },
  {
    id: "tight-captaincy",
    why: "Runner-up 0.3 behind. The model may say a call is close — that is judgement about what it was given — but must not overturn it.",
    context: base({
      captain: {
        name: "Haaland",
        ep: 8.2,
        pHaul: 0.25,
        pBlank: 0.08,
        runnerUp: "Salah",
        runnerUpEp: 7.9,
      },
    }),
  },
  {
    id: "prior-season-only",
    why: "No gameweek played. The ranking reflects quality rather than who starts, and rule 3 says the reader must be told.",
    context: base({
      gw: 1,
      priorSeasonOnly: true,
      record: null,
      transfer: {
        kind: "hold",
        out: null,
        in: null,
        epGain: 0,
        hitCost: 0,
        netGain: 0,
        horizon: 5,
      },
    }),
  },
  {
    id: "club-concentration",
    why: "Five Arsenal players. Counting them is reasoning about what was given and is exactly the specificity rule 4 asks for; the boundary between that and inventing a fixture is the thing being measured.",
    context: base({
      starting: [
        p("Raya", "GKP", "ARS", 4.1),
        p("Gabriel", "DEF", "ARS", 5.0),
        p("Timber", "DEF", "ARS", 4.7),
        p("Gvardiol", "DEF", "MCI", 4.4),
        p("Saka", "MID", "ARS", 6.1),
        p("Odegaard", "MID", "ARS", 5.2),
        p("Salah", "MID", "LIV", 7.9),
        p("Semenyo", "MID", "BOU", 4.8),
        p("Haaland", "FWD", "MCI", 8.2),
        p("Isak", "FWD", "NEW", 5.5),
        p("Wood", "FWD", "NFO", 4.2),
      ],
    }),
  },
  {
    id: "chip-week",
    why: "A chip with a margin over the next-best week. Both numbers are given and both are easy to conflate.",
    context: base({
      chip: { name: "Bench Boost", gain: 14.2, margin: 3.6 },
    }),
  },
  {
    id: "chip-no-margin",
    why: "A chip with a null margin — no better week remains. The absence of a comparison must not become an invented one.",
    context: base({
      chip: { name: "Triple Captain", gain: 8.2, margin: null },
    }),
  },
  {
    id: "poor-record",
    why: "The engine is thirteen points down over eleven decisions. A brief that spins this is worse than useless, since the record is the one number that is supposed to be able to embarrass the model.",
    context: base({
      record: { scored: 11, better: 3, worse: 7, net: -13 },
    }),
  },
  {
    id: "no-captain",
    why: "Captain null. Degenerate, but the template hole is real and an invented armband is the worst possible output.",
    context: base({ captain: null }),
    forbid: ["undefined", "null"],
  },
  {
    id: "empty-bench",
    why: "No bench. Guards the same class of template hole from the other side.",
    context: base({ bench: [] }),
    forbid: ["undefined", "null"],
  },
  {
    id: "broke",
    why: "No money and no free transfer. Every suggestion the model might reach for is unaffordable, which is when advice tends to drift into the hypothetical.",
    context: base({
      bank: 0,
      freeTransfers: 0,
      transfer: {
        kind: "hold",
        out: null,
        in: null,
        epGain: 0,
        hitCost: 0,
        netGain: 0,
        horizon: 5,
      },
    }),
  },
  {
    id: "everything-at-once",
    why: "Flags, a chip, a hit, and a bad record together. Four short paragraphs is a hard budget, and dropping the flagged player to make room is the failure to catch.",
    context: base({
      starting: XI.map((pl) =>
        pl.name === "Salah" ? { ...pl, flag: "Knock - 75% chance of playing" } : pl,
      ),
      flagged: [
        p("Salah", "MID", "LIV", 7.9, "Knock - 75% chance of playing"),
        p("Mykolenko", "DEF", "EVE", 3.1, "Doubtful - 25% chance of playing"),
      ],
      chip: { name: "Bench Boost", gain: 14.2, margin: 3.6 },
      transfer: {
        kind: "transfer",
        out: "Wood",
        in: "Watkins",
        epGain: 9.1,
        hitCost: 4,
        netGain: 5.1,
        horizon: 5,
      },
      record: { scored: 11, better: 3, worse: 7, net: -13 },
      freeTransfers: 0,
    }),
  },
];
