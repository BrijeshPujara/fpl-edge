import "server-only";

import { getDb } from "./client";
import { loadDecisionContext } from "./decision-context";
import { recordDecisions, resolveOutcomes, type RecordedDecision } from "./decisions";
import { getGameweekPoints } from "./queries";
import { getEntryRow } from "./entries";
import { toPlayerCandidate } from "@/lib/squad/candidates";
import { suggestTransfers } from "@/lib/engine/transfers";
import { rankCaptains } from "@/lib/engine/captain";
import { createGlpkSolver } from "@/lib/solver/glpk";
import { DEFAULT_HORIZON } from "@/lib/engine/constants";
import { CAPTAIN_MULTIPLIER } from "@/lib/rules";
import { ep as formatEp } from "@/lib/format";
import { bestXi } from "@/lib/engine/best-xi";
import { generateBrief } from "@/lib/llm/brief";

/**
 * Writing the journal.
 *
 * Runs on the daily sync and does two separable things:
 *
 *   1. Records what the engine advises for the gameweek that is STILL OPEN.
 *      Only ever the open one — a recommendation written after a deadline is
 *      hindsight, and a journal with any of those in it cannot be used to
 *      judge anything.
 *   2. Scores decisions for gameweeks whose results have arrived.
 *
 * Both are idempotent. Recording upserts, so the row that survives to the
 * deadline is the last recommendation made before it; resolving skips anything
 * already scored.
 */

export interface SyncJournalResult {
  status: "recorded" | "no-squad" | "not-projectable";
  gw: number | null;
  recorded: number;
  resolved: number;
  /** False when there is no API key, which is a normal state. */
  brief?: boolean;
}

export async function syncJournal(
  entryId: number,
): Promise<SyncJournalResult> {
  const db = getDb();
  const context = await loadDecisionContext(entryId, DEFAULT_HORIZON);

  if (context.state !== "ready") {
    return {
      status: "no-squad",
      gw: context.state === "no-squad" ? context.gw : null,
      recorded: 0,
      resolved: 0,
    };
  }

  // Score whatever can now be scored, before recording anything new. Older
  // gameweeks are independent of this week's recommendation, and doing them
  // first means a failure to record does not also block resolution.
  const resolved = await resolvePastGameweeks(entryId, context.gw);

  if (!context.projectable) {
    return { status: "not-projectable", gw: context.gw, recorded: 0, resolved };
  }

  const entry = await getEntryRow(db, entryId);
  const solver = await createGlpkSolver();
  const priceOf = (id: number) => context.priceDeltas.get(id) ?? 0;
  const nameOf = new Map(context.pool.map((c) => [c.id, c.name]));

  // The eleven the model expects to start, for the brief's squad list.
  const xi = bestXi(
    context.squad.map((c) => ({
      id: c.id,
      position: c.position,
      ep: c.perGameweek.find((g) => g.gw === context.gw)?.ep ?? 0,
    })),
  );
  const byId = new Map(context.squad.map((c) => [c.id, c]));
  const describe = (p: { id: number }) => {
    const c = byId.get(p.id);
    return {
      name: c?.name ?? `#${p.id}`,
      position: c?.positionShort ?? "",
      club: c?.club ?? "",
      ep: c?.perGameweek.find((g) => g.gw === context.gw)?.ep ?? 0,
      flag: c?.flag?.note,
    };
  };

  const decisions: RecordedDecision[] = [];

  // --- The armband -------------------------------------------------------
  const captains = rankCaptains(
    context.squad.map((candidate) => ({
      playerId: candidate.id,
      input: candidate.modelInput,
      fixtures: candidate.thisGameweek,
    })),
  );

  const [pick, ...rest] = captains;
  if (pick) {
    decisions.push({
      gw: context.gw,
      kind: "captain",
      playerIn: pick.playerId,
      playerOut: null,
      moves: [],
      hitCost: 0,
      predictedEp: pick.ep * CAPTAIN_MULTIPLIER,
      // Every other starter is an alternative that was passed over. Recording
      // them is what makes the outcome scoreable against a real counterfactual
      // rather than against the engine's own optimism.
      alternatives: rest.slice(0, 5).map((c) => ({
        playerId: c.playerId,
        ep: c.ep * CAPTAIN_MULTIPLIER,
        reason: `${Math.round(c.pHaul * 100)}% haul, ${Math.round(c.pBlank * 100)}% blank`,
      })),
      rationale:
        `${nameOf.get(pick.playerId) ?? "Pick"} — ${formatEp(pick.ep)} expected, ` +
        `${Math.round(pick.pHaul * 100)}% chance of a haul.`,
    });
  }

  // --- The transfer ------------------------------------------------------
  const suggestion = suggestTransfers(
    {
      currentSquad: context.squad.map((c) => toPlayerCandidate(c, priceOf(c.id))),
      candidates: context.pool.map((c) => toPlayerCandidate(c, priceOf(c.id))),
      freeTransfers: context.freeTransfers,
      // One value, computed once — see CandidatePool.minutesKnown. This was
      // `basis !== "prior-season"`, which a single played gameweek satisfied.
      minutesKnown: context.minutesKnown,
      bank: context.bank,
    },
    solver,
    { priceWeight: "auto" },
  );

  const move = suggestion.recommended;
  // Recorded so the journal shows what was declined, not only what was
  // advised — otherwise a withheld move looks like a move never found.
  const withheld = suggestion.withheld;
  const alternatives = suggestion.options
    .filter((option) => option !== move)
    .slice(0, 3)
    .flatMap((option) =>
      option.playersIn.map((p) => ({
        playerId: p.id,
        ep: option.netGain,
        reason: `${option.transfers} transfer${option.transfers === 1 ? "" : "s"}, net ${formatEp(option.netGain)}`,
      })),
    );

  if (move.transfers === 0 || move.netGain <= 0) {
    decisions.push({
      gw: context.gw,
      kind: "hold",
      playerIn: null,
      playerOut: null,
      moves: [],
      hitCost: 0,
      predictedEp: 0,
      alternatives,
      rationale: withheld
        ? `Held. ${withheld.transfers} moves scored ${formatEp(withheld.netGain)} ` +
          `after a ${withheld.hitCost}-point hit, but minutes are not yet known ` +
          "and a hit is a certain cost against a difference the model may be " +
          "imagining."
        : "No move cleared the points it would cost. Banking the transfer is " +
          "worth more than one that only pays for itself.",
    });
  } else {
    decisions.push({
      gw: context.gw,
      kind: "transfer",
      playerIn: move.playersIn[0]?.id ?? null,
      playerOut: move.playersOut[0]?.id ?? null,
      // Paired by index, which is arbitrary for a multi-move plan — but every
      // score is a sum over the pairs, so the pairing never changes a number.
      moves: move.playersIn.map((p, i) => ({
        in: p.id,
        out: move.playersOut[i].id,
      })),
      hitCost: move.hitCost,
      predictedEp: move.netGain,
      alternatives,
      rationale:
        `${move.playersOut.map((p) => nameOf.get(p.id) ?? p.id).join(", ")} → ` +
        `${move.playersIn.map((p) => nameOf.get(p.id) ?? p.id).join(", ")}: ` +
        `${formatEp(move.epGain)} over ${DEFAULT_HORIZON} gameweeks` +
        (move.hitCost > 0 ? ` after a ${move.hitCost}-point hit.` : ", free."),
    });
  }

  const recorded = await recordDecisions(db, entryId, decisions);

  // The brief last, and never allowed to fail the job. Every number in it has
  // already been recorded above; the prose is the optional half.
  const brief = await generateBrief(entryId, {
    gw: context.gw,
    teamName: entry?.name ?? `Team ${entryId}`,
    starting: xi.starting.map(describe),
    bench: xi.bench.map(describe),
    captain: pick
      ? {
          name: nameOf.get(pick.playerId) ?? "",
          ep: pick.ep,
          pHaul: pick.pHaul,
          pBlank: pick.pBlank,
          runnerUp: rest[0] ? (nameOf.get(rest[0].playerId) ?? null) : null,
          runnerUpEp: rest[0]?.ep ?? null,
        }
      : null,
    transfer:
      move.transfers === 0 || move.netGain <= 0
        ? {
            kind: "hold", out: null, in: null,
            epGain: 0, hitCost: 0, netGain: 0, horizon: DEFAULT_HORIZON,
          }
        : {
            kind: "transfer",
            // Every player in the plan. Naming the first swap only put a
            // two-move gain beside a one-move description. A single move
            // renders exactly as before, so its recordings stay fresh.
            out: move.playersOut.map((p) => nameOf.get(p.id) ?? `#${p.id}`).join(", "),
            in: move.playersIn.map((p) => nameOf.get(p.id) ?? `#${p.id}`).join(", "),
            epGain: move.epGain,
            hitCost: move.hitCost,
            netGain: move.netGain,
            horizon: DEFAULT_HORIZON,
          },
    chip: null,
    freeTransfers: context.freeTransfers,
    bank: context.bank,
    flagged: context.squad.filter((c) => c.flag !== null).map(describe),
    record: null,
    priorSeasonOnly: context.basis === "prior-season",
  }).catch(() => null);

  return {
    status: "recorded",
    gw: context.gw,
    recorded,
    resolved,
    brief: brief !== null,
  };
}

/**
 * Score every gameweek before the current one that has results and no outcome.
 *
 * Bounded to a handful of recent gameweeks: anything older is either already
 * scored or was never recorded, and walking the whole season every night to
 * discover that would be a query per gameweek for nothing.
 */
async function resolvePastGameweeks(
  entryId: number,
  currentGw: number,
): Promise<number> {
  const db = getDb();
  let resolved = 0;

  for (let gw = Math.max(1, currentGw - 4); gw < currentGw; gw++) {
    const points = await getGameweekPoints(db, gw);
    if (points.size === 0) continue;

    resolved += await resolveOutcomes(db, entryId, gw, (playerId) =>
      points.get(playerId) ?? null,
    );
  }
  return resolved;
}
