/**
 * FPL competition rules for 2026/27.
 *
 * Everything in here is a rule of the game, not a tunable of the model. Model
 * tunables live in `lib/engine/constants.ts` — keep the distinction, because
 * these change once a season by decree and those change whenever the backtest
 * says so.
 *
 * Money is in tenths of a million throughout, matching the API. £100.0m is
 * 1000. Format only at the render boundary (see `lib/format.ts`).
 */

export const POSITION = {
  GK: 1,
  DEF: 2,
  MID: 3,
  FWD: 4,
} as const;

export type PositionId = (typeof POSITION)[keyof typeof POSITION];

export const POSITION_SHORT: Record<PositionId, string> = {
  [POSITION.GK]: "GK",
  [POSITION.DEF]: "DEF",
  [POSITION.MID]: "MID",
  [POSITION.FWD]: "FWD",
};

// ---------------------------------------------------------------------------
// Squad composition
// ---------------------------------------------------------------------------

export const SQUAD_BUDGET = 1000; // £100.0m in tenths
export const SQUAD_SIZE = 15;
export const STARTING_XI_SIZE = 11;
export const MAX_PLAYERS_PER_CLUB = 3;

/** Exact number of each position required in the 15-man squad. */
export const SQUAD_COMPOSITION: Record<PositionId, number> = {
  [POSITION.GK]: 2,
  [POSITION.DEF]: 5,
  [POSITION.MID]: 5,
  [POSITION.FWD]: 3,
};

/** Inclusive bounds on each position within a legal starting XI. */
export const FORMATION_BOUNDS: Record<PositionId, { min: number; max: number }> =
  {
    [POSITION.GK]: { min: 1, max: 1 },
    [POSITION.DEF]: { min: 3, max: 5 },
    [POSITION.MID]: { min: 2, max: 5 },
    [POSITION.FWD]: { min: 1, max: 3 },
  };

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

export const FREE_TRANSFERS_PER_GW = 1;
/** Free transfers roll over, banked up to this ceiling. */
export const MAX_BANKED_FREE_TRANSFERS = 5;
/** Points deducted per transfer beyond the free allowance. */
export const TRANSFER_HIT_COST = 4;

/**
 * A transfer beyond the free allowance only makes sense if it beats the hit
 * over the whole horizon — not just the coming gameweek. This is the single
 * number that stops the optimiser chasing last week's points.
 */
export const HIT_BREAK_EVEN_EP = TRANSFER_HIT_COST;

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export const APPEARANCE_POINTS = { under60: 1, over60: 2 } as const;

export const GOAL_POINTS: Record<PositionId, number> = {
  [POSITION.GK]: 10,
  [POSITION.DEF]: 6,
  [POSITION.MID]: 5,
  [POSITION.FWD]: 4,
};

export const ASSIST_POINTS = 3;

export const CLEAN_SHEET_POINTS: Record<PositionId, number> = {
  [POSITION.GK]: 4,
  [POSITION.DEF]: 4,
  [POSITION.MID]: 1,
  [POSITION.FWD]: 0,
};

/** GK and DEF lose a point for every two goals conceded in a match. */
export const GOALS_CONCEDED_PENALTY = -1;
export const GOALS_CONCEDED_PER_PENALTY = 2;

export const CARD_POINTS = { yellow: -1, red: -3 } as const;

/**
 * Defensive contributions ("DefCon"). 2 points for reaching the threshold.
 *
 * Defenders count clearances, blocks, interceptions and tackles. Midfielders
 * and forwards use the same actions *plus* ball recoveries, against a higher
 * threshold. Goalkeepers do not score DefCon.
 */
export const DEFCON_POINTS = 2;
export const DEFCON_THRESHOLD: Record<PositionId, number | null> = {
  [POSITION.GK]: null,
  [POSITION.DEF]: 10,
  [POSITION.MID]: 12,
  [POSITION.FWD]: 12,
};

/** Bonus is awarded to the top three BPS scorers in each match. */
export const BONUS_POINTS = [3, 2, 1] as const;

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/**
 * `status` on the player object. Only 'a' is fully available; everything else
 * means the minutes model must discount, and 'u' (unavailable) is a hard zero.
 */
export const PLAYER_STATUS = {
  available: "a",
  doubtful: "d",
  injured: "i",
  suspended: "s",
  unavailable: "u",
} as const;

export type PlayerStatus = (typeof PLAYER_STATUS)[keyof typeof PLAYER_STATUS];

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

/**
 * Chip names as the API reports them. Two full sets this season, one per half.
 *
 * Deliberately NO hardcoded expiry gameweek here. `bootstrap-static` returns a
 * top-level `chips[]` array carrying `start_event` and `stop_event` per chip —
 * read the windows from that (see `lib/fpl/schemas.ts`). The same rule that
 * forbids hardcoding gameweek deadlines forbids hardcoding chip windows.
 */
export const CHIP = {
  wildcard: "wildcard",
  freeHit: "freehit",
  tripleCaptain: "3xc",
  benchBoost: "bboost",
} as const;

export type ChipName = (typeof CHIP)[keyof typeof CHIP];

export const CHIP_LABEL: Record<ChipName, string> = {
  [CHIP.wildcard]: "Wildcard",
  [CHIP.freeHit]: "Free Hit",
  [CHIP.tripleCaptain]: "Triple Captain",
  [CHIP.benchBoost]: "Bench Boost",
};

/** Only one chip may be played in a given gameweek. */
export const MAX_CHIPS_PER_GW = 1;

export const CAPTAIN_MULTIPLIER = 2;
export const TRIPLE_CAPTAIN_MULTIPLIER = 3;

// ---------------------------------------------------------------------------
// Season shape
// ---------------------------------------------------------------------------

export const TOTAL_GAMEWEEKS = 38;

/** Fixture difficulty ratings run 1 (easiest) to 5 (hardest). */
export const FDR_MIN = 1;
export const FDR_MAX = 5;
