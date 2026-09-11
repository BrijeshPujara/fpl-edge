import { describe, expect, it } from "vitest";
import {
  bootstrapStaticSchema,
  teamSchema,
  leagueStandingsSchema,
} from "@/lib/fpl/schemas";

/**
 * These fixtures are trimmed from real August 2026 API responses. The
 * pre-season shape is not hypothetical — it is what the API actually returns
 * before a ball is kicked, and it broke the first version of these schemas.
 */

const preSeasonTeam = {
  code: 3,
  id: 1,
  name: "Arsenal",
  short_name: "ARS",
  form: null,
  strength: null,
  team_division: null,
  strength_overall_home: 4,
  strength_overall_away: 5,
  strength_attack_home: 0,
  strength_attack_away: 0,
  strength_defence_home: 0,
  strength_defence_away: 0,
};

const inSeasonTeam = {
  ...preSeasonTeam,
  strength: 4,
  strength_attack_home: 1220,
  strength_attack_away: 1250,
  strength_defence_home: 1180,
  strength_defence_away: 1210,
};

describe("teamSchema", () => {
  it("accepts the pre-season shape, where strength is null", () => {
    const parsed = teamSchema.parse(preSeasonTeam);
    expect(parsed.strength).toBeNull();
    expect(parsed.short_name).toBe("ARS");
  });

  it("accepts the in-season shape", () => {
    expect(teamSchema.parse(inSeasonTeam).strength).toBe(4);
  });

  it("still rejects a genuinely missing field", () => {
    const { short_name, ...withoutShortName } = preSeasonTeam;
    void short_name;
    expect(() => teamSchema.parse(withoutShortName)).toThrow();
  });
});

describe("bootstrapStaticSchema", () => {
  it("coerces the API's stringified decimals to numbers", () => {
    const parsed = bootstrapStaticSchema.parse({
      events: [
        {
          id: 1,
          name: "Gameweek 1",
          deadline_time: "2026-08-21T17:30:00Z",
          finished: false,
          is_previous: false,
          is_current: false,
          is_next: true,
          data_checked: false,
          average_entry_score: 0,
          highest_score: null,
          most_captained: null,
          most_selected: null,
        },
      ],
      teams: [preSeasonTeam],
      element_types: [
        {
          id: 1,
          singular_name_short: "GKP",
          squad_select: 2,
          squad_min_play: 1,
          squad_max_play: 1,
        },
      ],
      elements: [
        {
          id: 1,
          code: 100,
          web_name: "Raya",
          first_name: "David",
          second_name: "Raya",
          team: 1,
          element_type: 1,
          now_cost: 56,
          cost_change_start: 0,
          cost_change_event: 0,
          status: "a",
          chance_of_playing_next_round: null,
          chance_of_playing_this_round: null,
          news: "",
          news_added: null,
          selected_by_percent: "18.4",
          form: "0.0",
          total_points: 0,
          minutes: 0,
          goals_scored: 0,
          assists: 0,
          clean_sheets: 0,
          goals_conceded: 0,
          yellow_cards: 0,
          red_cards: 0,
          bonus: 0,
          bps: 0,
          expected_goals: "0.00",
          expected_assists: "0.00",
          expected_goal_involvements: "0.00",
          expected_goals_conceded: "0.00",
          starts: 37,
          ep_this: null,
          ep_next: "4.0",
        },
      ],
      chips: [
        {
          id: 1,
          name: "wildcard",
          number: 1,
          start_event: 2,
          stop_event: 19,
          chip_type: "transfer",
        },
      ],
    });

    expect(parsed.elements[0].selected_by_percent).toBe(18.4);
    expect(parsed.elements[0].ep_next).toBe(4);
    expect(parsed.elements[0].ep_this).toBeNull();
    // Absent from the pre-season payload; defaulted rather than fatal.
    expect(parsed.elements[0].defensive_contribution).toBe(0);
    // The wildcard is not playable in GW1 — another reason not to hardcode
    // chip windows.
    expect(parsed.chips[0].start_event).toBe(2);
  });
});

describe("league standings, as the API actually sends them", () => {
  const row = {
    entry: 6043439,
    entry_name: "Jurassic AFC",
    player_name: "Kevin Timothy",
    rank: 1,
    last_rank: 0,
    total: 108,
    event_total: 108,
    rank_sort: 1,
    club_badge_src: null,
  };
  const payload = (results: unknown[]) => ({
    league: { id: 319, name: "TNT Sports League" },
    standings: { has_next: false, page: 1, results },
  });

  it("accepts a row with no id, which is what FPL now sends", () => {
    // It sent one until partway through 2026/27. The schema required it, so
    // every league threw, and the screen reported an outage that was not
    // happening.
    const parsed = leagueStandingsSchema.parse(payload([row]));
    expect(parsed.standings.results[0].entry).toBe(6043439);
  });

  it("still accepts one that has it", () => {
    expect(() =>
      leagueStandingsSchema.parse(payload([{ ...row, id: 77 }])),
    ).not.toThrow();
  });

  it("still rejects a row missing something it actually needs", () => {
    // `entry` is the manager's team id and the only key this app has ever
    // used. Relaxing one optional field must not relax the rest.
    const { entry: _entry, ...withoutEntry } = row;
    expect(() => leagueStandingsSchema.parse(payload([withoutEntry]))).toThrow();
  });

  it("ignores fields it has never heard of", () => {
    expect(() =>
      leagueStandingsSchema.parse(payload([{ ...row, something_new: true }])),
    ).not.toThrow();
  });
});
