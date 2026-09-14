import "server-only";

import { getDb, type Db } from "./client";
import { getLatestSquad, getPlayersByIds, type SquadWithPicks } from "./queries";
import { loadDecisionContext } from "./decision-context";
import { getGameweekResults, getShadowWeeks, type ShadowWeek } from "./shadow";
import type { Json } from "./types.generated";
import { getEntryHistory, getEntryTransfers } from "@/lib/fpl/client";
import type { FplEntryTransfer } from "@/lib/fpl/schemas";
import { getSeasonContext } from "@/lib/fpl/season";
import { scoreFinalGameweek } from "@/lib/engine/auto-subs";
import { playedChipSets } from "@/lib/engine/chips";
import { CHIP_SCAN_HORIZON, DEFAULT_HORIZON } from "@/lib/engine/constants";
import {
  freeTransfersFor,
  freeTransfersForStorage,
} from "@/lib/engine/free-transfers";
import {
  baseWeekFor,
  chooseShadowChip,
  planShadowWeek,
  type ShadowPick,
} from "@/lib/shadow/plan";
import { createGlpkSolver } from "@/lib/solver/glpk";
import type { PositionId } from "@/lib/rules";

/**
 * Running the shadow manager.
 *
 * Runs on the journal job, after it, and in the same order for the same
 * reason: score what has finished, then plan what is open. The two are
 * independent, so a failure to plan does not also block scoring.
 *
 * THE RECORDING RULE IS THE JOURNAL'S (CLAUDE.md, invariant 3). A week is
 * written only while its gameweek is open and rewritten every sync until the
 * deadline, so the surviving row is the last plan made before it. A missed sync
 * leaves a gap — that week is simply not compared — rather than a week planned
 * afterwards, which would be the shadow picking its team with the results in.
 */

export interface SyncShadowResult {
  status: "recorded" | "no-squad" | "not-projectable" | "closed";
  gw: number | null;
  /** True on the run that created the starting squad. */
  seeded: boolean;
  scored: number;
}

export async function syncShadow(entryId: number): Promise<SyncShadowResult> {
  const db = getDb();
  const season = await getSeasonContext();
  if (!season.available) {
    throw new Error(`FPL API unavailable: ${season.reason}`);
  }
  let weeks = await getShadowWeeks(db, entryId);
  const scored = await scoreFinishedWeeks(
    db,
    weeks,
    season.gameweek.target.id,
  );

  // `next`, not `target`: target falls back to the current gameweek at the end
  // of the season, whose deadline has passed, and a plan written then would be
  // picked with the football already under way. `next` is null exactly when
  // there is no open gameweek to plan.
  const target = season.gameweek.next;
  if (target === null) {
    return { status: "closed", gw: null, seeded: false, scored };
  }

  const [transfers, history] = await Promise.all([
    getEntryTransfers(entryId),
    getEntryHistory(entryId),
  ]);

  let seeded = false;
  if (weeks.length === 0) {
    const stored = await getLatestSquad(db, entryId, target.id - 1);
    if (!stored) return { status: "no-squad", gw: target.id, seeded, scored };
    await seedShadow(db, entryId, stored, transfers);
    seeded = true;
    weeks = await getShadowWeeks(db, entryId);
  }

  const context = await loadDecisionContext(entryId, DEFAULT_HORIZON);
  const chipContext = await loadDecisionContext(entryId, CHIP_SCAN_HORIZON);
  if (context.state !== "ready" || chipContext.state !== "ready") {
    return { status: "no-squad", gw: target.id, seeded, scored };
  }
  if (!context.projectable) {
    return { status: "not-projectable", gw: target.id, seeded, scored };
  }

  const seed = weeks.find((w) => w.row.origin === "seed");
  const base = baseWeekFor(
    weeks.map((w) => ({ ...w, gw: w.row.gw, chip: w.row.chip_played })),
    target.id,
  );
  if (!seed || !base) {
    throw new Error(`Shadow for entry ${entryId} has no squad to plan GW${target.id} from`);
  }

  // Free transfers and chips: the manager's history up to the seed, which the
  // shadow inherited, then the shadow's own weeks after it.
  const pastEngine = weeks.filter(
    (w) => w.row.origin === "engine" && w.row.gw < target.id,
  );
  const managerChip = new Map(history.chips.map((c) => [c.event, c.name]));

  const freeTransfers = freeTransfersForStorage(
    freeTransfersFor(target.id, [
      ...history.current
        .filter((r) => r.event <= seed.row.gw)
        .map((r) => ({
          event: r.event,
          eventTransfers: r.event_transfers,
          chip: managerChip.get(r.event) ?? null,
        })),
      ...pastEngine.map((w) => ({
        event: w.row.gw,
        eventTransfers: w.moves.length,
        chip: w.row.chip_played,
      })),
    ]),
  );

  const played = playedChipSets(
    [
      ...history.chips
        .filter((c) => c.event <= seed.row.gw)
        .map((c) => ({ gw: c.event, chip: c.name })),
      ...pastEngine.flatMap((w) =>
        w.row.chip_played ? [{ gw: w.row.gw, chip: w.row.chip_played }] : [],
      ),
    ],
    chipContext.chipWindows,
  );

  const holdings = base.picks.map((p) => ({
    playerId: p.playerId,
    purchasePrice: p.purchasePrice,
  }));
  const solver = await createGlpkSolver();

  const chip = chooseShadowChip({
    gw: target.id,
    holdings,
    bank: base.row.bank,
    pool: chipContext.pool,
    gameweeks: chipContext.gameweeks,
    windows: chipContext.chipWindows,
    played,
    priceDeltas: chipContext.priceDeltas,
    solver,
  });

  const plan = planShadowWeek({
    gw: target.id,
    holdings,
    bank: base.row.bank,
    freeTransfers,
    chip,
    pool: context.pool,
    priceDeltas: context.priceDeltas,
    minutesKnown: context.minutesKnown,
    solver,
  });

  const { error } = await db.from("shadow_squads").upsert(
    {
      entry_id: entryId,
      gw: plan.gw,
      origin: "engine",
      chip_played: plan.chip,
      picks: plan.picks as unknown as Json,
      bank: plan.bank,
      free_transfers: freeTransfers,
      moves: plan.moves as unknown as Json,
      hit_cost: plan.hitCost,
      projected_ep: Math.round(plan.projectedEp * 100) / 100,
      // Sent on every write; the default fires on insert only. See
      // decisions.updated_at.
      updated_at: new Date().toISOString(),
    },
    { onConflict: "entry_id,gw" },
  );
  if (error) throw new Error(`Failed to record shadow week: ${error.message}`);

  return { status: "recorded", gw: plan.gw, seeded, scored };
}

/**
 * Create the shadow's starting point: the manager's own latest squad.
 *
 * Both sides own it, so it is recorded as `seed` and never scored — it cannot
 * separate them. Everything after it is the engine's.
 *
 * Purchase prices are reconstructed, because the API shows a manager's selling
 * prices only to that manager: the cost of the latest transfer that brought a
 * player in, or, for someone owned since the first deadline, his gameweek 1
 * price. A player with neither falls back to his current price, which values
 * him at exactly what he would sell for today — the one fallback that invents
 * no profit.
 */
async function seedShadow(
  db: Db,
  entryId: number,
  stored: SquadWithPicks,
  transfers: FplEntryTransfer[],
): Promise<void> {
  const ids = stored.picks.map((p) => p.player_id);

  // The latest transfer in per player. The API lists newest first, so the
  // first entry seen at the highest gameweek wins — which is what makes a
  // player bought, sold and bought back within one wildcard week come out at
  // his final price.
  const latestIn = new Map<number, { event: number; cost: number }>();
  for (const t of transfers) {
    const existing = latestIn.get(t.element_in);
    if (!existing || t.event > existing.event) {
      latestIn.set(t.element_in, { event: t.event, cost: t.element_in_cost });
    }
  }

  const { data: opening, error } = await db
    .from("player_gw_stats")
    .select("player_id, value")
    .eq("gw", 1)
    .in("player_id", ids);
  if (error) throw new Error(`Failed to read opening prices: ${error.message}`);
  const openingPrice = new Map((opening ?? []).map((r) => [r.player_id, r.value]));

  const players = await getPlayersByIds(db, ids);
  const currentPrice = new Map(players.map((p) => [p.id, p.now_cost]));

  const picks: ShadowPick[] = stored.picks.map((pick) => {
    const price =
      latestIn.get(pick.player_id)?.cost ??
      openingPrice.get(pick.player_id) ??
      currentPrice.get(pick.player_id);
    if (price === undefined) {
      throw new Error(`No price at all for seeded player #${pick.player_id}`);
    }
    return {
      playerId: pick.player_id,
      slot: pick.position,
      isCaptain: pick.is_captain,
      isVice: pick.is_vice,
      purchasePrice: price,
    };
  });

  const { error: writeError } = await db.from("shadow_squads").upsert(
    {
      entry_id: entryId,
      gw: stored.squad.gw,
      origin: "seed",
      chip_played: stored.squad.chip_played,
      picks: picks as unknown as Json,
      bank: stored.squad.bank,
      free_transfers: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "entry_id,gw" },
  );
  if (writeError) {
    throw new Error(`Failed to seed shadow squad: ${writeError.message}`);
  }
}

/**
 * Score every past engine week whose results have been checked.
 *
 * A player with no result row in a checked gameweek did not feature, and FPL
 * scores that as zero — so here it is zero, not "unscoreable". (The journal
 * refuses instead, because it compares two CHOICES and a missing row there may
 * be a sync gap; a squad's score has no such ambiguity once the week is
 * checked.)
 */
async function scoreFinishedWeeks(
  db: Db,
  weeks: ShadowWeek[],
  targetGw: number,
): Promise<number> {
  const pending = weeks.filter(
    (w) => w.row.origin === "engine" && w.row.points === null && w.row.gw < targetGw,
  );
  if (pending.length === 0) return 0;

  const players = await getPlayersByIds(db, [
    ...new Set(pending.flatMap((w) => w.picks.map((p) => p.playerId))),
  ]);
  const positionOf = new Map(players.map((p) => [p.id, p.position as PositionId]));

  let scored = 0;
  for (const week of pending) {
    const results = await getGameweekResults(db, week.row.gw);
    if (results.size === 0) continue;

    const score = scoreFinalGameweek(
      week.picks.map((pick) => {
        const result = results.get(pick.playerId);
        const position = positionOf.get(pick.playerId);
        if (position === undefined) {
          throw new Error(`Shadow pick #${pick.playerId} is not in players`);
        }
        return {
          playerId: pick.playerId,
          slot: pick.slot,
          isCaptain: pick.isCaptain,
          isVice: pick.isVice,
          position,
          played: (result?.minutes ?? 0) > 0,
          points: result?.points ?? 0,
        };
      }),
      week.row.chip_played,
    );

    const { error } = await db
      .from("shadow_squads")
      .update({ points: score.total, scored_at: new Date().toISOString() })
      .eq("id", week.row.id);
    if (error) throw new Error(`Failed to score shadow week: ${error.message}`);
    scored += 1;
  }
  return scored;
}
