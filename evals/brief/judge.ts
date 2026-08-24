import { complete, DELIBERATION_MODEL } from "@/lib/llm/client";
import type { BriefContext } from "@/lib/llm/brief";

/**
 * The paid layer.
 *
 * `graders.ts` catches fabricated numbers and missing coverage for nothing.
 * What it cannot catch is the failure the system prompt calls the worst thing
 * the model can do: a sentence that is grammatical, plausible, specific, and
 * about a fact nobody supplied. "His minutes have dried up" defeats a regex
 * because there is nothing wrong with the words.
 *
 * So: extract every atomic claim, then judge each one against the input.
 *
 * Two stages rather than one score, because "rate this brief 1-5" is the same
 * mistake as scoring a scoreline model on exact-score accuracy. It rewards
 * saying little, it cannot be decomposed, and it drifts between runs. Claim
 * extraction gives a denominator, which turns a vibe into a rate.
 *
 * The judge runs on a stronger model than the writer. Judging is the harder
 * task, and a judge no better than the author cannot see the author's errors.
 */

/**
 * Three labels, not two.
 *
 * The system prompt does not forbid reasoning — it forbids supplying missing
 * facts, and explicitly permits noticing that three players share a club or
 * that one projection sits near another. A binary grounded/ungrounded judge
 * would mark every comparison the prompt asks for as a hallucination, so the
 * distinction the prompt draws has to be the distinction the judge draws.
 */
export type ClaimVerdict = "GROUNDED" | "DERIVED" | "UNGROUNDED";

export interface JudgedClaim {
  claim: string;
  verdict: ClaimVerdict;
  reason: string;
}

export interface JudgeResult {
  claims: JudgedClaim[];
  /** (grounded + derived) / total. The headline number. */
  groundedness: number;
  ungrounded: JudgedClaim[];
  cost: { inputTokens: number; outputTokens: number };
}

const EXTRACT_SYSTEM = `You break a piece of writing into atomic factual claims.

A claim is a single assertion that could be true or false. Split compound
sentences. Drop pure exhortation ("captain him"), questions, and hedged
non-assertions ("it's a close call" is a claim about closeness — keep it;
"good luck" is not).

Rewrite each claim to stand alone: replace pronouns with the name they refer to.

Output ONLY a JSON array of strings. No prose, no code fence.`;

const VERIFY_SYSTEM = `You check claims against a source record. You are strict and literal.

For each claim, choose exactly one label:

GROUNDED — the record states this directly.
DERIVED — the record does not state it, but it follows from the record by
  comparison, arithmetic, counting, or grouping. "Haaland is the highest
  projection" over a record of projections is DERIVED. "Three of these players
  are Arsenal" over a record listing clubs is DERIVED. Judgement about what is
  in the record is DERIVED, not UNGROUNDED.
UNGROUNDED — it asserts a fact the record does not contain and cannot yield.
  Anything about fixtures, opponents, venue, form, recent minutes, rotation,
  prices, ownership, injury prognosis, or what a manager said is UNGROUNDED,
  because none of that is in the record. So is any number that does not appear
  in the record and cannot be computed from it.

A claim that merely restates the record's own uncertainty is GROUNDED.

Evaluative judgement about what the record contains — that a squad is
well-balanced, a bench is thin, a captaincy call is close, a move is worth
making — is DERIVED, not UNGROUNDED, so long as it asserts no fact from outside
the record. The writer is permitted opinions about the numbers. It is not
permitted new numbers or new facts.

Output ONLY a JSON array of objects, each {"claim": string, "verdict": string,
"reason": string}. One per claim, in order. Reason: at most 15 words. No prose,
no code fence.`;

/**
 * What the record's fields mean.
 *
 * The first judged run marked "Haaland has a 25% chance of double digits" as
 * ungrounded, on the reasonable ground that a field called `pHaul` does not
 * announce its own threshold. It marked "half a million in the bank" wrong too,
 * because `bank: 5` is in tenths of a million and nothing said so.
 *
 * Both were the judge's failure, not the brief's, and both came from the same
 * over-correction: stripping the prompt to raw JSON removed the rhetoric AND
 * the schema. A legend restores the second without the first. These are facts
 * about what the numbers denote — never instructions about how to write.
 */
const LEGEND = `FIELD MEANINGS (part of the record):
- ep: expected Fantasy Premier League points for this gameweek.
- position: GKP, DEF, MID or FWD. club: the team's three-letter code.
- flag: the official availability note for that player, verbatim.
- captain.pHaul: probability the captain scores 10 or more points.
- captain.pBlank: probability the captain scores 2 or fewer points.
- captain.ep is the pre-armband projection; the armband doubles it.
- bank: money in TENTHS of a million pounds. bank: 5 means £0.5m.
- freeTransfers: transfers available without a points deduction.
- transfer.epGain: expected points gained over a multi-gameweek horizon.
  hitCost: points deducted for exceeding the free transfers.
  netGain: epGain minus hitCost.
- chip.gain: expected points from playing the chip this gameweek.
  chip.margin: how much better this week is than the next available week;
  null means no better week remains.
- record: how the engine's past decisions scored against the alternatives it
  passed over. net is the running points difference.
- priorSeasonOnly: true when no gameweek has been played and projections come
  from last season, so minutes are unknown.

The record contains NO player prices, NO fixtures, NO opponents, NO venue, NO
form, NO minutes played and NO ownership. Claims about any of those are
UNGROUNDED however plausible they sound.`;

/**
 * What the model was actually given, as a record rather than as a prompt.
 *
 * Deliberately NOT `buildPrompt`. The judge must check the brief against the
 * facts, and feeding it the same instructions the author read invites it to
 * grade tone and compliance instead. JSON plus a legend has no rhetoric in it.
 */
export function asRecord(context: BriefContext): string {
  return `${LEGEND}\n\nRECORD:\n${JSON.stringify(context, null, 2)}`;
}

function parseJson<T>(text: string): T | null {
  // Models fence JSON even when told not to. Strip it rather than fail.
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Last resort: the outermost array in the response.
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as T;
    } catch {
      return null;
    }
  }
}

const VERDICTS: ReadonlySet<string> = new Set([
  "GROUNDED",
  "DERIVED",
  "UNGROUNDED",
]);

/**
 * Judge one brief. Returns null with no key, or when either stage fails to
 * produce parseable output — a broken judge must read as "not measured", never
 * as "measured, and fine".
 */
export async function judge(
  text: string,
  context: BriefContext,
): Promise<JudgeResult | null> {
  const extraction = await complete({
    system: EXTRACT_SYSTEM,
    prompt: text,
    model: DELIBERATION_MODEL,
    maxTokens: 2000,
  });
  if (extraction === null) return null;

  const claims = parseJson<string[]>(extraction.text);
  if (claims === null || claims.length === 0) return null;

  const verification = await complete({
    system: VERIFY_SYSTEM,
    prompt: `${asRecord(context)}\n\nCLAIMS:\n${JSON.stringify(claims, null, 2)}`,
    model: DELIBERATION_MODEL,
    maxTokens: 4000,
  });
  if (verification === null) return null;

  const raw = parseJson<{ claim: string; verdict: string; reason: string }[]>(
    verification.text,
  );
  if (raw === null) return null;

  const judged: JudgedClaim[] = raw.map((row, index) => ({
    claim: row.claim ?? claims[index] ?? "",
    // An unrecognised label is counted against the brief. The alternative is a
    // judge that can silently award a pass by malfunctioning.
    verdict: VERDICTS.has(row.verdict) ? (row.verdict as ClaimVerdict) : "UNGROUNDED",
    reason: row.reason ?? "",
  }));

  if (judged.length === 0) return null;

  const ungrounded = judged.filter((c) => c.verdict === "UNGROUNDED");

  return {
    claims: judged,
    groundedness: (judged.length - ungrounded.length) / judged.length,
    ungrounded,
    cost: {
      inputTokens: extraction.inputTokens + verification.inputTokens,
      outputTokens: extraction.outputTokens + verification.outputTokens,
    },
  };
}
