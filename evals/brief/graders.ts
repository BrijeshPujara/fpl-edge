import { derivedFacts } from "@/lib/llm/brief";
import type { BriefContext, BriefPlayer } from "@/lib/llm/brief";
import type { EvalCase } from "./fixtures";

/**
 * The free layer.
 *
 * Everything here is a pure function over (brief text, the context it was given)
 * and costs nothing to run, which is what lets it gate CI on every push. The
 * judge in `judge.ts` catches the semantic hallucinations these cannot — "his
 * minutes have dried up" is grammatical, plausible, and invisible to a regex —
 * but it costs money and needs a key, so it runs nightly rather than on every
 * commit.
 *
 * The division is deliberate. A gate that is expensive gets switched off.
 *
 * SEVERITY is load-bearing. `fail` means the check is precise enough that a
 * green build should depend on it. `warn` means high recall and imperfect
 * precision: worth a human's eyes, never worth blocking a merge over. Getting
 * this wrong in the noisy direction is how eval suites end up disabled.
 */

export interface Finding {
  grader: string;
  severity: "fail" | "warn";
  message: string;
}

export interface GradeResult {
  findings: Finding[];
  failures: number;
  warnings: number;
}

/** Surname, for prose that will not repeat a full name every time. */
function surname(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts[parts.length - 1] ?? name;
}

function everyPlayer(context: BriefContext): BriefPlayer[] {
  return [...context.starting, ...context.bench, ...context.flagged];
}

function mentions(text: string, name: string): boolean {
  const needle = surname(name).toLowerCase();
  if (needle.length === 0) return false;
  return text.toLowerCase().includes(needle);
}

// --- Numbers -------------------------------------------------------------

/**
 * Every number in the brief must be a number it was given.
 *
 * The strongest check available without a model, because fabricated arithmetic
 * is the hallucination that reads most like fact. It is built as an explicit
 * allow-list of renderings rather than a fuzzy tolerance band: a value may be
 * printed exactly, to one decimal place, or rounded in either direction, and a
 * probability may be printed as a percentage. Anything else is unaccounted for.
 *
 * A tolerance band would have quietly accepted 8.6 written as "9" while also
 * accepting it written as "8". Enumerating the renderings says precisely which
 * transformations the prose is allowed to perform.
 */
export function groundedNumbers(text: string, context: BriefContext): Finding[] {
  const allowed = new Set<number>();

  const add = (value: number | null | undefined) => {
    if (value === null || value === undefined || !Number.isFinite(value)) return;
    // Exact, one decimal place, and rounded — and deliberately NOT floored or
    // ceiled. Allowing all three put a band of ±1 around every projection, so
    // "7 of his last 9" passed against a squad containing a 7.9 and an 8.2.
    // Prose rounds; it does not truncate.
    for (const rendering of [
      value,
      Number(value.toFixed(1)),
      Math.round(value),
      Math.abs(value),
      Math.round(Math.abs(value)),
    ]) {
      allowed.add(rendering);
    }
  };
  /** Probabilities reach the prompt as percentages, so both forms are given. */
  const addProbability = (value: number) => {
    add(value);
    add(value * 100);
  };

  // Small integers are structurally unavoidable in English prose about a
  // football team and carry no factual weight on their own.
  add(0);
  add(1);
  add(2);

  add(context.gw);
  add(context.freeTransfers);
  add(context.bank);
  add(context.bank / 10); // the prompt prints bank in millions
  add(context.starting.length);
  add(context.bench.length);
  add(context.flagged.length);

  for (const player of everyPlayer(context)) {
    add(player.ep);
    // A flag note is free text the prompt passes through verbatim: "75% chance
    // of playing" puts 75 legitimately into the model's hands.
    for (const found of player.flag?.match(/\d+(?:\.\d+)?/g) ?? []) {
      add(Number(found));
    }
  }

  // Everything the prompt hands over ready-made.
  //
  // Taken from `derivedFacts` rather than recomputed here, so the allow-list
  // cannot drift from what the model was actually given. Two hand-maintained
  // copies of the same arithmetic would agree until the day they did not, and
  // that day the eval would start failing correct numbers — the one failure
  // mode that destroys trust in a gate.
  const facts = derivedFacts(context);
  add(facts.xiTotal);
  add(facts.xiTotalWithArmband);
  add(facts.benchTotal);
  add(facts.benchBest?.ep);
  add(facts.captainGap);
  for (const { count } of facts.clubCounts) add(count);
  for (const part of facts.formation.split("-")) add(Number(part));

  // The squad total is not in the prompt, but it is the sum of two numbers
  // that are, so quoting it is arithmetic the reader could check.
  const sum = (players: BriefPlayer[]) =>
    players.reduce((total, player) => total + player.ep, 0);
  add(sum([...context.starting, ...context.bench]));

  // Counting your own Chelsea midfielders is reasoning about what was given,
  // which rule 1 explicitly permits and rule 4 asks for.
  for (const key of ["club", "position"] as const) {
    const counts = new Map<string, number>();
    for (const player of context.starting) {
      counts.set(player[key], (counts.get(player[key]) ?? 0) + 1);
    }
    for (const count of counts.values()) add(count);
  }

  if (context.captain) {
    add(context.captain.ep);
    addProbability(context.captain.pHaul);
    addProbability(context.captain.pBlank);
    add(context.captain.runnerUpEp);
    // Fixed thresholds in the prompt's own wording: "chance of 10+", "2 or
    // fewer". The model is quoting the question, not inventing a number.
    add(10);
  }

  if (context.transfer) {
    add(context.transfer.epGain);
    add(context.transfer.hitCost);
    add(context.transfer.netGain);
  }

  if (context.chip) {
    add(context.chip.gain);
    add(context.chip.margin);
  }

  if (context.record) {
    add(context.record.scored);
    add(context.record.better);
    add(context.record.worse);
    add(context.record.net);
  }

  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(/\d+(?:\.\d+)?/g)) {
    const raw = match[0];
    if (seen.has(raw)) continue;
    seen.add(raw);

    const value = Number(raw);
    if (allowed.has(value)) continue;

    findings.push({
      grader: "numbers",
      severity: "fail",
      message: `"${raw}" is not a number the model was given, nor a permitted rendering of one`,
    });
  }
  return findings;
}

// --- Names ---------------------------------------------------------------

/**
 * Three-letter codes are what the record carries; prose says the whole name.
 *
 * Expanding a code the record contains is derivation, not invention, so the
 * expansion has to be spelled out somewhere. Twenty rows that change three
 * times a season is a cheaper price than a names check nobody trusts.
 */
const CLUB_NAMES: Record<string, string[]> = {
  ARS: ["Arsenal"],
  AVL: ["Aston", "Villa"],
  BOU: ["Bournemouth", "AFC"],
  BRE: ["Brentford"],
  BHA: ["Brighton", "Albion", "Hove"],
  BUR: ["Burnley"],
  CHE: ["Chelsea"],
  CRY: ["Crystal", "Palace"],
  EVE: ["Everton"],
  FUL: ["Fulham"],
  LEE: ["Leeds", "United"],
  LIV: ["Liverpool"],
  MCI: ["Manchester", "City"],
  MUN: ["Manchester", "United"],
  NEW: ["Newcastle", "United"],
  NFO: ["Nottingham", "Forest"],
  SUN: ["Sunderland"],
  TOT: ["Tottenham", "Hotspur", "Spurs"],
  WHU: ["West", "Ham", "United"],
  WOL: ["Wolves", "Wolverhampton", "Wanderers"],
};

/**
 * Words that are capitalised in ordinary English prose about this subject, and
 * would otherwise read as invented footballers.
 */
const CAPITALISED_ORDINARY = new Set(
  [
    "a", "an", "and", "as", "at", "bank", "bench", "boost", "but", "by",
    "captain", "captaincy", "chip", "defence", "defender", "defenders",
    "even", "everything", "for", "forward", "forwards", "free", "friday",
    "gameweek",
    "gameweeks", "goalkeeper", "hit", "hold", "holding", "i", "if", "in",
    "it", "keeper", "league", "manager", "midfield", "midfielder",
    "midfielders", "monday", "no", "none", "nothing", "of", "on", "one", "or",
    "premier",
    "saturday", "so", "still", "sunday", "that", "the", "there", "this",
    "three", "thursday", "transfer",
    "transfers", "triple", "tuesday", "two", "wednesday", "wildcard", "with",
    "without", "xi", "you",
    "your",
  ].map((word) => word.toLowerCase()),
);

/**
 * Capitalised words that name nobody in the input.
 *
 * WARN, not fail. English capitalises for many reasons and this check trades
 * precision for recall on purpose: inventing a footballer is severe enough to
 * be worth a few false positives in a report a human reads, and nowhere near
 * precise enough to block a merge.
 */
export function knownNames(text: string, context: BriefContext): Finding[] {
  const allowed = new Set<string>();
  const permit = (value: string | null | undefined) => {
    if (!value) return;
    // Both the whole name and its parts: prose says "Van Dijk" or "Dijk".
    allowed.add(value.toLowerCase());
    for (const token of value.split(/[\s'’-]+/)) {
      if (token.length > 0) allowed.add(token.toLowerCase());
    }
    for (const expansion of CLUB_NAMES[value.toUpperCase()] ?? []) {
      allowed.add(expansion.toLowerCase());
    }
  };

  for (const player of everyPlayer(context)) {
    permit(player.name);
    permit(player.club);
    permit(player.position);
    permit(player.flag);
  }
  permit(context.teamName);
  permit(context.captain?.name);
  permit(context.captain?.runnerUp);
  permit(context.transfer?.out);
  permit(context.transfer?.in);
  permit(context.chip?.name);

  const findings: Finding[] = [];
  const seen = new Set<string>();

  // A capitalised word not at the start of a sentence, and not immediately
  // after a quote or opening bracket.
  for (const match of text.matchAll(/([^\s])\s+([A-Z][a-zA-Z]{2,}(?:['’]s)?)/g)) {
    const preceding = match[1] ?? "";
    const word = match[2] ?? "";
    if (/[.!?:;"'’(\[]/.test(preceding)) continue;

    // "Haaland's" is Haaland. Strip the possessive before looking it up.
    const key = word.toLowerCase().replace(/['’]s$/, "");
    if (allowed.has(key)) continue;
    if (CAPITALISED_ORDINARY.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);

    findings.push({
      grader: "names",
      severity: "warn",
      message: `"${word}" is capitalised mid-sentence but names nobody in the input`,
    });
  }
  return findings;
}

// --- Form ----------------------------------------------------------------

const META_PHRASES: [RegExp, string][] = [
  [/\bas an AI\b/i, "refers to itself as an AI"],
  [/\bAI (assistant|model|language model)\b/i, "refers to itself as an AI"],
  [/\bmy (instructions|prompt|rules|guidelines)\b/i, "describes its own instructions"],
  [/\bsystem prompt\b/i, "describes its own instructions"],
  [/\bthe (input|context|data|information) (above|below|provided|given|supplied)\b/i, "describes its own input"],
  [/\b(you|I was) (asked|provided|gave|given)\b/i, "describes its own input"],
  [/\bbased on the (data|input|information) (provided|given|above)\b/i, "describes its own input"],
];

/** Rule 5, and the closing rule. Mechanically checkable, so checked. */
export function formRules(text: string): Finding[] {
  const findings: Finding[] = [];

  if (/^\s*#{1,6}\s/m.test(text)) {
    findings.push({ grader: "form", severity: "fail", message: "uses a heading" });
  }
  if (/^\s*[-*•]\s/m.test(text)) {
    findings.push({ grader: "form", severity: "fail", message: "uses a bullet list" });
  }
  if (/^\s*\d+[.)]\s/m.test(text)) {
    findings.push({ grader: "form", severity: "fail", message: "uses a numbered list" });
  }

  const paragraphs = text.trim().split(/\n\s*\n/).filter((part) => part.trim().length > 0);
  if (paragraphs.length > 4) {
    findings.push({
      grader: "form",
      severity: "fail",
      message: `${paragraphs.length} paragraphs; the brief is capped at four`,
    });
  }

  for (const [pattern, description] of META_PHRASES) {
    if (pattern.test(text)) {
      findings.push({ grader: "form", severity: "fail", message: description });
    }
  }
  return findings;
}

// --- Coverage ------------------------------------------------------------

const HEDGES = [
  "last season", "no gameweek", "not yet been played", "hasn't been played",
  "has not been played", "before a ball", "quality rather than",
  "rather than who", "who will actually start", "who will start",
  "minutes are not", "minutes aren't", "first gameweek", "opening gameweek",
  "no minutes", "untested", "unplayed",
];

const HOLD_WORDS = [
  "hold", "holding", "held", "roll", "rolling", "rolled", "bank", "banking",
  "banked", "stand pat", "no move", "no transfer", "leave it", "sit tight",
  "keep the transfer", "save the transfer", "do nothing", "stay put",
];

/**
 * Say the things the context makes mandatory.
 *
 * A brief that invents nothing and also says nothing is not a success. This is
 * the second axis: groundedness alone is trivially maximised by writing four
 * paragraphs of hedge, and a single-metric eval would score that perfect.
 */
export function coverage(text: string, context: BriefContext): Finding[] {
  const findings: Finding[] = [];
  const lower = text.toLowerCase();

  if (context.captain && !mentions(text, context.captain.name)) {
    findings.push({
      grader: "coverage",
      severity: "fail",
      message: `never names the captain (${context.captain.name})`,
    });
  }

  if (context.flagged.length > 0) {
    // Four short paragraphs is a real budget, so only the flag that matters
    // most is a hard failure; the rest are worth a look.
    const ranked = [...context.flagged].sort((a, b) => b.ep - a.ep);
    ranked.forEach((player, index) => {
      if (mentions(text, player.name)) return;
      findings.push({
        grader: "coverage",
        severity: index === 0 ? "fail" : "warn",
        message: `flagged player ${player.name} (${player.flag}) is never mentioned`,
      });
    });
  }

  if (context.priorSeasonOnly && !HEDGES.some((hedge) => lower.includes(hedge))) {
    findings.push({
      grader: "coverage",
      severity: "fail",
      message: "projections rest on last season and the brief does not say so",
    });
  }

  if (context.transfer?.kind === "hold") {
    if (!HOLD_WORDS.some((word) => lower.includes(word))) {
      findings.push({
        grader: "coverage",
        severity: "fail",
        message: "a hold was recommended and the brief never presents it as a decision",
      });
    }
  }

  if (context.transfer?.kind === "transfer") {
    for (const [role, name] of [
      ["out", context.transfer.out],
      ["in", context.transfer.in],
    ] as const) {
      if (name && !mentions(text, name)) {
        findings.push({
          grader: "coverage",
          severity: "fail",
          message: `the recommended transfer ${role} (${name}) is never named`,
        });
      }
    }
    if (context.transfer.hitCost > 0 && !/\bhit\b|\bpoints? (cost|hit)\b|-\s*\d/i.test(text)) {
      findings.push({
        grader: "coverage",
        severity: "fail",
        message: `a ${context.transfer.hitCost}-point hit is being taken and the brief does not say so`,
      });
    }
  }

  if (context.chip && !lower.includes(context.chip.name.toLowerCase())) {
    findings.push({
      grader: "coverage",
      severity: "fail",
      message: `a chip is due (${context.chip.name}) and the brief never names it`,
    });
  }

  return findings;
}

// --- Speculation ---------------------------------------------------------

/**
 * Subjects the model has no information about.
 *
 * `BriefContext` contains no fixtures, no form, no minutes, no prices and no
 * ownership. Any of those appearing is ungrounded by construction — this is not
 * a stylistic preference but a fact about the type. Rule 1 names two of these
 * verbatim as the worst thing the model can do.
 *
 * WARN: the judge confirms. A phrase list cannot tell "the fixture run supports
 * it" from "whatever the fixtures turn out to be", and only one of those is a
 * claim.
 */
const SPECULATION: [RegExp, string][] = [
  [/\bfixtures?\b|\bopponents?\b|\brun of games\b|\bkick-?off\b/i, "fixtures (not in the input)"],
  [/\bdouble gameweek\b|\bblank gameweek\b|\bDGW\b|\bBGW\b/i, "fixture congestion (not in the input)"],
  // Broad on purpose: the first live run produced "despite decent underlying
  // form", which every narrower spelling of this pattern walked straight past.
  [/\bform\b|\bmomentum\b|\bpurple patch\b/i, "form (not in the input)"],
  [/\brotation\b|\bhas started\b|\bminutes have\b|\bstarted the last\b/i, "minutes (not in the input)"],
  [/\bprice ris\w+\b|\bprice fall\w*\b|\bownership\b|\btemplate\b|\bdifferential\b/i, "prices or ownership (not in the input)"],
  [/\bxG\b|\bexpected goals\b|\bunderlying (numbers|stats)\b/i, "underlying stats (not in the input)"],
  [/\bexpected back\b|\breturned to training\b|\bscan\b|\bsurgery\b|\bweeks out\b/i, "an injury prognosis (not in the input)"],
  [/\bthe manager (said|suggested|confirmed)\b|\bpress conference\b/i, "a manager's words (not in the input)"],
  [/\bhome\b|\baway\b/i, "venue (not in the input)"],
  [/\b(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\b|\b(January|February|March|April|June|July|August|September|October|November|December)\b/i, "a date (not in the input)"],
];

export function speculation(text: string, context: BriefContext): Finding[] {
  const findings: Finding[] = [];

  for (const [pattern, subject] of SPECULATION) {
    // The prior-season note hands the model "last season" and "minutes" by
    // name, so those words stop being evidence of invention in that case.
    if (context.priorSeasonOnly && /minutes/.test(pattern.source)) continue;

    const match = text.match(pattern);
    if (!match) continue;

    findings.push({
      grader: "speculation",
      severity: "warn",
      message: `mentions ${subject}: "${match[0]}"`,
    });
  }
  return findings;
}

// --- Case-specific -------------------------------------------------------

function caseExpectations(text: string, evalCase: EvalCase): Finding[] {
  const findings: Finding[] = [];
  const lower = text.toLowerCase();

  for (const needle of evalCase.mustMention ?? []) {
    if (!lower.includes(needle.toLowerCase())) {
      findings.push({
        grader: "case",
        severity: "fail",
        message: `must mention "${needle}"`,
      });
    }
  }
  for (const needle of evalCase.forbid ?? []) {
    if (lower.includes(needle.toLowerCase())) {
      findings.push({
        grader: "case",
        severity: "fail",
        message: `must not contain "${needle}"`,
      });
    }
  }
  return findings;
}

/** Every free check, over one brief. */
export function gradeDeterministic(text: string, evalCase: EvalCase): GradeResult {
  const findings = [
    ...groundedNumbers(text, evalCase.context),
    ...knownNames(text, evalCase.context),
    ...formRules(text),
    ...coverage(text, evalCase.context),
    ...speculation(text, evalCase.context),
    ...caseExpectations(text, evalCase),
  ];

  return {
    findings,
    failures: findings.filter((f) => f.severity === "fail").length,
    warnings: findings.filter((f) => f.severity === "warn").length,
  };
}
