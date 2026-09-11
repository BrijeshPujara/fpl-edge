import { describe, expect, it } from "vitest";
import {
  buildSquadView,
  fixtureStripFor,
  type BuildSquadViewInput,
  type FixtureLike,
  type PlayerLike,
  type TeamLike,
} from "@/lib/squad/view";
import { POSITION } from "@/lib/rules";

const teams: TeamLike[] = [
  { id: 1, short_name: "ARS" },
  { id: 2, short_name: "LIV" },
  { id: 3, short_name: "BUR" },
];

function player(id: number, position: number, over: Partial<PlayerLike> = {}): PlayerLike {
  return {
    id,
    // Deliberately not equal to id — the two are different numbers in reality,
    // and a fixture where they match would hide a mix-up between them.
    code: 100_000 + id,
    web_name: `P${id}`,
    team_id: 1,
    position,
    now_cost: 50,
    status: "a",
    chance_of_playing_next_round: null,
    news: "",
    ...over,
  };
}

/** A legal 4-4-2 with a four-man bench. */
function squadInput(over: Partial<BuildSquadViewInput> = {}): BuildSquadViewInput {
  const layout = [
    POSITION.GK,
    ...Array(4).fill(POSITION.DEF),
    ...Array(4).fill(POSITION.MID),
    ...Array(2).fill(POSITION.FWD),
    // Bench: 12-15
    POSITION.GK, POSITION.DEF, POSITION.MID, POSITION.FWD,
  ];
  const players = layout.map((pos, i) => player(i + 1, pos));
  const picks = layout.map((_, i) => ({
    player_id: i + 1,
    position: i + 1,
    is_captain: i === 9,
    is_vice: i === 10,
  }));

  return {
    gw: 5,
    picks,
    players,
    teams,
    fixtures: [
      { gw: 5, home_team: 1, away_team: 3, home_difficulty: 2, away_difficulty: 4 },
      { gw: 6, home_team: 2, away_team: 1, home_difficulty: 3, away_difficulty: 4 },
      { gw: 7, home_team: 1, away_team: 2, home_difficulty: 4, away_difficulty: 3 },
    ],
    stats: [],
    ...over,
  };
}

describe("fixtureStripFor", () => {
  const teamsById = new Map(teams.map((t) => [t.id, t]));
  const fixtures: FixtureLike[] = [
    { gw: 4, home_team: 1, away_team: 2, home_difficulty: 4, away_difficulty: 4 },
    { gw: 5, home_team: 1, away_team: 3, home_difficulty: 2, away_difficulty: 4 },
    { gw: 6, home_team: 2, away_team: 1, home_difficulty: 3, away_difficulty: 5 },
    { gw: null, home_team: 1, away_team: 2, home_difficulty: 3, away_difficulty: 3 },
  ];

  it("takes the difficulty from the team's own side of the fixture", () => {
    const strip = fixtureStripFor(1, fixtures, teamsById, 5, 5);
    expect(strip[0]).toEqual({ opponent: "BUR", difficulty: 2, isHome: true });
    expect(strip[1]).toEqual({ opponent: "LIV", difficulty: 5, isHome: false });
  });

  it("excludes gameweeks before the starting point", () => {
    expect(fixtureStripFor(1, fixtures, teamsById, 5, 5)).toHaveLength(2);
  });

  it("skips unscheduled fixtures rather than misplacing them", () => {
    // A postponed fixture has a null gameweek. Including it would silently
    // shift every later fixture into the wrong column of the strip.
    const strip = fixtureStripFor(1, fixtures, teamsById, 1, 10);
    expect(strip).toHaveLength(3);
  });

  it("truncates to the requested length", () => {
    expect(fixtureStripFor(1, fixtures, teamsById, 1, 2)).toHaveLength(2);
  });
});

describe("buildSquadView", () => {
  it("splits eleven starters from four bench players", () => {
    const view = buildSquadView(squadInput());
    expect(view.rows.flatMap((r) => r.players)).toHaveLength(11);
    expect(view.bench).toHaveLength(4);
  });

  it("derives the formation without the goalkeeper", () => {
    expect(buildSquadView(squadInput()).formation).toBe("4-4-2");
  });

  it("marks the captain and vice from the picks", () => {
    const view = buildSquadView(squadInput());
    const all = [...view.rows.flatMap((r) => r.players), ...view.bench];
    expect(all.filter((p) => p.isCaptain)).toHaveLength(1);
    expect(all.filter((p) => p.isVice)).toHaveLength(1);
  });

  it("counts the captain's projection twice in the total", () => {
    const view = buildSquadView(squadInput());
    expect(view.totals.projectedTotal).toBeCloseTo(
      view.totals.startingEp + view.totals.captainBonus,
      9,
    );
  });

  it("sums squad value across all fifteen, not just the eleven", () => {
    const view = buildSquadView(squadInput());
    expect(view.totals.squadValue).toBe(15 * 50);
  });

  it("flags players and counts them", () => {
    const input = squadInput();
    input.players[3] = player(4, POSITION.DEF, {
      status: "d",
      chance_of_playing_next_round: 50,
      news: "Knock - 50% chance of playing",
    });
    input.players[7] = player(8, POSITION.MID, {
      status: "i",
      chance_of_playing_next_round: 0,
      news: "Hamstring injury",
    });

    const view = buildSquadView(input);
    expect(view.totals.flaggedCount).toBe(2);

    const flagged = view.rows
      .flatMap((r) => r.players)
      .find((p) => p.playerId === 4);
    expect(flagged?.flag).toEqual({
      chance: 50,
      note: "Knock - 50% chance of playing",
    });
  });

  it("does not flag a fully available player", () => {
    const view = buildSquadView(squadInput());
    expect(view.totals.flaggedCount).toBe(0);
  });

  it("reports pre-season when there is no history, and refuses to project", () => {
    // The honest state before GW1: the model cannot tell players apart without
    // appearance history, so the UI must not render a number it has not earned.
    const view = buildSquadView(squadInput());
    expect(view.preSeason).toBe(true);
    expect(
      view.rows.flatMap((r) => r.players).every((p) => !p.epIsProjectable),
    ).toBe(true);
  });

  it("switches to projecting once history exists", () => {
    const view = buildSquadView(
      squadInput({
        stats: [
          {
            player_id: 1, gw: 4, minutes: 90, starts: 1, goals: 0, assists: 0,
            expected_goals: 0.1, expected_assists: 0.1,
            defensive_contribution: 3, bonus: 0, goals_conceded: 1,
            yellow_cards: 0, red_cards: 0,
          },
        ],
      }),
    );
    expect(view.preSeason).toBe(false);
    expect(
      view.rows.flatMap((r) => r.players).every((p) => p.epIsProjectable),
    ).toBe(true);
  });

  it("tolerates a pick whose player row is missing", () => {
    // Defensive: a squad synced before the player table caught up should render
    // fourteen tiles rather than crash the page.
    const input = squadInput();
    input.players = input.players.filter((p) => p.id !== 3);
    const view = buildSquadView(input);
    expect(
      [...view.rows.flatMap((r) => r.players), ...view.bench],
    ).toHaveLength(14);
  });

  it("averages fixture difficulty across the starting XI only", () => {
    const view = buildSquadView(squadInput());
    expect(view.totals.meanDifficulty).not.toBeNull();
    expect(view.totals.meanDifficulty!).toBeGreaterThan(1);
    expect(view.totals.meanDifficulty!).toBeLessThan(5);
  });
});

describe("picks that predate the gameweek being projected", () => {
  /*
   * FPL publishes a squad only once its deadline passes, so between deadlines
   * the newest picks available are last week's. The page renders them against
   * the TARGET gameweek's fixtures, which is right, and used to label them
   * with the target's number, which was not — "your GW4 squad" when it is
   * really your GW3 squad. During a wildcard all fifteen can differ.
   */
  it("defaults to the projected gameweek when the caller says nothing", () => {
    const view = buildSquadView(squadInput());
    expect(view.picksGw).toBe(view.gw);
    expect(view.picksAreStale).toBe(false);
  });

  it("reports the gameweek the picks actually came from", () => {
    const view = buildSquadView({ ...squadInput(), gw: 4, picksGw: 3 });
    expect(view.gw).toBe(4);
    expect(view.picksGw).toBe(3);
    expect(view.picksAreStale).toBe(true);
  });

  it("still projects against the gameweek being decided, not the picks'", () => {
    // The staleness is a claim about whose players these are, not about which
    // fixtures they face. Projecting last week's fixtures would be a second,
    // worse bug on top of the first.
    const fresh = buildSquadView({ ...squadInput(), gw: 4 });
    const stale = buildSquadView({ ...squadInput(), gw: 4, picksGw: 3 });
    expect(stale.totals.startingEp).toBeCloseTo(fresh.totals.startingEp, 10);
  });
});
