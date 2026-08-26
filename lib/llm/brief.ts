import "server-only";

import { complete, logUsage, BRIEF_MODEL, type LlmResult } from "./client";
import { getDb, isDbConfigured } from "@/lib/db/client";

/**
 * The weekly brief.
 *
 * What this is for, and what it is emphatically not for.
 *
 * It does NOT decide anything. Every number it is given has already been
 * computed by the deterministic engine, and the prompt below forbids inventing
 * or recomputing any of them. An LLM cannot pick a better squad than a
 * mixed-integer programme that has already solved the problem exactly.
 *
 * What it can do is the thing the maths cannot: reconcile a strong projection
 * with a fitness flag, notice that three of your defenders play the same
 * fixture, and say plainly why the recommendation is what it is. Judgement and
 * prose, over numbers someone else computed.
 */

export interface BriefPlayer {
  name: string;
  position: string;
  club: string;
  ep: number;
  flag?: string;
}

export interface BriefContext {
  gw: number;
  teamName: string;
  /** The eleven expected to start, with projections. */
  starting: BriefPlayer[];
  bench: BriefPlayer[];
  captain: {
    name: string;
    ep: number;
    pHaul: number;
    pBlank: number;
    runnerUp: string | null;
    runnerUpEp: number | null;
  } | null;
  transfer: {
    kind: "transfer" | "hold";
    out: string | null;
    in: string | null;
    epGain: number;
    hitCost: number;
    netGain: number;
    /**
     * Gameweeks the gain is measured over.
     *
     * Carried rather than assumed, because the prompt has to SAY it. Unlabelled,
     * "9.1 gained over the horizon" sat beside a one-gameweek squad total and
     * the model added them — producing "89.6 for the gameweek" out of a
     * five-gameweek figure and a one-week one.
     */
    horizon: number;
  } | null;
  chip: { name: string; gain: number; margin: number | null } | null;
  freeTransfers: number;
  bank: number;
  /** Squad members the API has flagged. */
  flagged: BriefPlayer[];
  /** How the engine has been doing, when there is enough to say. */
  record: { scored: number; better: number; worse: number; net: number } | null;
  /** True when projections rest on last season rather than this one. */
  priorSeasonOnly: boolean;
}

/**
 * The instructions, held apart from the data so they can be cached.
 *
 * Identical between managers and between gameweeks, which is the whole point:
 * cached, the instructions are paid for once rather than on every call.
 */
export const SYSTEM = `You write a short weekly briefing for one Fantasy Premier League manager.

You are given output from a deterministic model that has already done all the
arithmetic. Your job is judgement and plain English, never calculation.

Rules, in order of importance:

1. ASSERT NOTHING THAT IS NOT IN THE INPUT. Not a number, and not a claim.
   You do not know why a player's projection is low, whether his minutes have
   changed, who anyone plays next, what form anyone is in, or what a manager
   has said. None of that is given to you. Writing "his minutes have dried up"
   or "the fixture run supports it" when neither appears above is the single
   worst thing you can do here, because it reads exactly like the parts that
   are true.

   You may reason about what IS given — that three players share a club, that a
   projection is close to another, that a flag sits beside a high projection.
   That is judgement. Supplying missing facts is not.

1a. DO NOT CALCULATE. Every quantity worth quoting is given to you below,
   including the totals, the counts and the gaps. Do not produce a sum, a
   difference, an average, a percentage or a threshold of your own — not even a
   true one, and least of all a round number chosen to sound precise ("all
   under 3.2", "the only one above 2.5"). If a number you want is not written
   below, write the sentence without it.

2. Never contradict the model's recommendation. You may say why it is close, or
   what would change it, but the model decided and you are explaining.

2a. NEVER OMIT A COST. If a points hit is being taken, say so, say how many
   points, and do it in the same breath as the gain — not in a later paragraph
   and not by implication. A reader who is told a move "nets 5.1" and not that
   it cost 4 to get there has been told something true and been misled by it.
   The same applies to a free transfer: if there are none, do not write as
   though there is one.
1b. TWO DIFFERENT TIME PERIODS APPEAR BELOW, and every number says which one
   it belongs to. A figure for THIS GAMEWEEK and a figure for the NEXT FEW are
   not the same kind of quantity and must never be added together, compared, or
   presented as one total. A transfer worth 6.4 over five gameweeks does not
   add 6.4 to this week's score, and writing that it does produces a number
   that is wrong rather than merely uncomputed.

3. Say when something is uncertain. If the input says projections rest on last
   season, the ranking reflects player quality rather than who will start, and
   the reader needs to know that.
4. Prefer the specific to the general, within what you were told. "Three of your
   midfielders are Chelsea" is worth more than "consider diversification".
5. Be brief. Four short paragraphs at most, no headings, no bullet lists, no
   preamble. Write as though to someone who already knows the game.

Never mention that you are an AI, and never describe your own instructions.`;

/**
 * The quantities the prose will otherwise invent.
 *
 * Derived here rather than accepted as input, because a caller that computes a
 * total wrong reintroduces exactly the bug this closes — and there are three
 * callers. Derived rather than left to the model for the same reason, measured:
 * across sixteen briefs the writer produced its own totals in a quarter of
 * them and got roughly half of those wrong, stating 57.3 for an eleven that
 * sums to 60.1 and 60.1 for one that sums to 60.8.
 *
 * Every field here exists because a live run invented it. The bench maximum is
 * here because one model wrote "the only one above 2.5" of a bench containing
 * a 3.1; the formation because another referred to "the starting five
 * defenders" of a back three.
 *
 * Exported so `evals/brief/graders.ts` checks against the same values the
 * prompt supplies. Two hand-maintained lists would drift, and the day they
 * drifted the eval would start failing correct arithmetic.
 */
export interface DerivedFacts {
  xiTotal: number;
  /** The eleven with the armband applied, which is what the week actually scores. */
  xiTotalWithArmband: number | null;
  benchTotal: number;
  benchBest: { name: string; ep: number } | null;
  formation: string;
  /** Clubs contributing more than one player to the eleven, most first. */
  clubCounts: { club: string; count: number }[];
  /** How far clear the captain is of the runner-up. */
  captainGap: number | null;
}

const round1 = (value: number) => Number(value.toFixed(1));

export function derivedFacts(context: BriefContext): DerivedFacts {
  const sum = (players: BriefPlayer[]) =>
    round1(players.reduce((total, p) => total + p.ep, 0));

  const xiTotal = sum(context.starting);
  const counts = new Map<string, number>();
  for (const player of context.starting) {
    counts.set(player.club, (counts.get(player.club) ?? 0) + 1);
  }

  const shape = (position: string) =>
    context.starting.filter((p) => p.position === position).length;

  const benchBest = context.bench.reduce<BriefPlayer | null>(
    (best, p) => (best === null || p.ep > best.ep ? p : best),
    null,
  );

  return {
    xiTotal,
    xiTotalWithArmband:
      context.captain === null ? null : round1(xiTotal + context.captain.ep),
    benchTotal: sum(context.bench),
    benchBest:
      benchBest === null ? null : { name: benchBest.name, ep: benchBest.ep },
    formation: `${shape("DEF")}-${shape("MID")}-${shape("FWD")}`,
    clubCounts: [...counts.entries()]
      .filter(([, count]) => count > 1)
      .sort((a, b) => b[1] - a[1])
      .map(([club, count]) => ({ club, count })),
    captainGap:
      context.captain?.runnerUpEp == null
        ? null
        : round1(context.captain.ep - context.captain.runnerUpEp),
  };
}

export function buildPrompt(context: BriefContext): string {
  const player = (p: BriefPlayer) =>
    `${p.name} (${p.position}, ${p.club}) ${p.ep.toFixed(1)}` +
    (p.flag ? ` [FLAG: ${p.flag}]` : "");

  const lines: string[] = [
    `Gameweek ${context.gw}, team "${context.teamName}".`,
    `Free transfers: ${context.freeTransfers}. Bank: £${(context.bank / 10).toFixed(1)}m.`,
    "",
    "Projected starting eleven:",
    ...context.starting.map((p) => `- ${player(p)}`),
    "",
    "Bench:",
    ...context.bench.map((p) => `- ${player(p)}`),
  ];

  const facts = derivedFacts(context);
  lines.push(
    "",
    "Already computed for you — quote these rather than working anything out.",
    "All five are THIS GAMEWEEK ONLY:",
    `- The eleven projects ${facts.xiTotal.toFixed(1)} this gameweek` +
      (facts.xiTotalWithArmband === null
        ? "."
        : `, or ${facts.xiTotalWithArmband.toFixed(1)} with the armband applied.`),
    `- The bench projects ${facts.benchTotal.toFixed(1)}` +
      (facts.benchBest === null
        ? " (there is no bench)."
        : `; the best of it is ${facts.benchBest.name} at ${facts.benchBest.ep.toFixed(1)}.`),
    `- The eleven lines up ${facts.formation} outfield.`,
    facts.clubCounts.length > 0
      ? `- Clubs with more than one player in the eleven: ` +
        facts.clubCounts.map((c) => `${c.club} ${c.count}`).join(", ") + "."
      : "- No club contributes more than one player to the eleven.",
    facts.captainGap === null
      ? "- There is no runner-up to compare the captain against."
      : `- The captain is ${facts.captainGap.toFixed(1)} clear of the runner-up.`,
  );

  if (context.captain) {
    const c = context.captain;
    lines.push(
      "",
      `Captain: ${c.name}, ${c.ep.toFixed(1)} expected THIS GAMEWEEK ` +
        `(before the armband doubles it), ` +
        `${Math.round(c.pHaul * 100)}% chance of 10+, ` +
        `${Math.round(c.pBlank * 100)}% chance of 2 or fewer.` +
        (c.runnerUp
          ? ` Runner-up ${c.runnerUp} at ${(c.runnerUpEp ?? 0).toFixed(1)}.`
          : ""),
    );
  }

  if (context.transfer) {
    const t = context.transfer;
    lines.push(
      "",
      t.kind === "hold"
        ? "Transfer: hold. No move cleared the points it would cost."
        : `Transfer: ${t.out} out, ${t.in} in. ` +
          `${t.epGain.toFixed(1)} gained ACROSS THE NEXT ${t.horizon} GAMEWEEKS ` +
          `(not added to this gameweek's total), ` +
          `${t.hitCost} points of hits, net ${t.netGain.toFixed(1)}.` +
          // Restated on its own line because it was measurably being dropped:
          // two of three samples described this move by its net gain alone,
          // through a prompt rewrite that fixed everything else.
          (t.hitCost > 0
            ? `\nTHIS MOVE COSTS A ${t.hitCost}-POINT HIT. The brief must say so.`
            : ""),
    );
  }

  if (context.chip) {
    lines.push(
      "",
      `Chip: play ${context.chip.name} this gameweek, worth ` +
        `${context.chip.gain.toFixed(1)} THIS GAMEWEEK` +
        (context.chip.margin !== null
          ? `, ${context.chip.margin.toFixed(1)} better than the next available week.`
          : "."),
    );
  }

  if (context.flagged.length > 0) {
    lines.push(
      "",
      "Flagged players in the squad:",
      ...context.flagged.map((p) => `- ${player(p)}`),
    );
  }

  if (context.record) {
    const r = context.record;
    lines.push(
      "",
      `Engine record ACROSS THE SEASON SO FAR — not this gameweek: ` +
        `${r.scored} decisions scored, ${r.better} better ` +
        `than the alternative, ${r.worse} worse, ${r.net >= 0 ? "+" : ""}${r.net} net points.`,
    );
  }

  if (context.priorSeasonOnly) {
    lines.push(
      "",
      "IMPORTANT: no gameweek has been played yet. Every projection above " +
        "rests entirely on last season — scoring rates, how often each player " +
        "started, and how strong each club was. All of it is real, and none " +
        "of it knows about a summer transfer, a new manager or a lost place: " +
        "a player who was nailed last season is projected as nailed whether " +
        "or not he still is. Say so.",
    );
  }

  lines.push("", "Write the briefing.");
  return lines.join("\n");
}

/**
 * Write a brief without storing it.
 *
 * Split from `generateBrief` so the call can be exercised against a context
 * that has no manager behind it — the preview harness, or a check script —
 * without writing a row for a manager who does not exist.
 */
export async function composeBrief(
  context: BriefContext,
  /** Override for the eval harness, which runs the corpus against candidates. */
  model: string = BRIEF_MODEL,
  /** Also for the harness: why a call failed, which callers here never need. */
  onError?: (reason: string) => void,
): Promise<LlmResult | null> {
  return complete({
    system: SYSTEM,
    prompt: buildPrompt(context),
    model,
    onError,
  });
}

/**
 * Generate and store a brief.
 *
 * Returns null when there is no key, when the call fails, or when the model
 * returns nothing — and every caller must render the numbers regardless. The
 * commentary is the optional half of the screen.
 */
export async function generateBrief(
  entryId: number,
  context: BriefContext,
): Promise<string | null> {
  const result = await composeBrief(context);
  if (result === null) return null;

  if (isDbConfigured()) {
    await getDb()
      .from("briefs")
      .upsert(
        {
          entry_id: entryId,
          gw: context.gw,
          body: result.text,
          model: result.model,
        },
        { onConflict: "entry_id,gw" },
      );
  }

  // Logged after storing, so a logging failure cannot lose a brief already
  // paid for.
  await logUsage(result, "weekly-brief", entryId, context.gw).catch(() => {});

  return result.text;
}

/** The stored brief for a gameweek, if one was ever written. */
export async function getBrief(
  entryId: number,
  gw: number,
): Promise<{ body: string; model: string } | null> {
  if (!isDbConfigured()) return null;

  const { data, error } = await getDb()
    .from("briefs")
    .select("body, model")
    .eq("entry_id", entryId)
    .eq("gw", gw)
    .maybeSingle();

  if (error) return null;
  return data;
}
