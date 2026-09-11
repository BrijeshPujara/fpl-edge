import "server-only";

import type { Db } from "./client";
import { getGameweekPoints } from "./queries";
import type { DecisionRow } from "./decisions";
import { CAPTAIN_MULTIPLIER } from "@/lib/rules";

/**
 * Did the engine beat the manager?
 *
 * The only question that answers "am I getting anything out of this", and the
 * one the journal could not previously ask. `outcomes` scores a decision
 * against `max(alternatives)` — the best option in hindsight — which is a
 * regret measure. Regret against an oracle is negative almost by construction:
 * take the maximum of five realised outcomes and a perfect model still loses
 * most weeks. Reading a season of negative deltas as "the engine is bad" was
 * reading the metric, not the engine.
 *
 * The comparison that matters is against the COUNTERFACTUAL THAT ACTUALLY
 * EXISTED: what the manager did instead. That number can go either way, it is
 * knowable from data already stored, and over a season it is the whole case
 * for or against running any of this.
 *
 * Derived rather than stored. Both inputs — what was advised, what was picked —
 * are already recorded facts, so recomputing is deterministic, and a stored
 * copy would be a third thing to keep in step with them.
 */

export interface GameweekComparison {
  gw: number;
  kind: "captain" | "transfer";
  /** What the engine advised, and what that returned. */
  engineChoice: { playerId: number; points: number } | null;
  /** What the manager actually did, and what that returned. */
  managerChoice: { playerId: number; points: number } | null;
  /** Engine minus manager. Positive means following the advice would have paid. */
  delta: number | null;
  /**
   * Why a comparison could not be made, when it could not. Carried rather than
   * dropped: "the engine had nothing to say" and "the engine agreed with you"
   * are very different weeks, and a row that simply vanishes hides both.
   */
  note: string | null;
}

export interface JournalVerdict {
  comparisons: GameweekComparison[];
  /** Gameweeks where both sides had a scoreable choice. */
  scored: number;
  /** Gameweeks where the engine and the manager chose the same thing. */
  agreed: number;
  /** Summed engine-minus-manager over scored gameweeks. */
  net: number;
  /**
   * Standard error of the mean delta, for reading `net` honestly.
   *
   * A handful of gameweeks cannot separate a real edge from a run of luck, and
   * the per-gameweek spread here is large — a single captain call swings ten
   * points. Reported so the number is never quoted without it.
   */
  standardError: number | null;
}

/**
 * Captain comparison for one gameweek.
 *
 * The captain is the cleanest test in the journal: it is decided every single
 * week, it is always recorded on both sides, and it needs no assumption about
 * what a squad would have looked like after a different transfer. Doubling is
 * applied to both, so the delta is in real points rather than half of them.
 */
export function compareCaptain(
  decision: DecisionRow,
  managerCaptainId: number | null,
  pointsFor: (playerId: number) => number | null,
): GameweekComparison {
  const base: GameweekComparison = {
    gw: decision.gw,
    kind: "captain",
    engineChoice: null,
    managerChoice: null,
    delta: null,
    note: null,
  };

  if (decision.player_in === null) {
    return { ...base, note: "engine recorded no captain" };
  }
  if (managerCaptainId === null) {
    return { ...base, note: "no squad synced for this gameweek" };
  }

  const enginePoints = pointsFor(decision.player_in);
  const managerPoints = pointsFor(managerCaptainId);

  // A player with no row did not feature in the data we hold. Scoring him as
  // zero would credit whichever side avoided someone who may simply be missing.
  if (enginePoints === null || managerPoints === null) {
    return { ...base, note: "a chosen player has no result row" };
  }

  const engine = {
    playerId: decision.player_in,
    points: enginePoints * CAPTAIN_MULTIPLIER,
  };
  const manager = {
    playerId: managerCaptainId,
    points: managerPoints * CAPTAIN_MULTIPLIER,
  };

  return {
    ...base,
    engineChoice: engine,
    managerChoice: manager,
    delta: engine.points - manager.points,
    note:
      decision.player_in === managerCaptainId
        ? "engine and manager agreed"
        : null,
  };
}

/**
 * Transfer comparison for one gameweek.
 *
 * A transfer is a SWAP, so the thing to compare is the swing each side bought:
 * points gained by the player brought in, less points given up by the player
 * sold. Comparing the incoming players alone would flatter whichever side sold
 * the better player, which is exactly backwards.
 *
 * Only the immediate gameweek is scored. A transfer is usually made for several
 * weeks and one week is a thin read on it — stated here rather than corrected,
 * because extending the window means deciding what happens when the player is
 * sold again, and a wrong answer there is worse than a narrow one.
 */
export function compareTransfer(
  decision: DecisionRow,
  managerTransfers: { inId: number; outId: number }[],
  pointsFor: (playerId: number) => number | null,
): GameweekComparison {
  const base: GameweekComparison = {
    gw: decision.gw,
    kind: "transfer",
    engineChoice: null,
    managerChoice: null,
    delta: null,
    note: null,
  };

  const swing = (inId: number, outId: number): number | null => {
    const gained = pointsFor(inId);
    const lost = pointsFor(outId);
    if (gained === null || lost === null) return null;
    return gained - lost;
  };

  const engineSwing =
    decision.player_in !== null && decision.player_out !== null
      ? swing(decision.player_in, decision.player_out)
      : null;

  // The manager may have made several moves, or none. Their combined swing is
  // what the engine's single recommendation is up against.
  let managerSwing: number | null = managerTransfers.length === 0 ? 0 : null;
  if (managerTransfers.length > 0) {
    let total = 0;
    let complete = true;
    for (const move of managerTransfers) {
      const s = swing(move.inId, move.outId);
      if (s === null) { complete = false; break; }
      total += s;
    }
    managerSwing = complete ? total : null;
  }

  if (engineSwing === null && decision.kind === "hold") {
    // The engine said hold. Holding buys a swing of zero, which is a real
    // position and scoreable against whatever the manager did instead.
    if (managerSwing === null) {
      return { ...base, note: "manager's transfers cannot be scored" };
    }
    return {
      ...base,
      engineChoice: { playerId: -1, points: 0 },
      managerChoice: { playerId: -1, points: managerSwing },
      delta: 0 - managerSwing,
      note: managerTransfers.length === 0 ? "both held" : "engine held",
    };
  }

  if (engineSwing === null) {
    return { ...base, note: "engine's move cannot be scored" };
  }
  if (managerSwing === null) {
    return { ...base, note: "manager's transfers cannot be scored" };
  }

  const agreed =
    managerTransfers.length === 1 &&
    managerTransfers[0].inId === decision.player_in &&
    managerTransfers[0].outId === decision.player_out;

  return {
    ...base,
    engineChoice: { playerId: decision.player_in!, points: engineSwing },
    managerChoice: {
      playerId: managerTransfers[0]?.inId ?? -1,
      points: managerSwing,
    },
    delta: engineSwing - managerSwing,
    note: agreed
      ? "engine and manager agreed"
      : managerTransfers.length === 0
        ? "manager held, engine moved"
        : null,
  };
}

export interface ManagerActions {
  /** The captain the manager actually set, by gameweek. */
  captainByGw: Map<number, number>;
  /** The transfers the manager actually made, by gameweek. */
  transfersByGw: Map<number, { inId: number; outId: number }[]>;
}

/**
 * Score every recorded decision against what the manager did instead.
 *
 * `actions` is passed in rather than fetched so this stays pure over its
 * inputs and testable without a database — the same reason `resolveOutcomes`
 * takes its points lookup as a function.
 */
export async function compareJournal(
  db: Db,
  entryId: number,
  actions: ManagerActions,
): Promise<JournalVerdict> {
  const { data, error } = await db
    .from("decisions")
    .select("*")
    .eq("entry_id", entryId)
    .order("gw", { ascending: true });

  if (error) throw new Error(`Failed to read decisions: ${error.message}`);

  const decisions = (data ?? []) as DecisionRow[];
  const gameweeks = [...new Set(decisions.map((d) => d.gw))].sort((a, b) => a - b);

  const pointsByGw = new Map<number, Map<number, number>>();
  for (const gw of gameweeks) {
    const points = await getGameweekPoints(db, gw);
    if (points.size > 0) pointsByGw.set(gw, points);
  }

  const comparisons: GameweekComparison[] = [];

  for (const decision of decisions) {
    const points = pointsByGw.get(decision.gw);
    if (!points) {
      comparisons.push({
        gw: decision.gw,
        kind: decision.kind === "captain" ? "captain" : "transfer",
        engineChoice: null,
        managerChoice: null,
        delta: null,
        note: "no results yet",
      });
      continue;
    }
    const pointsFor = (id: number) => points.get(id) ?? null;

    if (decision.kind === "captain") {
      comparisons.push(
        compareCaptain(
          decision,
          actions.captainByGw.get(decision.gw) ?? null,
          pointsFor,
        ),
      );
    } else if (decision.kind === "transfer" || decision.kind === "hold") {
      comparisons.push(
        compareTransfer(
          decision,
          actions.transfersByGw.get(decision.gw) ?? [],
          pointsFor,
        ),
      );
    }
  }

  const scoredRows = comparisons.filter((c) => c.delta !== null);
  const deltas = scoredRows.map((c) => c.delta as number);
  const net = deltas.reduce((a, b) => a + b, 0);

  let standardError: number | null = null;
  if (deltas.length > 1) {
    const mean = net / deltas.length;
    const variance =
      deltas.reduce((s, d) => s + (d - mean) ** 2, 0) / (deltas.length - 1);
    standardError = Math.sqrt(variance / deltas.length);
  }

  return {
    comparisons,
    scored: scoredRows.length,
    agreed: comparisons.filter((c) => c.note === "engine and manager agreed")
      .length,
    net,
    standardError,
  };
}

/**
 * What the manager actually did, from stored squads and the live transfer log.
 *
 * The captain comes from `squads`, which the sync already records per
 * gameweek. Transfers are not stored anywhere — they are read live, because
 * they are only needed after a deadline has passed and the source never
 * changes retrospectively.
 */
export async function loadManagerActions(
  db: Db,
  entryId: number,
  transfers: { element_in: number; element_out: number; event: number }[],
): Promise<ManagerActions> {
  const { data, error } = await db
    .from("squads")
    .select("gw, captain_id")
    .eq("entry_id", entryId);

  if (error) throw new Error(`Failed to read squads: ${error.message}`);

  const captainByGw = new Map<number, number>();
  for (const row of data ?? []) {
    if (row.captain_id !== null) captainByGw.set(row.gw, row.captain_id);
  }

  const transfersByGw = new Map<number, { inId: number; outId: number }[]>();
  for (const t of transfers) {
    const list = transfersByGw.get(t.event) ?? [];
    list.push({ inId: t.element_in, outId: t.element_out });
    transfersByGw.set(t.event, list);
  }

  return { captainByGw, transfersByGw };
}
