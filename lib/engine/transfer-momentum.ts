/**
 * Turning cumulative transfer counters into the per-gameweek momentum series
 * the price model consumes.
 *
 * Pure. `player_transfer_snapshots` stores season-cumulative `transfers_in` and
 * `transfers_out` sampled once a day; this differences them.
 *
 * Cumulative counters are the right thing to store (see the migration for why)
 * but they are not the right thing to reason with, and the conversion has more
 * edges than it looks:
 *
 *   * a single snapshot yields no delta at all — you need two to subtract
 *   * counters reset to zero between seasons, and a naive subtraction reads
 *     that as several million transfers OUT in one night
 *   * a gap in the series is not missing data, it is a coarser interval, and
 *     stays perfectly usable
 *   * an interval that straddles a deadline contains transfers made for two
 *     different gameweeks, and has to be attributed to one of them
 *
 * Each is handled explicitly below rather than left to arithmetic.
 */

export interface TransferSnapshot {
  /** ISO date, `YYYY-MM-DD`. */
  capturedOn: string;
  /** The gameweek transfers were being made FOR. Null before the season opens. */
  gw: number | null;
  transfersIn: number;
  transfersOut: number;
  selectedByPercent: number;
}

export interface TransferDelta {
  /** The snapshot that closed the interval. */
  capturedOn: string;
  /** The gameweek the interval is attributed to. Null when unattributable. */
  gw: number | null;
  /** Net transfers in over the interval. Negative means net out. */
  net: number;
  /** Days the interval spans. 1 in the normal case, more after a missed run. */
  days: number;
}

const MS_PER_DAY = 86_400_000;

function daysBetween(earlier: string, later: string): number {
  const a = Date.parse(`${earlier}T00:00:00Z`);
  const b = Date.parse(`${later}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 1;
  return Math.max(1, Math.round((b - a) / MS_PER_DAY));
}

/**
 * Difference a snapshot series into per-interval net transfers, oldest first.
 *
 * Attribution rule for an interval that crosses a deadline: it belongs to the
 * gameweek that was OPEN when the interval began, because that is the deadline
 * those transfers were racing. Sampling daily makes the boundary imprecise —
 * some of the transfers in a Friday-to-Saturday interval were made after the
 * 18:30 deadline and count toward the following gameweek — but the majority
 * attribution is the earlier gameweek, and daily resolution cannot do better.
 */
export function netTransferDeltas(
  snapshots: TransferSnapshot[],
): TransferDelta[] {
  // Sort rather than trust the caller: a delta computed on out-of-order rows is
  // silently sign-flipped, which is worse than being slow.
  const ordered = [...snapshots].sort((a, b) =>
    a.capturedOn < b.capturedOn ? -1 : a.capturedOn > b.capturedOn ? 1 : 0,
  );

  const deltas: TransferDelta[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1];
    const current = ordered[i];

    // A cumulative counter that decreases is not a negative delta — it is a
    // counter reset, which happens between seasons. Reading it as arithmetic
    // produces a several-million-transfer outflow overnight and poisons every
    // weighted mean it touches. Drop the step; the next one is valid again.
    if (
      current.transfersIn < previous.transfersIn ||
      current.transfersOut < previous.transfersOut
    ) {
      continue;
    }

    const inDelta = current.transfersIn - previous.transfersIn;
    const outDelta = current.transfersOut - previous.transfersOut;

    deltas.push({
      capturedOn: current.capturedOn,
      gw: previous.gw,
      net: inDelta - outDelta,
      days: daysBetween(previous.capturedOn, current.capturedOn),
    });
  }

  return deltas;
}

/**
 * Collapse deltas into one net figure per gameweek.
 *
 * Deltas that could not be attributed to a gameweek are dropped rather than
 * bucketed under a placeholder — an unattributed transfer is not a GW0 transfer.
 */
export function netTransfersByGameweek(
  deltas: TransferDelta[],
): Map<number, number> {
  const byGw = new Map<number, number>();
  for (const delta of deltas) {
    if (delta.gw === null) continue;
    byGw.set(delta.gw, (byGw.get(delta.gw) ?? 0) + delta.net);
  }
  return byGw;
}

/**
 * The `transfersBalance` series the price model expects: most recent gameweek
 * first, capped at `limit` entries.
 *
 * Gameweeks with no snapshot coverage are absent rather than zero. A zero would
 * assert that nobody transferred that week, which is a claim; absence is the
 * truth, and the model's weighted mean renormalises over what it actually has.
 */
export function momentumSeries(
  snapshots: TransferSnapshot[],
  limit: number,
): number[] {
  const byGw = netTransfersByGameweek(netTransferDeltas(snapshots));
  return [...byGw.entries()]
    .sort((a, b) => b[0] - a[0])
    .slice(0, limit)
    .map(([, net]) => net);
}
