import "server-only";

import { PRICE_MOMENTUM_WEIGHTS } from "@/lib/engine/constants";
import {
  momentumSeries,
  type TransferSnapshot,
} from "@/lib/engine/transfer-momentum";
import type { PriceMomentumInput } from "@/lib/engine/price-model";
import type { Db } from "./client";
import { getTotalManagers, getTransferSnapshots } from "./queries";

/**
 * The join between the transfer snapshots table and the price model.
 *
 * `lib/engine/**` stays pure, so nothing in there may read a database. This is
 * the seam: it fetches, reshapes, and hands the engine plain values.
 */

/**
 * How far back to read snapshots.
 *
 * Enough to fill PRICE_MOMENTUM_WEIGHTS with whole gameweeks, plus slack: a
 * gameweek is 7 days, differencing costs one snapshot, and international breaks
 * stretch a gameweek to a fortnight. Generous rather than tight — the read is
 * bounded by player count, not by date range.
 */
export const MOMENTUM_LOOKBACK_DAYS = (PRICE_MOMENTUM_WEIGHTS.length + 1) * 14;

export async function loadPriceMomentumInputs(
  db: Db,
  playerIds: number[],
  now: Date = new Date(),
): Promise<PriceMomentumInput[]> {
  if (playerIds.length === 0) return [];

  const [snapshots, totalManagers] = await Promise.all([
    getTransferSnapshots(db, playerIds, MOMENTUM_LOOKBACK_DAYS, now),
    getTotalManagers(db),
  ]);

  const byPlayer = new Map<number, TransferSnapshot[]>();
  for (const row of snapshots) {
    const list = byPlayer.get(row.player_id) ?? [];
    list.push({
      capturedOn: row.captured_on,
      gw: row.gw,
      transfersIn: row.transfers_in,
      transfersOut: row.transfers_out,
      selectedByPercent: row.selected_by_percent,
    });
    byPlayer.set(row.player_id, list);
  }

  return playerIds.map((playerId) => {
    // Ascending by date, so the last entry is the freshest ownership reading
    // and the one before it is the trend.
    const series = byPlayer.get(playerId) ?? [];
    const latest = series.at(-1);
    const previous = series.at(-2);

    return {
      playerId,
      transfersBalance: momentumSeries(series, PRICE_MOMENTUM_WEIGHTS.length),
      ownershipPercent: latest?.selectedByPercent ?? 0,
      previousOwnershipPercent: previous?.selectedByPercent ?? null,
      // Zero when the row has never been written. The price model treats that
      // as "no scale information" and answers `confidence: "none"` rather than
      // projecting from a made-up denominator.
      totalManagers: totalManagers ?? 0,
    };
  });
}
