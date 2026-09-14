import "server-only";

import type { Db } from "./client";
import { getGameweekPoints } from "./queries";
import { movesOf, type DecisionRow, type Move } from "./decisions";
import { CAPTAIN_MULTIPLIER, CHIP } from "@/lib/rules";

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
  /**
   * What the engine advised, and what that returned. `playerId` is the first
   * player bought; `moves` says how many swaps the points cover, so a label
   * showing one name does not pass for a one-move plan.
   */
  engineChoice: { playerId: number; points: number; moves: number } | null;
  /** What the manager actually did, and what that returned. */
  managerChoice: { playerId: number; points: number; moves: number } | null;
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
    moves: 0,
  };
  const manager = {
    playerId: managerCaptainId,
    points: managerPoints * CAPTAIN_MULTIPLIER,
    moves: 0,
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

/** What the manager did in one gameweek's transfer market. */
export interface ManagerWeek {
  transfers: { inId: number; outId: number }[];
  /** Points paid in hits that gameweek, from the entry history. */
  hitCost: number;
  /** The chip played that gameweek, if any. */
  chip: string | null;
}

/** The same swaps, regardless of the order they were listed in. */
function sameMoves(a: Move[], b: Move[]): boolean {
  if (a.length !== b.length) return false;
  const key = (moves: Move[]) =>
    moves.map((m) => `${m.out}>${m.in}`).sort().join(",");
  return key(a) === key(b);
}

/**
 * Transfer comparison for one gameweek.
 *
 * A transfer is a SWAP, so the thing to compare is the swing each side bought:
 * points gained by the players brought in, less points given up by the players
 * sold, less any hit. Comparing the incoming players alone would flatter
 * whichever side sold the better player, which is exactly backwards; leaving
 * the hit out would flatter whichever side paid one.
 *
 * Both sides are scored on EVERY swap they made. The engine's plan used to be
 * scored on its first swap only — half of a two-move plan against all of the
 * manager's moves.
 *
 * Only the immediate gameweek is scored. A transfer is usually made for several
 * weeks and one week is a thin read on it — stated here rather than corrected,
 * because extending the window means deciding what happens when the player is
 * sold again, and a wrong answer there is worse than a narrow one.
 */
export function compareTransfer(
  decision: DecisionRow,
  manager: ManagerWeek,
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

  // A wildcard or free hit rebuilds the squad without the transfer rules. The
  // engine's advice was made WITHIN those rules, so scoring one move against a
  // free rebuild of fifteen compares two different games. Carried, not scored.
  if (manager.chip === CHIP.wildcard || manager.chip === CHIP.freeHit) {
    return {
      ...base,
      note: `manager played ${manager.chip} — not comparable with a transfer`,
    };
  }

  const swing = (moves: Move[]): number | null => {
    let total = 0;
    for (const move of moves) {
      const gained = pointsFor(move.in);
      const lost = pointsFor(move.out);
      if (gained === null || lost === null) return null;
      total += gained - lost;
    }
    return total;
  };

  const managerMoves = manager.transfers.map((t) => ({
    in: t.inId,
    out: t.outId,
  }));
  const managerRaw = swing(managerMoves);
  const managerSwing =
    managerRaw === null ? null : managerRaw - manager.hitCost;
  const managerChoice = (points: number) => ({
    playerId: managerMoves[0]?.in ?? -1,
    points,
    moves: managerMoves.length,
  });

  if (decision.kind === "hold") {
    // The engine said hold. Holding buys a swing of zero, which is a real
    // position and scoreable against whatever the manager did instead.
    if (managerSwing === null) {
      return { ...base, note: "manager's transfers cannot be scored" };
    }
    return {
      ...base,
      engineChoice: { playerId: -1, points: 0, moves: 0 },
      managerChoice: managerChoice(managerSwing),
      delta: 0 - managerSwing,
      note: managerMoves.length === 0 ? "both held" : "engine held",
    };
  }

  const engineMoves = movesOf(decision);
  if (engineMoves === null) {
    return { ...base, note: "only the first of the engine's moves was recorded" };
  }
  const engineRaw = engineMoves.length > 0 ? swing(engineMoves) : null;
  if (engineRaw === null) {
    return { ...base, note: "engine's move cannot be scored" };
  }
  if (managerSwing === null) {
    return { ...base, note: "manager's transfers cannot be scored" };
  }

  const engineSwing = engineRaw - (decision.hit_cost ?? 0);

  return {
    ...base,
    engineChoice: {
      playerId: engineMoves[0].in,
      points: engineSwing,
      moves: engineMoves.length,
    },
    managerChoice: managerChoice(managerSwing),
    delta: engineSwing - managerSwing,
    note: sameMoves(engineMoves, managerMoves)
      ? "engine and manager agreed"
      : managerMoves.length === 0
        ? "manager held, engine moved"
        : null,
  };
}

export interface ManagerActions {
  /** The captain the manager actually set, by gameweek. */
  captainByGw: Map<number, number>;
  /** The transfers the manager actually made, by gameweek. */
  transfersByGw: Map<number, { inId: number; outId: number }[]>;
  /** Points paid in hits, by gameweek. */
  hitCostByGw: Map<number, number>;
  /** The chip played, by gameweek. */
  chipByGw: Map<number, string>;
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
          {
            transfers: actions.transfersByGw.get(decision.gw) ?? [],
            hitCost: actions.hitCostByGw.get(decision.gw) ?? 0,
            chip: actions.chipByGw.get(decision.gw) ?? null,
          },
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
 * What the manager actually did, from stored squads and the live FPL API.
 *
 * The captain comes from `squads`, which the sync already records per
 * gameweek. Transfers, hits and chips are not stored anywhere — they are read
 * live, because they are only needed after a deadline has passed and the
 * source never changes retrospectively.
 *
 * `history` is required rather than optional. Without it a wildcard week looks
 * like thirteen ordinary transfers and every hit looks free, which is a wrong
 * verdict and not a partial one.
 */
export async function loadManagerActions(
  db: Db,
  entryId: number,
  transfers: { element_in: number; element_out: number; event: number }[],
  history: {
    current: { event: number; event_transfers_cost: number }[];
    chips: { name: string; event: number }[];
  },
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

  const hitCostByGw = new Map(
    history.current.map((row) => [row.event, row.event_transfers_cost]),
  );
  const chipByGw = new Map(history.chips.map((chip) => [chip.event, chip.name]));

  return { captainByGw, transfersByGw, hitCostByGw, chipByGw };
}
