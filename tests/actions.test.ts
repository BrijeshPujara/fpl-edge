import { describe, expect, it } from "vitest";
import { captainAction, rankActions, type ActionInput } from "@/lib/engine/actions";
import { CAPTAIN_MULTIPLIER, CHIP } from "@/lib/rules";

function input(over: Partial<ActionInput> = {}): ActionInput {
  return {
    transfer: null,
    squadThisWeek: [
      { playerId: 1, ep: 6 },
      { playerId: 2, ep: 4 },
      { playerId: 3, ep: 3 },
    ],
    chipThisWeek: null,
    ...over,
  };
}

describe("captainAction", () => {
  it("picks the highest projected player", () => {
    const action = captainAction([
      { playerId: 1, ep: 4 },
      { playerId: 2, ep: 9 },
    ]);
    expect(action?.playerId).toBe(2);
    expect(action?.runnerUpId).toBe(1);
  });

  it("values the choice at the gap to the runner-up, doubled", () => {
    // Not the captain's own projection. Picking the runner-up does not cost
    // you the captain's whole score, it costs you the difference.
    const action = captainAction([
      { playerId: 1, ep: 9 },
      { playerId: 2, ep: 4 },
    ]);
    expect(action?.margin).toBeCloseTo(5 * CAPTAIN_MULTIPLIER, 6);
    expect(action?.impact).toBeCloseTo(10, 6);
  });

  it("values a close call at almost nothing", () => {
    // The single most important behaviour here. Two players at 9.0 and 8.8
    // make the armband the biggest number on the screen and the least
    // important decision on it.
    const action = captainAction([
      { playerId: 1, ep: 9 },
      { playerId: 2, ep: 8.8 },
    ]);
    expect(action?.ep).toBe(9);
    expect(action?.impact).toBeCloseTo(0.4, 6);
  });

  it("handles a squad of one without dividing by nothing", () => {
    const action = captainAction([{ playerId: 1, ep: 7 }]);
    expect(action?.runnerUpId).toBeNull();
    expect(action?.margin).toBe(0);
  });

  it("returns nothing for an empty squad", () => {
    expect(captainAction([])).toBeNull();
  });
});

describe("rankActions", () => {
  it("ranks by what the decision is worth, not by the biggest number", () => {
    // The captain projects at 20 — by far the largest figure in play — but the
    // runner-up is 19.5, so the choice is worth 1.0. The transfer nets 6.
    const actions = rankActions(
      input({
        squadThisWeek: [
          { playerId: 1, ep: 20 },
          { playerId: 2, ep: 19.5 },
        ],
        transfer: {
          transfers: 1, playersIn: [50], playersOut: [3],
          epGain: 6, hitCost: 0, netGain: 6,
        },
      }),
    );
    expect(actions[0].kind).toBe("transfer");
    expect(actions[1].kind).toBe("captain");
  });

  it("puts a genuinely open captaincy first", () => {
    const actions = rankActions(
      input({
        squadThisWeek: [
          { playerId: 1, ep: 12 },
          { playerId: 2, ep: 4 },
        ],
        transfer: {
          transfers: 1, playersIn: [50], playersOut: [3],
          epGain: 6, hitCost: 0, netGain: 6,
        },
      }),
    );
    expect(actions[0].kind).toBe("captain");
  });

  it("does not recommend a transfer that fails to clear its own hit", () => {
    const actions = rankActions(
      input({
        transfer: {
          transfers: 2, playersIn: [50, 51], playersOut: [1, 2],
          epGain: 3, hitCost: 4, netGain: -1,
        },
      }),
    );
    expect(actions.some((a) => a.kind === "transfer")).toBe(false);
  });

  it("does not recommend the roll as a transfer", () => {
    const actions = rankActions(
      input({
        transfer: {
          transfers: 0, playersIn: [], playersOut: [],
          epGain: 0, hitCost: 0, netGain: 0,
        },
      }),
    );
    expect(actions.some((a) => a.kind === "transfer")).toBe(false);
  });

  it("surfaces a chip the planner wants played this week", () => {
    const actions = rankActions(
      input({
        chipThisWeek: { chip: CHIP.benchBoost, set: 1, gain: 14, margin: 3 },
      }),
    );
    const chip = actions.find((a) => a.kind === "chip");
    expect(chip?.impact).toBe(14);
    expect(actions[0].kind).toBe("chip");
  });

  it("ignores a chip worth nothing", () => {
    const actions = rankActions(
      input({
        chipThisWeek: { chip: CHIP.freeHit, set: 1, gain: 0, margin: null },
      }),
    );
    expect(actions.some((a) => a.kind === "chip")).toBe(false);
  });

  it("always returns something", () => {
    // An empty panel reads as a broken computation. Holding is a real answer.
    const actions = rankActions({
      transfer: null,
      squadThisWeek: [],
      chipThisWeek: null,
    });
    expect(actions).toEqual([{ kind: "hold", impact: 0 }]);
  });

  it("orders every action by impact, descending", () => {
    const actions = rankActions(
      input({
        squadThisWeek: [
          { playerId: 1, ep: 10 },
          { playerId: 2, ep: 8 },
        ],
        transfer: {
          transfers: 1, playersIn: [50], playersOut: [3],
          epGain: 9, hitCost: 0, netGain: 9,
        },
        chipThisWeek: { chip: CHIP.tripleCaptain, set: 1, gain: 6, margin: 1 },
      }),
    );
    const impacts = actions.map((a) => a.impact);
    expect([...impacts].sort((a, b) => b - a)).toEqual(impacts);
    expect(actions).toHaveLength(3);
  });
});
