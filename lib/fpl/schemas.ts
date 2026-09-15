import { z } from "zod";

/**
 * Zod schemas for the official FPL API.
 *
 * The API is untyped, undocumented and occasionally changes shape mid-season.
 * Every response is `unknown` until it passes through here. We fail loudly on
 * a shape change rather than silently writing nulls into the database — a
 * season of quietly-corrupted history is unrecoverable.
 *
 * Fields we do not use are omitted; Zod object schemas are non-strict by
 * default, so additions upstream are ignored rather than fatal. Fields we DO
 * use are required, so removals upstream are fatal. That asymmetry is
 * deliberate.
 */

/** The API returns decimals as strings ("0.42"). Coerce and validate. */
const numericString = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === "number" ? v : Number.parseFloat(v)))
  .pipe(z.number());

/** Some numeric fields are null for players with no data yet. */
const nullableNumericString = z
  .union([z.string(), z.number(), z.null()])
  .transform((v) => {
    if (v === null) return null;
    return typeof v === "number" ? v : Number.parseFloat(v);
  })
  .pipe(z.number().nullable());

// ---------------------------------------------------------------------------
// bootstrap-static/
// ---------------------------------------------------------------------------

export const eventSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  deadline_time: z.string().datetime({ offset: true }),
  finished: z.boolean(),
  is_previous: z.boolean(),
  is_current: z.boolean(),
  is_next: z.boolean(),
  data_checked: z.boolean(),
  average_entry_score: z.number().nullable().default(0),
  highest_score: z.number().nullable(),
  most_captained: z.number().nullable(),
  most_selected: z.number().nullable(),
  chip_plays: z
    .array(z.object({ chip_name: z.string(), num_played: z.number() }))
    .default([]),
});

export type FplEvent = z.infer<typeof eventSchema>;

/**
 * Team strength ratings.
 *
 * `strength` is NULL for every team until the season is under way, and
 * `strength_attack_*` and `strength_defence_*` have read ZERO for all twenty
 * clubs for the whole of 2026/27 — not just pre-season, as was assumed when
 * this was written. FPL appears to have stopped publishing them.
 *
 * NOTHING MODELS ON THESE FOUR FIELDS ANY MORE, and a guard that used to say
 * whether they were usable has been deleted rather than left for someone to
 * wire back up. Fixture difficulty comes from `team_ratings`, fitted from
 * results we have seen — see `fixtureRatings` in `lib/squad/projection.ts` for
 * what reading these zeros cost.
 *
 * They stay REQUIRED here regardless, because that is what invariant 5 is for:
 * they are still in the payload, and the day their shape changes we want to
 * hear about it. A zero that parses is a different problem from a field that
 * vanishes, and loosening the schema would hide the second while fixing
 * neither.
 */
export const teamSchema = z.object({
  id: z.number().int(),
  /**
   * Stable across seasons, unlike `id` — and what FPL's shirt images are keyed
   * on. Required like every field we read: a pitch of silhouettes because the
   * code quietly went missing is exactly the failure invariant 5 exists for.
   */
  code: z.number().int(),
  name: z.string(),
  short_name: z.string(),
  strength: z.number().int().nullable(),
  strength_overall_home: z.number().int(),
  strength_overall_away: z.number().int(),
  strength_attack_home: z.number().int(),
  strength_attack_away: z.number().int(),
  strength_defence_home: z.number().int(),
  strength_defence_away: z.number().int(),
});

export type FplTeam = z.infer<typeof teamSchema>;

/**
 * One transfer a manager actually made.
 *
 * `event` is the gameweek the move was made FOR, which is what the journal
 * comparison keys on — not when it was clicked. Required, like everything else
 * we read: a transfer with no gameweek cannot be compared against advice for
 * one, and silently dropping it would quietly flatter whichever side is being
 * measured. See invariant 5.
 */
export const entryTransferSchema = z.object({
  element_in: z.number().int(),
  element_out: z.number().int(),
  event: z.number().int(),
  element_in_cost: z.number().int(),
  element_out_cost: z.number().int(),
});

export const entryTransfersSchema = z.array(entryTransferSchema);

export type FplEntryTransfer = z.infer<typeof entryTransferSchema>;

export const elementTypeSchema = z.object({
  id: z.number().int(),
  singular_name_short: z.string(),
  squad_select: z.number().int(),
  squad_min_play: z.number().int(),
  squad_max_play: z.number().int(),
});

export const elementSchema = z.object({
  id: z.number().int(),
  code: z.number().int(),
  web_name: z.string(),
  first_name: z.string(),
  second_name: z.string(),
  team: z.number().int(),
  element_type: z.number().int(),
  now_cost: z.number().int(),
  cost_change_start: z.number().int(),
  cost_change_event: z.number().int(),
  status: z.string(),
  chance_of_playing_next_round: z.number().nullable(),
  chance_of_playing_this_round: z.number().nullable(),
  news: z.string(),
  news_added: z.string().nullable(),
  selected_by_percent: numericString,
  form: numericString,
  // Season-cumulative and never reset, which is why the momentum series is
  // built by differencing these rather than by reading `transfers_in_event`.
  // See supabase/migrations/0003_transfer_snapshots.sql.
  transfers_in: z.number().int().optional().default(0),
  transfers_out: z.number().int().optional().default(0),
  total_points: z.number().int(),
  minutes: z.number().int(),
  goals_scored: z.number().int(),
  assists: z.number().int(),
  clean_sheets: z.number().int(),
  goals_conceded: z.number().int(),
  yellow_cards: z.number().int(),
  red_cards: z.number().int(),
  bonus: z.number().int(),
  bps: z.number().int(),
  expected_goals: numericString,
  expected_assists: numericString,
  expected_goal_involvements: numericString,
  expected_goals_conceded: numericString,
  starts: z.number().int(),
  // Present from 2025/26 onward. Older datasets lack it, so it is optional.
  defensive_contribution: z.number().int().optional().default(0),
  // Set-piece duty, as a per-club ordering: 1 is the designated taker, null is
  // no listed duty. Optional because these are absent from older datasets, and
  // nullable-with-default rather than defaulted-to-1 because "nobody listed" and
  // "first choice" are opposite claims.
  penalties_order: z.number().int().nullable().optional().default(null),
  corners_and_indirect_freekicks_order: z
    .number()
    .int()
    .nullable()
    .optional()
    .default(null),
  direct_freekicks_order: z.number().int().nullable().optional().default(null),
  ep_this: nullableNumericString,
  ep_next: nullableNumericString,
});

export type FplElement = z.infer<typeof elementSchema>;

/**
 * Chip availability windows, exposed at the top level of bootstrap-static.
 *
 * This is the authoritative source for when each chip may be played and when
 * it expires — read it rather than hardcoding "the first set dies at GW19".
 * `chip_type` is "transfer" (wildcard, free hit) or "team" (bench boost,
 * triple captain).
 */
export const chipSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  number: z.number().int(),
  start_event: z.number().int(),
  stop_event: z.number().int(),
  chip_type: z.string(),
});

export type FplChip = z.infer<typeof chipSchema>;

export const bootstrapStaticSchema = z.object({
  events: z.array(eventSchema).min(1),
  teams: z.array(teamSchema).min(1),
  element_types: z.array(elementTypeSchema).min(1),
  elements: z.array(elementSchema).min(1),
  chips: z.array(chipSchema).default([]),
  // Active manager count. The denominator behind every ownership figure, and
  // the scale the price-change threshold is measured against — 20% ownership
  // is 1.3m managers, and it is the count, not the percentage, that decides
  // how many net transfers a price move needs.
  total_players: z.number().int().optional().default(0),
});

export type FplBootstrapStatic = z.infer<typeof bootstrapStaticSchema>;

// ---------------------------------------------------------------------------
// fixtures/
// ---------------------------------------------------------------------------

export const fixtureSchema = z.object({
  id: z.number().int(),
  code: z.number().int(),
  /** Null for fixtures not yet assigned to a gameweek (postponements). */
  event: z.number().int().nullable(),
  team_h: z.number().int(),
  team_a: z.number().int(),
  team_h_score: z.number().int().nullable(),
  team_a_score: z.number().int().nullable(),
  kickoff_time: z.string().datetime({ offset: true }).nullable(),
  started: z.boolean().nullable(),
  finished: z.boolean(),
  finished_provisional: z.boolean(),
  minutes: z.number().int(),
  team_h_difficulty: z.number().int(),
  team_a_difficulty: z.number().int(),
});

export type FplFixture = z.infer<typeof fixtureSchema>;

export const fixturesSchema = z.array(fixtureSchema);

// ---------------------------------------------------------------------------
// event/{gw}/live/
// ---------------------------------------------------------------------------

/**
 * The efficient way to build per-gameweek history: one call returns every
 * player's stats for that gameweek. Prefer this over 700 calls to
 * element-summary/ when backfilling.
 */
export const liveElementStatsSchema = z.object({
  minutes: z.number().int(),
  goals_scored: z.number().int(),
  assists: z.number().int(),
  clean_sheets: z.number().int(),
  goals_conceded: z.number().int(),
  own_goals: z.number().int(),
  penalties_saved: z.number().int(),
  penalties_missed: z.number().int(),
  yellow_cards: z.number().int(),
  red_cards: z.number().int(),
  saves: z.number().int(),
  bonus: z.number().int(),
  bps: z.number().int(),
  starts: z.number().int(),
  expected_goals: numericString,
  expected_assists: numericString,
  expected_goal_involvements: numericString,
  expected_goals_conceded: numericString,
  defensive_contribution: z.number().int().optional().default(0),
  total_points: z.number().int(),
});

export const liveElementSchema = z.object({
  id: z.number().int(),
  stats: liveElementStatsSchema,
  /** One entry per fixture the player featured in — two in a double gameweek. */
  explain: z.array(
    z.object({
      fixture: z.number().int(),
      stats: z.array(
        z.object({
          identifier: z.string(),
          points: z.number().int(),
          value: z.number().int(),
        }),
      ),
    }),
  ),
});

export type FplLiveElement = z.infer<typeof liveElementSchema>;

export const eventLiveSchema = z.object({
  elements: z.array(liveElementSchema),
});

// ---------------------------------------------------------------------------
// element-summary/{playerId}/
// ---------------------------------------------------------------------------

export const elementHistorySchema = z.object({
  element: z.number().int(),
  fixture: z.number().int(),
  opponent_team: z.number().int(),
  was_home: z.boolean(),
  round: z.number().int(),
  minutes: z.number().int(),
  goals_scored: z.number().int(),
  assists: z.number().int(),
  clean_sheets: z.number().int(),
  goals_conceded: z.number().int(),
  yellow_cards: z.number().int(),
  red_cards: z.number().int(),
  bonus: z.number().int(),
  bps: z.number().int(),
  expected_goals: numericString,
  expected_assists: numericString,
  expected_goals_conceded: numericString,
  defensive_contribution: z.number().int().optional().default(0),
  total_points: z.number().int(),
  value: z.number().int(),
  transfers_balance: z.number().int(),
  starts: z.number().int(),
});

export type FplElementHistory = z.infer<typeof elementHistorySchema>;

/**
 * One completed season for one player, from `element-summary/{id}.history_past`.
 *
 * The key is `element_code`, not `id`. FPL renumbers player ids every season;
 * the code is the stable identity, and it is the only thing that lets last
 * season's rates find this season's player.
 *
 * xG and xA are optional because the API did not publish them before 2022/23.
 * A season without them is a season the model cannot use, which is the correct
 * outcome rather than a zero.
 */
export const seasonHistorySchema = z.object({
  season_name: z.string(),
  element_code: z.number().int(),
  total_points: z.number().int(),
  minutes: z.number().int(),
  starts: z.number().int().optional().default(0),
  goals_scored: z.number().int(),
  assists: z.number().int(),
  clean_sheets: z.number().int(),
  goals_conceded: z.number().int().optional().default(0),
  expected_goals: numericString.optional(),
  expected_assists: numericString.optional(),
  // A season TOTAL of defensive actions, not a count of threshold hits. See
  // lib/engine/prior-season.ts for why that distinction ends the idea of
  // deriving a DefCon rate from it.
  defensive_contribution: z.number().int().optional().default(0),
  bonus: z.number().int(),
  start_cost: z.number().int(),
  end_cost: z.number().int(),
});

export type FplSeasonHistory = z.infer<typeof seasonHistorySchema>;

export const elementSummarySchema = z.object({
  fixtures: z.array(
    z.object({
      id: z.number().int(),
      event: z.number().int().nullable(),
      is_home: z.boolean(),
      difficulty: z.number().int(),
      team_h: z.number().int(),
      team_a: z.number().int(),
      kickoff_time: z.string().datetime({ offset: true }).nullable(),
    }),
  ),
  history: z.array(elementHistorySchema),
  history_past: z.array(seasonHistorySchema),
});

// ---------------------------------------------------------------------------
// entry/{teamId}/ and picks
// ---------------------------------------------------------------------------

/**
 * One league a manager belongs to, as `entry/{id}/` reports it.
 *
 * `league_type` is the field that matters and the reason no configuration is
 * needed: "x" is a private league someone actually joined, "s" is a system
 * league the game enrols everyone into — Overall, their country, their
 * favourite club. Both arrive in the same array, and only the first kind is a
 * mini-league in any useful sense.
 */
export const entryLeagueSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  /** "x" = private/invitational, "s" = system. */
  league_type: z.string(),
  /** "c" = classic, "h" = head-to-head. */
  scoring: z.string(),
  start_event: z.number().int().nullable().optional().default(null),
  /** Zero before a gameweek has been scored, not a real position. */
  entry_rank: z.number().int().nullable().optional().default(null),
  entry_last_rank: z.number().int().nullable().optional().default(null),
});

export type FplEntryLeague = z.infer<typeof entryLeagueSchema>;

export const entrySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  /**
   * Every league the manager is in. Already in the payload the app fetches to
   * register them, so mini-leagues are discovered rather than configured.
   */
  leagues: z
    .object({
      classic: z.array(entryLeagueSchema).default([]),
      h2h: z.array(entryLeagueSchema).default([]),
    })
    .optional()
    .default({ classic: [], h2h: [] }),
  player_first_name: z.string(),
  player_last_name: z.string(),
  summary_overall_points: z.number().int().nullable(),
  summary_overall_rank: z.number().int().nullable(),
  summary_event_points: z.number().int().nullable(),
  summary_event_rank: z.number().int().nullable(),
  current_event: z.number().int().nullable(),
  last_deadline_bank: z.number().int().nullable(),
  last_deadline_value: z.number().int().nullable(),
  last_deadline_total_transfers: z.number().int().nullable(),
});

export type FplEntry = z.infer<typeof entrySchema>;

export const pickSchema = z.object({
  element: z.number().int(),
  position: z.number().int(),
  multiplier: z.number().int(),
  is_captain: z.boolean(),
  is_vice_captain: z.boolean(),
});

export const entryPicksSchema = z.object({
  active_chip: z.string().nullable(),
  entry_history: z.object({
    event: z.number().int(),
    points: z.number().int(),
    total_points: z.number().int(),
    rank: z.number().int().nullable(),
    overall_rank: z.number().int().nullable(),
    bank: z.number().int(),
    value: z.number().int(),
    event_transfers: z.number().int(),
    event_transfers_cost: z.number().int(),
    points_on_bench: z.number().int(),
  }),
  picks: z.array(pickSchema).length(15),
});

export type FplEntryPicks = z.infer<typeof entryPicksSchema>;

export const entryHistorySchema = z.object({
  current: z.array(
    z.object({
      event: z.number().int(),
      points: z.number().int(),
      total_points: z.number().int(),
      rank: z.number().int().nullable(),
      overall_rank: z.number().int().nullable(),
      bank: z.number().int(),
      value: z.number().int(),
      event_transfers: z.number().int(),
      event_transfers_cost: z.number().int(),
      points_on_bench: z.number().int(),
    }),
  ),
  chips: z.array(
    z.object({
      name: z.string(),
      event: z.number().int(),
      time: z.string(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// leagues-classic/{leagueId}/standings/
// ---------------------------------------------------------------------------

export const leagueStandingsSchema = z.object({
  league: z.object({
    id: z.number().int(),
    name: z.string(),
  }),
  standings: z.object({
    has_next: z.boolean(),
    page: z.number().int(),
    results: z.array(
      z.object({
        /*
         * FPL stopped sending this, and it took the leagues screen down.
         *
         * Every standings row lost `id` at some point during the 2026/27
         * season. The schema required it, so the parse threw for every league,
         * the page caught the throw, and it rendered the same "standings
         * unavailable" state it shows for a genuine outage — a shape change
         * wearing the costume of a network problem.
         *
         * Optional rather than removed, because it costs nothing to accept it
         * if it returns. Nothing reads it: `entry` is the manager's team id
         * and is the only key this app has ever needed.
         */
        id: z.number().int().optional(),
        entry: z.number().int(),
        entry_name: z.string(),
        player_name: z.string(),
        rank: z.number().int(),
        last_rank: z.number().int(),
        total: z.number().int(),
        event_total: z.number().int(),
      }),
    ),
  }),
});
