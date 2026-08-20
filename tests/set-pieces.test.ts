import { describe, expect, it } from "vitest";
import {
  NO_SET_PIECE_DUTY,
  penaltyPointsPer90,
  setPieceAssistsPer90,
  setPieceCredit,
  setPiecePointsPer90,
  takerShare,
  type SetPieceDuty,
} from "@/lib/engine/set-pieces";
import {
  expectedPoints,
  type FixtureContext,
  type GameweekSample,
  type PlayerModelInput,
} from "@/lib/engine/expected-points";
import {
  PENALTIES_PER_TEAM_PER_MATCH,
  PENALTY_CONVERSION,
  PENALTY_TAKER_SHARE,
  SET_PIECE_CREDIT_APPEARANCES,
  SET_PIECE_TAKER_SHARE,
} from "@/lib/engine/constants";
import { GOAL_POINTS, PENALTY_MISS_POINTS, POSITION } from "@/lib/rules";

function duty(over: Partial<SetPieceDuty> = {}): SetPieceDuty {
  return { ...NO_SET_PIECE_DUTY, ...over };
}

describe("takerShare", () => {
  it("reads the order as an index, not a probability", () => {
    expect(takerShare(1, PENALTY_TAKER_SHARE)).toBe(PENALTY_TAKER_SHARE[0]);
    expect(takerShare(2, PENALTY_TAKER_SHARE)).toBe(PENALTY_TAKER_SHARE[1]);
  });

  it("gives nothing to an unlisted player", () => {
    expect(takerShare(null, PENALTY_TAKER_SHARE)).toBe(0);
  });

  it("gives nothing beyond the end of the table", () => {
    // Some clubs list five names. A fifth-choice penalty taker is a hypothesis,
    // not a duty, and must not read as undefined and poison the arithmetic.
    expect(takerShare(5, PENALTY_TAKER_SHARE)).toBe(0);
    expect(Number.isFinite(takerShare(5, PENALTY_TAKER_SHARE))).toBe(true);
  });

  it("rejects a zero or negative order rather than wrapping", () => {
    expect(takerShare(0, PENALTY_TAKER_SHARE)).toBe(0);
    expect(takerShare(-1, PENALTY_TAKER_SHARE)).toBe(0);
  });

  it("shares sum to about one across a club, in both tables", () => {
    const sum = (t: readonly number[]) => t.reduce((a, b) => a + b, 0);
    expect(sum(PENALTY_TAKER_SHARE)).toBeCloseTo(1, 1);
    expect(sum(SET_PIECE_TAKER_SHARE)).toBeCloseTo(1, 1);
  });
});

describe("penaltyPointsPer90", () => {
  it("charges the miss as well as crediting the goal", () => {
    const taker = duty({ penaltiesOrder: 1 });
    const value = penaltyPointsPer90(taker, POSITION.MID);

    const expected =
      PENALTIES_PER_TEAM_PER_MATCH *
      PENALTY_TAKER_SHARE[0] *
      (PENALTY_CONVERSION * GOAL_POINTS[POSITION.MID] +
        (1 - PENALTY_CONVERSION) * PENALTY_MISS_POINTS);
    expect(value).toBeCloseTo(expected, 6);

    // Strictly below the naive conversion-times-goal-points figure, because
    // the one-in-five miss costs two points rather than merely paying nothing.
    const naive =
      PENALTIES_PER_TEAM_PER_MATCH *
      PENALTY_TAKER_SHARE[0] *
      PENALTY_CONVERSION *
      GOAL_POINTS[POSITION.MID];
    expect(value).toBeLessThan(naive);
  });

  it("is worth more to a defender than a forward, per penalty", () => {
    // Six points a goal against four. Counter-intuitive but exactly right: the
    // rare penalty-taking defender is a genuine edge.
    const taker = duty({ penaltiesOrder: 1 });
    expect(penaltyPointsPer90(taker, POSITION.DEF)).toBeGreaterThan(
      penaltyPointsPer90(taker, POSITION.FWD),
    );
  });

  it("is zero without a listed duty", () => {
    expect(penaltyPointsPer90(NO_SET_PIECE_DUTY, POSITION.FWD)).toBe(0);
  });

  it("stays within a plausible range for a first-choice taker", () => {
    // A sanity band, not a fitted value: roughly a third to a half a point a
    // match. Anything outside it means a constant has drifted.
    const value = penaltyPointsPer90(duty({ penaltiesOrder: 1 }), POSITION.MID);
    expect(value).toBeGreaterThan(0.25);
    expect(value).toBeLessThan(0.6);
  });
});

describe("setPieceAssistsPer90", () => {
  it("credits the designated deliverer and nobody else", () => {
    expect(setPieceAssistsPer90(duty({ cornersOrder: 1 }))).toBeGreaterThan(0);
    expect(setPieceAssistsPer90(NO_SET_PIECE_DUTY)).toBe(0);
  });

  it("ignores direct free-kick duty, which is stored but not modelled", () => {
    expect(setPieceAssistsPer90(duty({ directFreekicksOrder: 1 }))).toBe(0);
    expect(penaltyPointsPer90(duty({ directFreekicksOrder: 1 }), POSITION.MID)).toBe(0);
  });
});

describe("setPieceCredit — the anti-double-counting term", () => {
  it("gives full credit when there is no history to double count", () => {
    expect(setPieceCredit(0)).toBe(1);
  });

  it("gives none once the form window is full of the player's own penalties", () => {
    expect(setPieceCredit(SET_PIECE_CREDIT_APPEARANCES)).toBe(0);
    expect(setPieceCredit(SET_PIECE_CREDIT_APPEARANCES + 5)).toBe(0);
  });

  it("decays monotonically in between", () => {
    let previous = setPieceCredit(0);
    for (let i = 1; i <= SET_PIECE_CREDIT_APPEARANCES; i++) {
      const current = setPieceCredit(i);
      expect(current).toBeLessThan(previous);
      previous = current;
    }
  });
});

// ---------------------------------------------------------------------------
// Integration with the model
// ---------------------------------------------------------------------------

function fixture(over: Partial<FixtureContext> = {}): FixtureContext {
  return {
    gw: 2,
    isHome: true,
    teamDefence: null,
    opponentAttack: null,
    leagueMeanAttack: null,
    leagueStdAttack: null,
    opponentDefence: null,
    leagueMeanDefence: null,
    leagueStdDefence: null,
    ...over,
  };
}

function sample(over: Partial<GameweekSample> = {}): GameweekSample {
  return {
    minutes: 90,
    started: true,
    expectedGoals: 0.3,
    expectedAssists: 0.2,
    defensiveContribution: 4,
    bonus: 1,
    goalsConceded: 1,
    yellowCards: 0,
    redCards: 0,
    ...over,
  };
}

/**
 * A player with exactly `appearances` gameweeks behind him — a new signing at
 * zero, an established starter at six.
 *
 * Note that zero means *no history*, not six blanks: a player who has sat
 * unused for six gameweeks is projected at zero minutes and therefore zero of
 * everything, which is correct but tests nothing about set pieces.
 */
function player(
  appearances: number,
  over: Partial<PlayerModelInput> = {},
): PlayerModelInput {
  const recent = Array.from({ length: appearances }, () => sample());
  return {
    playerId: 1,
    position: POSITION.MID,
    teamId: 1,
    minutes: {
      status: "a",
      chanceOfPlayingNextRound: null,
      recentStarts: recent.map((s) => s.started),
      recentMinutes: recent.map((s) => s.minutes),
    },
    recent,
    priorSeason: null,
    ...over,
  };
}

describe("expectedPoints with set-piece duty", () => {
  it("ranks a penalty taker above an identical team-mate who is not", () => {
    const taker = expectedPoints(
      player(0, { setPieces: duty({ penaltiesOrder: 1 }) }),
      fixture(),
    );
    const other = expectedPoints(player(0), fixture());

    expect(taker.total).toBeGreaterThan(other.total);
    expect(taker.setPieces).toBeGreaterThan(0);
    expect(other.setPieces).toBe(0);
    // Everything else must be untouched — the duty term is additive, not a
    // multiplier smeared across the model.
    expect(taker.goals).toBeCloseTo(other.goals, 10);
    expect(taker.assists).toBeCloseTo(other.assists, 10);
    expect(taker.appearance).toBeCloseTo(other.appearance, 10);
  });

  it("stops crediting duty once observed xG already contains it", () => {
    // The whole design turns on this. Opta xG includes penalties, so a player
    // with a full form window has already been paid for them through `goals`.
    const veteran = expectedPoints(
      player(6, { setPieces: duty({ penaltiesOrder: 1, cornersOrder: 1 }) }),
      fixture(),
    );
    expect(veteran.setPieces).toBe(0);
  });

  it("credit falls as appearances accumulate, minutes held fixed", () => {
    // Minutes are pinned deliberately. Left free, the term is NOT monotone in
    // appearances: a player with no history is projected on a 0.5 start prior,
    // so his minutes scale is roughly half a nailed starter's, and that swamps
    // the larger credit he receives. Both effects are correct; only one is
    // under test here.
    const nailed = {
      status: "a",
      chanceOfPlayingNextRound: null,
      recentStarts: [true, true, true, true, true, true],
      recentMinutes: [90, 90, 90, 90, 90, 90],
    };
    const at = (n: number) =>
      expectedPoints(
        player(n, { setPieces: duty({ penaltiesOrder: 1 }), minutes: nailed }),
        fixture(),
      ).setPieces;

    expect(at(0)).toBeGreaterThan(at(2));
    expect(at(2)).toBeGreaterThan(at(4));
    expect(at(4)).toBeGreaterThan(0);
    expect(at(6)).toBe(0);
  });

  it("treats absent duty as no duty rather than throwing", () => {
    expect(expectedPoints(player(0), fixture()).setPieces).toBe(0);
    expect(
      expectedPoints(player(0, { setPieces: null }), fixture()).setPieces,
    ).toBe(0);
  });

  it("gives nothing to a taker who is not going to play", () => {
    const injured = player(0, {
      setPieces: duty({ penaltiesOrder: 1 }),
      minutes: {
        status: "i",
        chanceOfPlayingNextRound: 0,
        recentStarts: [true, true, true, true, true, true],
        recentMinutes: [90, 90, 90, 90, 90, 90],
      },
    });
    expect(expectedPoints(injured, fixture()).setPieces).toBe(0);
  });

  it("scales with minutes, so a cameo taker is worth a fraction of a starter", () => {
    // Same duty and the same one appearance of history, so the credit term is
    // identical and only the minutes projection separates them. A nominal
    // penalty taker who comes on for the last twenty minutes takes very few.
    const base = player(1, { setPieces: duty({ penaltiesOrder: 1 }) });
    const starter: PlayerModelInput = {
      ...base,
      minutes: {
        status: "a",
        chanceOfPlayingNextRound: null,
        recentStarts: [true, true, true, true, true, true],
        recentMinutes: [90, 90, 90, 90, 90, 90],
      },
    };
    const substitute: PlayerModelInput = {
      ...base,
      minutes: {
        status: "a",
        chanceOfPlayingNextRound: null,
        recentStarts: [false, false, false, false, false, false],
        recentMinutes: [12, 0, 18, 0, 9, 0],
      },
    };

    const a = expectedPoints(starter, fixture()).setPieces;
    const b = expectedPoints(substitute, fixture()).setPieces;
    expect(b).toBeGreaterThan(0);
    expect(b).toBeLessThan(a / 2);
  });

  it("is included in the reported total", () => {
    const ep = expectedPoints(
      player(0, { setPieces: duty({ penaltiesOrder: 1, cornersOrder: 1 }) }),
      fixture(),
    );
    const parts =
      ep.appearance +
      ep.goals +
      ep.assists +
      ep.cleanSheet +
      ep.setPieces +
      ep.defcon +
      ep.bonus +
      ep.goalsConceded +
      ep.cards;
    expect(ep.total).toBeCloseTo(parts, 10);
  });
});

describe("setPiecePointsPer90", () => {
  it("sums both modelled duties", () => {
    const both = duty({ penaltiesOrder: 1, cornersOrder: 1 });
    expect(setPiecePointsPer90(both, POSITION.MID)).toBeCloseTo(
      penaltyPointsPer90(both, POSITION.MID) +
        setPieceAssistsPer90(both) * 3,
      10,
    );
  });
});
