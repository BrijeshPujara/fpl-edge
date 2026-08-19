import { describe, expect, it } from "vitest";
import {
  bootstrapStaticSchema,
  hasStrengthRatings,
  teamSchema,
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

describe("hasStrengthRatings", () => {
  it("is false pre-season, when every rating is zero", () => {
    // The trap this guards: zero is a valid integer, so a naive opponent
    // adjustment divides by a league mean of zero and silently produces NaN.
    expect(hasStrengthRatings(teamSchema.parse(preSeasonTeam))).toBe(false);
  });

  it("is true once real ratings are published", () => {
    expect(hasStrengthRatings(teamSchema.parse(inSeasonTeam))).toBe(true);
  });

  it("is false if any single rating is missing", () => {
    const partial = { ...inSeasonTeam, strength_defence_away: 0 };
    expect(hasStrengthRatings(teamSchema.parse(partial))).toBe(false);
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
