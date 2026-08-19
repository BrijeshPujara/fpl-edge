import {
  CHANCE_OF_PLAYING_DISCOUNT,
  NO_HISTORY_START_PRIOR,
  P_BENCH_CAMEO,
  P_STARTER_COMPLETES_60,
  START_RATE_WINDOW,
} from "./constants";
import { PLAYER_STATUS } from "@/lib/rules";

/**
 * The minutes model.
 *
 * Pure. This is the highest-leverage input in the whole engine and it gets its
 * own module for that reason. A great player at 40% minutes probability is
 * worth less than a nailed average one, and every downstream term — goals,
 * assists, clean sheets, defensive contributions, bonus — is scaled by it. Get
 * this wrong and nothing else can compensate.
 */

export interface MinutesInput {
  /** `status` from the API: a/d/i/s/u. */
  status: string;
  /** `chance_of_playing_next_round`, 0-100, or null when the club says nothing. */
  chanceOfPlayingNextRound: number | null;
  /** Did the player start, per recent gameweek, most recent first. */
  recentStarts: boolean[];
  /** Minutes played per recent gameweek, most recent first. Same ordering. */
  recentMinutes: number[];
}

export interface MinutesProjection {
  /** Probability of appearing at all. */
  pAppears: number;
  /** Probability of reaching 60 minutes — the two-point appearance threshold. */
  pSixty: number;
  /** Probability of appearing but falling short of 60. */
  pShort: number;
  /** Expected minutes, used to scale per-90 rates. */
  expectedMinutes: number;
}

const NEVER: MinutesProjection = {
  pAppears: 0,
  pSixty: 0,
  pShort: 0,
  expectedMinutes: 0,
};

/**
 * Observed start and appearance rates over the recent window.
 *
 * Both matter, and using only the first is the mistake the backtest exposed.
 * "Did not start" and "was not involved at all" are very different states: the
 * first is a genuine cameo risk, the second is a player who is not being
 * selected. Assuming a fixed cameo probability for every non-starter gave
 * appearance points to reserves who had not played in six weeks — and since
 * roughly 62% of all player-gameweek rows are non-appearances, that single
 * assumption dominated the model's error.
 *
 * The cameo rate is therefore observed, not assumed: it is how often this
 * player actually came off the bench.
 */
function recentRates(
  starts: boolean[],
  minutes: number[],
): { start: number; cameo: number } | null {
  const startWindow = starts.slice(0, START_RATE_WINDOW);
  const minuteWindow = minutes.slice(0, START_RATE_WINDOW);
  const size = Math.max(startWindow.length, minuteWindow.length);
  if (size === 0) return null;

  const started = startWindow.filter(Boolean).length;
  const appeared = minuteWindow.filter((m) => m > 0).length;

  const start = started / size;
  // Appearances that were not starts. Floored at zero because the two arrays
  // can disagree at the edges of a short window.
  const cameo = Math.max(0, (appeared - started) / size);

  return { start, cameo };
}

export function projectMinutes(input: MinutesInput): MinutesProjection {
  const { status, chanceOfPlayingNextRound, recentStarts, recentMinutes } = input;

  // Hard zero on anything but available. Suspended and injured players score
  // nothing, and a model that hedges here will happily recommend them.
  if (status !== PLAYER_STATUS.available) return NEVER;

  // FITNESS and ROLE are separate questions, and the API answers only the first.
  //
  // `chance_of_playing_next_round` is a fitness report. Null and 100 mean the
  // same thing — no concern — and neither says whether the player STARTS. Only
  // history answers that. Reading 100 as a positive signal would rank the few
  // players just cleared from injury above every nailed starter with no news.
  const fitness =
    chanceOfPlayingNextRound === null || chanceOfPlayingNextRound >= 100
      ? 1
      : (chanceOfPlayingNextRound / 100) * CHANCE_OF_PLAYING_DISCOUNT;

  // Role comes from observed appearances. With none — a new signing, or
  // pre-season — sit in the middle rather than guessing.
  const rates = recentRates(recentStarts, recentMinutes) ?? {
    start: NO_HISTORY_START_PRIOR,
    cameo: (1 - NO_HISTORY_START_PRIOR) * P_BENCH_CAMEO,
  };

  const pStart = rates.start * fitness;
  const pCameo = rates.cameo * fitness;

  const pSixty = pStart * P_STARTER_COMPLETES_60;
  const pShort = pStart * (1 - P_STARTER_COMPLETES_60) + pCameo;
  const pAppears = pSixty + pShort;

  // Expected minutes from observed history where it exists, so a
  // regularly-substituted starter is not credited with 90.
  const observed = recentMinutes
    .slice(0, START_RATE_WINDOW)
    .filter((m) => m > 0);
  const meanWhenPlaying =
    observed.length > 0
      ? observed.reduce((a, b) => a + b, 0) / observed.length
      : 75;

  const expectedMinutes = pStart * meanWhenPlaying + pCameo * 20;

  return { pAppears, pSixty, pShort, expectedMinutes };
}
