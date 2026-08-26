import { describe, expect, it } from "vitest";
import { MINUTES_KNOWN_GAMEWEEKS } from "@/lib/engine/constants";
import {
  buildCandidatePool,
  toPlayerCandidate,
} from "@/lib/squad/candidates";
import { fixtureContextsFor, leagueRatings } from "@/lib/squad/projection";
import type {
  FixtureLike,
  PlayerLike,
  StatLike,
  TeamLike,
} from "@/lib/squad/view";
import { POSITION } from "@/lib/rules";

const teams: TeamLike[] = [
  {
    id: 1, short_name: "ARS",
    strength_attack_home: 1300, strength_attack_away: 1280,
    strength_defence_home: 1250, strength_defence_away: 1230,
  },
  {
    id: 2, short_name: "BUR",
    strength_attack_home: 1050, strength_attack_away: 1020,
    strength_defence_home: 1080, strength_defence_away: 1060,
  },
];

function player(over: Partial<PlayerLike> = {}): PlayerLike {
  return {
    id: 1, code: 1001, web_name: "Saka", team_id: 1, position: POSITION.MID,
    now_cost: 95, status: "a", chance_of_playing_next_round: null, news: "",
    ...over,
  };
}

function fixture(gw: number, home: number, away: number): FixtureLike {
  return {
    gw, home_team: home, away_team: away,
    home_difficulty: 3, away_difficulty: 3,
  };
}

function stat(playerId: number, gw: number, over: Partial<StatLike> = {}): StatLike {
  return {
    player_id: playerId, gw, minutes: 90, starts: 1, goals: 0, assists: 0,
    expected_goals: 0.4, expected_assists: 0.2, defensive_contribution: 3,
    bonus: 1, goals_conceded: 1, yellow_cards: 0, red_cards: 0,
    ...over,
  };
}

describe("buildCandidatePool", () => {
  const fixtures = [fixture(5, 1, 2), fixture(6, 2, 1), fixture(7, 1, 2)];
  const base = { gw: 5, horizon: 3, teams, fixtures };

  it("reports that nothing is projectable with no history", () => {
    // The honesty gate both screens hang on.
    const pool = buildCandidatePool({ ...base, players: [player()], stats: [] });
    expect(pool.projectable).toBe(false);
  });

  it("reports projectable once a gameweek has been played", () => {
    const pool = buildCandidatePool({
      ...base, players: [player()], stats: [stat(1, 4)],
    });
    expect(pool.projectable).toBe(true);
  });

  it("projects the requested gameweeks and no others", () => {
    const pool = buildCandidatePool({
      ...base, players: [player()], stats: [stat(1, 4)],
    });
    expect(pool.gameweeks).toEqual([5, 6, 7]);
    expect(pool.candidates[0].perGameweek.map((g) => g.gw)).toEqual([5, 6, 7]);
  });

  it("counts both fixtures of a double gameweek", () => {
    const pool = buildCandidatePool({
      ...base,
      fixtures: [...fixtures, fixture(6, 1, 2)],
      players: [player()],
      stats: [stat(1, 4)],
    });
    const gw6 = pool.candidates[0].perGameweek.find((g) => g.gw === 6);
    expect(gw6?.fixtures).toBe(2);
  });

  it("gives a blank gameweek no fixtures and no points", () => {
    const pool = buildCandidatePool({
      ...base,
      // Nothing in gameweek 6 for anyone.
      fixtures: [fixture(5, 1, 2), fixture(7, 1, 2)],
      players: [player()],
      stats: [stat(1, 4)],
    });
    const gw6 = pool.candidates[0].perGameweek.find((g) => g.gw === 6);
    expect(gw6?.fixtures).toBe(0);
    expect(gw6?.ep).toBe(0);
  });

  it("gives an unavailable player no expected points at all", () => {
    const pool = buildCandidatePool({
      ...base,
      // Zero chance, as the API reports for every injured player in practice.
      players: [
        player({
          status: "i",
          chance_of_playing_next_round: 0,
          news: "Knee injury",
        }),
      ],
      stats: [stat(1, 4)],
    });
    const [c] = pool.candidates;
    expect(c.unavailable).toBe(true);
    expect(c.pMinutes).toBe(0);
    expect(c.ep).toBe(0);
    expect(c.flag?.note).toBe("Knee injury");
  });

  it("keeps a doubtful player in contention rather than zeroing him", () => {
    // FPL rates doubtful players at 25 to 75. A 75% player is a real option,
    // and treating him as certainly absent is how a model talks you into
    // selling someone who then starts.
    const pool = buildCandidatePool({
      ...base,
      players: [
        player({
          status: "d",
          chance_of_playing_next_round: 75,
          news: "Knock - 75% chance of playing",
        }),
      ],
      stats: [stat(1, 4)],
    });
    const [c] = pool.candidates;
    expect(c.unavailable).toBe(true);
    expect(c.pMinutes).toBeGreaterThan(0);
    expect(c.ep).toBeGreaterThan(0);
  });

  it("leaves an available player unflagged", () => {
    const pool = buildCandidatePool({
      ...base, players: [player()], stats: [stat(1, 4)],
    });
    expect(pool.candidates[0].flag).toBeNull();
    expect(pool.candidates[0].unavailable).toBe(false);
  });

  it("carries club and position through for rendering", () => {
    const pool = buildCandidatePool({
      ...base, players: [player()], stats: [stat(1, 4)],
    });
    expect(pool.candidates[0].club).toBe("ARS");
    expect(pool.candidates[0].positionShort).toBe("MID");
  });

  it("keeps the whole pool, including players nobody would buy", () => {
    // Filtering the unavailable out here would remove them from "who could I
    // buy" while they still have to appear in "who do I own".
    const pool = buildCandidatePool({
      ...base,
      players: [player(), player({ id: 2, status: "u", web_name: "Gone" })],
      stats: [stat(1, 4)],
    });
    expect(pool.candidates).toHaveLength(2);
  });

  it("discounts the horizon total but not the per-gameweek figures", () => {
    // A chip is played in one specific week, so its gain must not be discounted
    // for being far away; a squad has to survive the whole horizon, so its
    // total is. The two numbers answer different questions.
    const pool = buildCandidatePool({
      ...base, players: [player()], stats: [stat(1, 4)],
    });
    const [c] = pool.candidates;
    const undiscounted = c.perGameweek.reduce((sum, g) => sum + g.ep, 0);
    expect(c.ep).toBeLessThan(undiscounted);
    expect(c.ep).toBeGreaterThan(0);
  });
});

describe("toPlayerCandidate", () => {
  it("carries price movement through when given", () => {
    const pool = buildCandidatePool({
      gw: 5, horizon: 1, teams, fixtures: [fixture(5, 1, 2)],
      players: [player()], stats: [stat(1, 4)],
    });
    const candidate = toPlayerCandidate(pool.candidates[0], -0.8);
    expect(candidate.expectedPriceDelta).toBe(-0.8);
    expect(candidate.id).toBe(1);
    expect(candidate.price).toBe(95);
  });
});

describe("fixtureContextsFor", () => {
  const ratings = leagueRatings(teams);

  it("returns one context per fixture, not per gameweek", () => {
    const contexts = fixtureContextsFor(
      1,
      [fixture(5, 1, 2), fixture(5, 2, 1), fixture(6, 1, 2)],
      new Map(teams.map((t) => [t.id, t])),
      ratings,
      [5, 6],
    );
    expect(contexts).toHaveLength(3);
    expect(contexts.filter((c) => c.gw === 5)).toHaveLength(2);
  });

  it("gets home and away the right way round", () => {
    const contexts = fixtureContextsFor(
      1,
      [fixture(5, 1, 2), fixture(6, 2, 1)],
      new Map(teams.map((t) => [t.id, t])),
      ratings,
      [5, 6],
    );
    expect(contexts[0].isHome).toBe(true);
    expect(contexts[1].isHome).toBe(false);
  });

  it("ignores gameweeks that were not asked for", () => {
    const contexts = fixtureContextsFor(
      1,
      [fixture(5, 1, 2), fixture(9, 1, 2)],
      new Map(teams.map((t) => [t.id, t])),
      ratings,
      [5],
    );
    expect(contexts).toHaveLength(1);
  });

  it("skips fixtures with no gameweek assigned", () => {
    const contexts = fixtureContextsFor(
      1,
      [{ gw: null, home_team: 1, away_team: 2, home_difficulty: 3, away_difficulty: 3 }],
      new Map(teams.map((t) => [t.id, t])),
      ratings,
      [5],
    );
    expect(contexts).toEqual([]);
  });
});

describe("leagueRatings", () => {
  it("summarises real ratings", () => {
    const r = leagueRatings(teams);
    expect(r.attack?.mean).toBeGreaterThan(0);
    expect(r.defence?.std).toBeGreaterThan(0);
  });

  it("is null pre-season, when every rating reads zero", () => {
    // Not a fallback — "no information" is the correct answer, and the model
    // turns the opponent adjustment off rather than dividing by zero.
    const preSeason = teams.map((t) => ({
      ...t,
      strength_attack_home: 0, strength_attack_away: 0,
      strength_defence_home: 0, strength_defence_away: 0,
    }));
    expect(leagueRatings(preSeason).attack).toBeNull();
    expect(leagueRatings(preSeason).defence).toBeNull();
  });
});

describe("the projectable gate", () => {
  const fixtures = [fixture(5, 1, 2)];
  const base = { gw: 5, horizon: 1, teams, fixtures, players: [player()] };

  const priors = new Map([
    [1001, { xGper90: 0.5, xAper90: 0.3, bonusPerAppearance: 0.7, defconHitRate: 0 }],
  ]);

  it("refuses to rank with neither a gameweek nor a prior season", () => {
    const pool = buildCandidatePool({ ...base, stats: [] });
    expect(pool.projectable).toBe(false);
    expect(pool.basis).toBe("none");
  });

  it("ranks on a prior season before a ball is kicked", () => {
    // This used to be false. With prior-season rates loaded the model
    // genuinely separates players, and refusing to rank would be the
    // dishonest answer rather than the careful one.
    const pool = buildCandidatePool({
      ...base,
      stats: [],
      priorSeasons: priors,
    });
    expect(pool.projectable).toBe(true);
    expect(pool.basis).toBe("prior-season");
  });

  it("prefers this season once one exists", () => {
    const pool = buildCandidatePool({
      ...base,
      stats: [stat(1, 4)],
      priorSeasons: priors,
    });
    expect(pool.basis).toBe("this-season");
  });

  it("a prior season actually changes the projection", () => {
    const without = buildCandidatePool({ ...base, stats: [] });
    const withPrior = buildCandidatePool({
      ...base,
      stats: [],
      priorSeasons: priors,
    });
    expect(withPrior.candidates[0].ep).toBeGreaterThan(
      without.candidates[0].ep,
    );
  });

  it("ignores a prior belonging to a different player", () => {
    // Keyed on code, and the fixture's code is 1001 — 1 is its id. A lookup
    // that confused the two would silently attach a stranger's rates.
    const wrongKey = new Map([
      [1, { xGper90: 9, xAper90: 9, bonusPerAppearance: 9, defconHitRate: 0 }],
    ]);
    const pool = buildCandidatePool({
      ...base,
      stats: [],
      priorSeasons: wrongKey,
    });
    expect(pool.basis).toBe("prior-season");
    // Present in the map, but not for this player, so nothing is applied.
    const plain = buildCandidatePool({ ...base, stats: [] });
    expect(pool.candidates[0].ep).toBeCloseTo(plain.candidates[0].ep, 10);
  });
});

describe("minutesKnown", () => {
  /**
   * The gate on spending points.
   *
   * It used to be `basis !== "prior-season"` re-derived at three call sites,
   * and `basis` flips on the first stats row that exists. So the morning GW1
   * finalised, the engine went from refusing every hit to recommending an
   * 8-point one — on projections whose largest input was a single match.
   *
   * It is a value on the pool now, computed once, so the three callers cannot
   * disagree about it.
   */
  const poolBase = { gw: 5, horizon: 3, teams, fixtures: [fixture(5, 1, 2)] };

  const poolAfter = (gameweeks: number[]) =>
    buildCandidatePool({
      ...poolBase,
      players: [player()],
      stats: gameweeks.map((gw) => stat(1, gw)),
    });

  it("counts gameweeks played rather than trusting the gameweek number", () => {
    // Counted from rows, so a blank counts for what it is.
    expect(poolAfter([]).gameweeksPlayed).toBe(0);
    expect(poolAfter([1, 2, 3]).gameweeksPlayed).toBe(3);
  });

  it("counts each gameweek once however many rows it has", () => {
    const pool = buildCandidatePool({
      ...poolBase,
      players: [player()],
      stats: [stat(1, 1), stat(1, 1), stat(1, 2)],
    });
    expect(pool.gameweeksPlayed).toBe(2);
  });

  it("withholds hits after a single gameweek", () => {
    // The exact regression. One played gameweek is not knowing who starts.
    expect(poolAfter([1]).minutesKnown).toBe(false);
  });

  it("withholds hits with nothing played at all", () => {
    expect(poolAfter([]).minutesKnown).toBe(false);
  });

  it("allows them once observed minutes outweigh last season's", () => {
    expect(poolAfter([1, 2, 3]).minutesKnown).toBe(false);
    expect(poolAfter([1, 2, 3, 4]).minutesKnown).toBe(true);
  });

  it("is the threshold the constant names, not a number picked here", () => {
    // Guards against the test and the constant drifting apart, which would
    // leave the test passing while the engine changed behaviour.
    const below = Array.from({ length: MINUTES_KNOWN_GAMEWEEKS - 1 }, (_, i) => i + 1);
    const at = Array.from({ length: MINUTES_KNOWN_GAMEWEEKS }, (_, i) => i + 1);
    expect(poolAfter(below).minutesKnown).toBe(false);
    expect(poolAfter(at).minutesKnown).toBe(true);
  });
});

