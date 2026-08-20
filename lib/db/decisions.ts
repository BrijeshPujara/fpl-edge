import "server-only";

import type { Db } from "./client";
import type { Tables, TablesInsert } from "./types.generated";

/**
 * The decision journal.
 *
 * PLAN.md calls this the differentiator, and it is: every tool gives advice,
 * and this is the one that has to live with it. A recommendation nobody scores
 * is an opinion.
 *
 * Two halves, and the separation between them is the whole design.
 *
 * RECORDING happens only for the gameweek that is still open. That is not a
 * convenience — it is what makes the journal honest. A recommendation written
 * after a deadline has passed is hindsight wearing a timestamp, and a journal
 * containing any of those cannot be used to judge anything.
 *
 * RESOLVING happens only once the gameweek's results are in the database, and
 * scores what was advised against what the best alternative would have
 * returned. Not against the theoretical maximum: the question is whether the
 * engine picked well from what it offered, not whether it was clairvoyant.
 */

export type DecisionRow = Tables<"decisions">;
export type OutcomeRow = Tables<"outcomes">;

export interface DecisionAlternative {
  playerId: number;
  ep: number;
  reason: string;
}

export interface RecordedDecision {
  gw: number;
  kind: "transfer" | "captain" | "chip" | "hold";
  playerIn: number | null;
  playerOut: number | null;
  predictedEp: number | null;
  alternatives: DecisionAlternative[];
  rationale: string;
}

/**
 * Write this gameweek's recommendations.
 *
 * Upserts on (entry, gameweek, kind), so running daily rewrites rather than
 * appends and the surviving row is the last recommendation made before the
 * deadline. Callers must only ever pass the OPEN gameweek — see above.
 */
export async function recordDecisions(
  db: Db,
  entryId: number,
  decisions: RecordedDecision[],
): Promise<number> {
  if (decisions.length === 0) return 0;

  const rows: TablesInsert<"decisions">[] = decisions.map((decision) => ({
    entry_id: entryId,
    gw: decision.gw,
    kind: decision.kind,
    player_in: decision.playerIn,
    player_out: decision.playerOut,
    predicted_ep: decision.predictedEp,
    alternatives: decision.alternatives as unknown as TablesInsert<"decisions">["alternatives"],
    rationale: decision.rationale,
    source: "engine",
  }));

  const { error } = await db
    .from("decisions")
    .upsert(rows, { onConflict: "entry_id,gw,kind" });

  if (error) throw new Error(`Failed to record decisions: ${error.message}`);
  return rows.length;
}

export interface JournalEntry {
  decision: DecisionRow;
  outcome: OutcomeRow | null;
}

/** The journal, newest gameweek first. */
export async function getJournal(
  db: Db,
  entryId: number,
): Promise<JournalEntry[]> {
  const { data, error } = await db
    .from("decisions")
    .select("*, outcomes (*)")
    .eq("entry_id", entryId)
    .order("gw", { ascending: false })
    .order("kind", { ascending: true });

  if (error) throw new Error(`Failed to read journal: ${error.message}`);

  return (data ?? []).map((row) => {
    const { outcomes, ...decision } = row as DecisionRow & {
      outcomes: OutcomeRow | OutcomeRow[] | null;
    };
    return {
      decision,
      // PostgREST returns an embedded one-to-one as an object or a single-item
      // array depending on how it infers the relationship. Normalise both.
      outcome: Array.isArray(outcomes) ? (outcomes[0] ?? null) : outcomes,
    };
  });
}

/**
 * Score every unresolved decision for a gameweek whose results have landed.
 *
 * `actualPointsFor` is passed in rather than queried here so the scoring stays
 * testable without a database, and so the caller decides what "actual points"
 * means for a double gameweek — the sum of both fixtures.
 */
export async function resolveOutcomes(
  db: Db,
  entryId: number,
  gw: number,
  actualPointsFor: (playerId: number) => number | null,
): Promise<number> {
  const { data, error } = await db
    .from("decisions")
    .select("*, outcomes (decision_id)")
    .eq("entry_id", entryId)
    .eq("gw", gw);

  if (error) throw new Error(`Failed to read decisions: ${error.message}`);

  const rows: TablesInsert<"outcomes">[] = [];

  for (const row of data ?? []) {
    const decision = row as DecisionRow & {
      outcomes: { decision_id: string } | { decision_id: string }[] | null;
    };
    const existing = Array.isArray(decision.outcomes)
      ? decision.outcomes.length > 0
      : decision.outcomes !== null;
    if (existing) continue;

    const scored = scoreDecision(decision, actualPointsFor);
    if (scored === null) continue;
    rows.push({ decision_id: decision.id, ...scored });
  }

  if (rows.length === 0) return 0;

  const { error: writeError } = await db
    .from("outcomes")
    .upsert(rows, { onConflict: "decision_id" });

  if (writeError) {
    throw new Error(`Failed to write outcomes: ${writeError.message}`);
  }
  return rows.length;
}

/**
 * What a decision was worth, against the best alternative it was chosen over.
 *
 * Returns null when the gameweek cannot score it — a player with no recorded
 * stats did not feature in the data, and guessing zero would credit the engine
 * for avoiding someone who may simply be missing from the sync.
 */
export function scoreDecision(
  decision: Pick<DecisionRow, "kind" | "player_in" | "player_out" | "alternatives">,
  actualPointsFor: (playerId: number) => number | null,
): { actual_points: number; best_alternative_points: number; delta: number } | null {
  const alternatives = (decision.alternatives ??
    []) as unknown as DecisionAlternative[];

  const chosen =
    decision.kind === "transfer" ? decision.player_in : decision.player_in;
  if (chosen === null) return null;

  const actual = actualPointsFor(chosen);
  if (actual === null) return null;

  // The best alternative that actually has a score. An alternative with no
  // data is dropped rather than treated as zero.
  const alternativeScores = alternatives
    .map((alternative) => actualPointsFor(alternative.playerId))
    .filter((points): points is number => points !== null);

  // Against a transfer, the player sold is itself the alternative — keeping him
  // was the option not taken.
  if (decision.kind === "transfer" && decision.player_out !== null) {
    const sold = actualPointsFor(decision.player_out);
    if (sold !== null) alternativeScores.push(sold);
  }

  const best =
    alternativeScores.length > 0 ? Math.max(...alternativeScores) : actual;

  return {
    actual_points: actual,
    best_alternative_points: best,
    delta: actual - best,
  };
}
