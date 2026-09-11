import { describe, expect, it } from "vitest";
import { MINUTES_KNOWN_GAMEWEEKS } from "@/lib/engine/constants";
import {
  buildCandidatePool,
  toPlayerCandidate,
} from "@/lib/squad/candidates";
import {
  fixtureContextsFor,
  fixtureRatings,
  type TeamRatingLike,
} from "@/lib/squad/projection";
import type {
  FixtureLike,
  PlayerLike,
  StatLike,
  TeamLike,
} from "@/lib/squad/view";
import { POSITION } from "@/lib/rules";

const teams: TeamLike[] = [
  { id: 1, short_name: "ARS" },
  { id: 2, short_name: "BUR" },
];

/**
 * Fitted ratings on the scale `team_ratings` actually stores: a multiplier on
 * league-average goals. ARS attack well, and concede at half the league rate;
 * BUR are the mirror image. Defence is a CONCESSION factor, so BUR's 1.31 is
 * the bad one — the direction this file exists to pin down.
 */
const teamRatings: TeamRatingLike[] = [
  { team_id: 1, attack: 1.38, defence: 0.48 },
  { team_id: 2, attack: 0.68, defence: 1.31 },
];

/**
 * A table long enough to have a real spread. Two clubs would not: the standard
 * deviation of two values is half the gap between them, so each sits exactly
 * one deviation from the mean no matter what the ratings say.
 */
const deepTable: TeamRatingLike[] = [
  { team_id: 1, attack: 1.38, defence: 0.70 },
  { team_id: 2, attack: 1.20, defence: 0.48 },
  { team_id: 3, attack: 0.68, defence: 1.45 },
  { team_id: 4, attack: 1.05, defence: 0.95 },
  { team_id: 5, attack: 0.90, defence: 1.10 },
  { team_id: 6, attack: 1.10, defence: 1.00 },
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

  it("projects a player differently against different opponents", () => {
    /*
     * The regression guard for the bug this ratings source exists to fix.
     *
     * FPL served `strength_attack_*` and `strength_defence_*` as zero for all
     * twenty clubs through 2026/27. The schema was satisfied, `ratingStats`
     * read the zeros as pre-season and returned null, and every fixture in the
     * season projected neutral — Haaland away at Man United scored the same as
     * Haaland at home to a promoted side. Nothing threw and every test passed,
     * because no test had ever asserted that the opponent mattered at all.
     *
     * This one does. It fails if the ratings stop arriving, and it fails if
     * the defence conversion loses its sign.
     *
     * The ratings table is held FIXED and only the opponent changes. Varying a
     * rating instead moves the league mean and spread it is normalised
     * against, and with a short table that hides the very effect being
     * measured — two clubs sit exactly one standard deviation apart whatever
     * their ratings are, so every fixture scores the same.
     */
    const striker = player({ team_id: 1 });
    const stats = [stat(1, 4), stat(1, 3)];
    const shared = { ...base, players: [striker], stats, teamRatings: deepTable };

    const [versusElite] = buildCandidatePool({
      ...shared, fixtures: [fixture(5, 1, 2)],
    }).candidates;
    const [versusLeaky] = buildCandidatePool({
      ...shared, fixtures: [fixture(5, 1, 3)],
    }).candidates;

    expect(versusLeaky.perGameweek[0].ep).toBeGreaterThan(
      versusElite.perGameweek[0].ep,
    );
  });

  it("skips variance entirely when the risk weight is zero", () => {
    // The default. Computing a distribution per player per gameweek costs
    // ~55ms across a full pool, and at γ=0 the optimiser would multiply it by
    // nothing. Null rather than 0 so the optimiser can tell "not computed"
    // from "certain".
    const pool = buildCandidatePool({
      ...base, players: [player()], stats: [stat(1, 4)], teamRatings,
    });
    expect(pool.candidates[0].variance).toBeNull();
  });

  it("computes variance when a risk weight is set", () => {
    const pool = buildCandidatePool({
      ...base, players: [player()], stats: [stat(1, 4)], teamRatings,
      riskAversion: 0.05,
    });
    expect(pool.candidates[0].variance).toBeGreaterThan(0);
  });

  it("says so when it has no ratings to judge fixtures with", () => {
    const pool = buildCandidatePool({
      ...base, players: [player()], stats: [stat(1, 4)],
    });
    expect(pool.fixtureAware).toBe(false);
  });

  it("is fixture aware once ratings are supplied", () => {
    const pool = buildCandidatePool({
      ...base, players: [player()], stats: [stat(1, 4)], teamRatings,
    });
    expect(pool.fixtureAware).toBe(true);
  });

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
  const ratings = fixtureRatings(teamRatings);

  it("returns one context per fixture, not per gameweek", () => {
    const contexts = fixtureContextsFor(
      1,
      [fixture(5, 1, 2), fixture(5, 2, 1), fixture(6, 1, 2)],
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
      ratings,
      [5],
    );
    expect(contexts).toHaveLength(1);
  });

  it("skips fixtures with no gameweek assigned", () => {
    const contexts = fixtureContextsFor(
      1,
      [{ gw: null, home_team: 1, away_team: 2, home_difficulty: 3, away_difficulty: 3 }],
      ratings,
      [5],
    );
    expect(contexts).toEqual([]);
  });

  it("carries one rating per club regardless of venue", () => {
    // Venue is applied once, by HOME_ADVANTAGE inside expectedGoalsAgainst.
    // A home and an away rating here would count it twice.
    const [home, away] = fixtureContextsFor(
      1,
      [fixture(5, 1, 2), fixture(6, 2, 1)],
      ratings,
      [5, 6],
    );
    expect(home.teamDefence).toBe(away.teamDefence);
  });

  it("reads neutral for a club with no fitted rating", () => {
    const [context] = fixtureContextsFor(
      3,
      [fixture(5, 3, 1)],
      ratings,
      [5],
    );
    expect(context.teamDefence).toBeNull();
  });
});

describe("fixtureRatings", () => {
  it("inverts defence, which is a concession factor", () => {
    // The whole point. `attack` already means "higher is better", but
    // `defence` means "higher concedes more" — the opposite of the FPL field
    // it replaced. Passed through unconverted every fixture reads backwards,
    // which is worse than the zeros that prompted the change.
    const ratings = fixtureRatings(teamRatings);
    const arsenal = ratings.byTeam.get(1)!;
    const burnley = ratings.byTeam.get(2)!;

    expect(arsenal.defence).toBeGreaterThan(burnley.defence);
    expect(arsenal.attack).toBeGreaterThan(burnley.attack);
  });

  it("stays positive for a defence worse than twice the league average", () => {
    // Mirroring around the mean would go negative here, and
    // `opponentAdjustment` silently neutralises a non-positive rating — which
    // would mute the league's worst defence exactly where it matters most.
    const ratings = fixtureRatings([
      ...teamRatings,
      { team_id: 3, attack: 0.5, defence: 2.6 },
    ]);
    expect(ratings.byTeam.get(3)!.defence).toBeGreaterThan(0);
  });

  it("summarises the league distribution", () => {
    const r = fixtureRatings(teamRatings);
    expect(r.attack?.mean).toBeGreaterThan(0);
    expect(r.defence?.std).toBeGreaterThan(0);
    expect(r.usable).toBe(true);
  });

  it("is unusable with nothing stored", () => {
    // Not a fallback — "no information" is the correct answer, and the model
    // turns the opponent adjustment off rather than inventing a scale.
    const r = fixtureRatings([]);
    expect(r.attack).toBeNull();
    expect(r.defence).toBeNull();
    expect(r.usable).toBe(false);
  });

  it("drops a non-positive fit rather than dividing by it", () => {
    const r = fixtureRatings([
      ...teamRatings,
      { team_id: 3, attack: 0, defence: 0 },
    ]);
    expect(r.byTeam.has(3)).toBe(false);
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

