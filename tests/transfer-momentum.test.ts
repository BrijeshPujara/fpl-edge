import { describe, expect, it } from "vitest";
import {
  momentumSeries,
  netTransferDeltas,
  netTransfersByGameweek,
  type TransferSnapshot,
} from "@/lib/engine/transfer-momentum";

function snap(
  capturedOn: string,
  transfersIn: number,
  transfersOut: number,
  gw: number | null = 5,
): TransferSnapshot {
  return {
    capturedOn,
    gw,
    transfersIn,
    transfersOut,
    selectedByPercent: 10,
  };
}

describe("netTransferDeltas", () => {
  it("differences cumulative counters into per-interval net flow", () => {
    const deltas = netTransferDeltas([
      snap("2026-09-01", 1000, 200),
      snap("2026-09-02", 1500, 300),
      snap("2026-09-03", 1600, 900),
    ]);

    expect(deltas).toHaveLength(2);
    // +500 in, +100 out
    expect(deltas[0]).toMatchObject({ capturedOn: "2026-09-02", net: 400, days: 1 });
    // +100 in, +600 out — net outflow
    expect(deltas[1]).toMatchObject({ capturedOn: "2026-09-03", net: -500, days: 1 });
  });

  it("yields nothing from a single snapshot", () => {
    // You cannot difference one number. Returning an empty series lets the
    // price model report no confidence rather than project from a total.
    expect(netTransferDeltas([snap("2026-09-01", 1000, 200)])).toEqual([]);
    expect(netTransferDeltas([])).toEqual([]);
  });

  it("sorts before differencing, so out-of-order rows do not flip the sign", () => {
    const forwards = netTransferDeltas([
      snap("2026-09-01", 1000, 200),
      snap("2026-09-02", 1500, 300),
    ]);
    const backwards = netTransferDeltas([
      snap("2026-09-02", 1500, 300),
      snap("2026-09-01", 1000, 200),
    ]);
    expect(backwards).toEqual(forwards);
    expect(backwards[0].net).toBe(400);
  });

  it("drops a step where the counter resets rather than reading it as an exodus", () => {
    // Season rollover. Subtracting naively reports 1.2m transfers out overnight
    // and poisons every weighted mean downstream.
    const deltas = netTransferDeltas([
      snap("2027-05-24", 1_200_000, 900_000),
      snap("2027-08-01", 0, 0),
      snap("2027-08-02", 5_000, 1_000),
    ]);

    expect(deltas).toHaveLength(1);
    expect(deltas[0].net).toBe(4_000);
    expect(deltas.every((d) => d.net > -1_000_000)).toBe(true);
  });

  it("drops the step when only one of the two counters goes backwards", () => {
    const deltas = netTransferDeltas([
      snap("2026-09-01", 1000, 500),
      snap("2026-09-02", 1200, 400),
    ]);
    expect(deltas).toEqual([]);
  });

  it("treats a gap as a coarser interval, not as missing data", () => {
    // A missed cron run is the whole reason cumulative counters were chosen
    // over the per-event ones: the flow is still there, just less finely sliced.
    const deltas = netTransferDeltas([
      snap("2026-09-01", 1000, 200),
      snap("2026-09-05", 3000, 400),
    ]);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].net).toBe(1800);
    expect(deltas[0].days).toBe(4);
  });

  it("attributes an interval to the gameweek that was open when it began", () => {
    // Friday's snapshot is taken while GW5 is still open; Saturday's after the
    // deadline, with GW6 next. Most of that interval's transfers were racing
    // the GW5 deadline, so the interval belongs to GW5.
    const deltas = netTransferDeltas([
      snap("2026-09-18", 1000, 200, 5),
      snap("2026-09-19", 1500, 200, 6),
    ]);
    expect(deltas[0].gw).toBe(5);
  });

  it("carries a null gameweek through rather than inventing one", () => {
    const deltas = netTransferDeltas([
      snap("2026-08-01", 0, 0, null),
      snap("2026-08-02", 100, 0, 1),
    ]);
    expect(deltas[0].gw).toBeNull();
  });
});

describe("netTransfersByGameweek", () => {
  it("sums every interval inside a gameweek", () => {
    const byGw = netTransfersByGameweek(
      netTransferDeltas([
        snap("2026-09-14", 1000, 100, 5),
        snap("2026-09-15", 1400, 100, 5),
        snap("2026-09-16", 1600, 100, 5),
      ]),
    );
    expect(byGw.get(5)).toBe(600);
  });

  it("keeps gameweeks apart", () => {
    const byGw = netTransfersByGameweek(
      netTransferDeltas([
        snap("2026-09-14", 1000, 0, 5),
        snap("2026-09-15", 1400, 0, 5),
        snap("2026-09-16", 1500, 0, 6),
        snap("2026-09-17", 1900, 0, 6),
      ]),
    );
    expect(byGw.get(5)).toBe(500);
    expect(byGw.get(6)).toBe(400);
  });

  it("drops unattributed deltas instead of bucketing them under zero", () => {
    // An unattributed transfer is not a gameweek-zero transfer.
    const byGw = netTransfersByGameweek(
      netTransferDeltas([
        snap("2026-08-01", 0, 0, null),
        snap("2026-08-02", 500, 0, null),
        snap("2026-08-03", 900, 0, 1),
      ]),
    );
    expect(byGw.has(0)).toBe(false);
    expect(byGw.size).toBe(0);
  });
});

describe("momentumSeries", () => {
  it("returns most recent gameweek first", () => {
    const series = momentumSeries(
      [
        snap("2026-09-14", 0, 0, 5),
        snap("2026-09-15", 100, 0, 5),
        snap("2026-09-16", 100, 0, 6),
        snap("2026-09-17", 400, 0, 6),
        snap("2026-09-18", 400, 0, 7),
        snap("2026-09-19", 1000, 0, 7),
      ],
      3,
    );
    expect(series).toEqual([600, 300, 100]);
  });

  it("caps at the limit, keeping the newest gameweeks", () => {
    const snaps: TransferSnapshot[] = [];
    for (let gw = 1; gw <= 8; gw++) {
      snaps.push(snap(`2026-09-${String(gw * 2).padStart(2, "0")}`, gw * 1000, 0, gw));
    }
    const series = momentumSeries(snaps, 3);
    expect(series).toHaveLength(3);
    // Deltas are attributed to the EARLIER snapshot's gameweek, so the last
    // gameweek to receive one is 7, not 8.
    expect(series).toEqual([1000, 1000, 1000]);
  });

  it("omits uncovered gameweeks rather than padding them with zero", () => {
    // A zero asserts nobody transferred. Absence says we did not look, and the
    // model's weighted mean renormalises over what it actually has.
    const series = momentumSeries(
      [snap("2026-09-14", 0, 0, 5), snap("2026-09-15", 100, 0, 5)],
      3,
    );
    expect(series).toEqual([100]);
  });

  it("is empty when there is nothing to difference", () => {
    expect(momentumSeries([], 3)).toEqual([]);
    expect(momentumSeries([snap("2026-09-14", 500, 0, 5)], 3)).toEqual([]);
  });
});
