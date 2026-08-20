import {
  CHANCE_OF_PLAYING_DISCOUNT,
  NO_HISTORY_START_PRIOR,
  P_BENCH_CAMEO,
  P_STARTER_COMPLETES_60,
  START_RATE_WINDOW,
} from "./constants";
import { PLAYER_STATUS } from "@/lib/rules";
import { clampNewsMultiplier } from "./news-signal";

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
  /**
   * Bounded multiplier from team news, defaulting to 1 — no adjustment.
   *
   * This is the seam for anything that reads words rather than numbers: the
   * deterministic classifier in `news-signal.ts`, or a language model reading a
   * press conference. It is clamped here as well as at the source, because the
   * most sensitive input in the engine should not depend on a caller
   * remembering to be careful.
   */
  newsMultiplier?: number;
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

  // Hard zero only where the player CANNOT play. Suspension and unavailability
  // — left the club, not registered — are absolute, and no fitness percentage
  // can argue with them.
  //
  // Injury and doubt are not absolute, and this used to zero them too. That was
  // wrong, and measurably so. Against live data: every injured, suspended and
  // unavailable player carries `chance_of_playing_next_round: 0`, so the
  // fitness term below zeroes them anyway and the status check was redundant.
  // Doubtful players carry 25 to 75, mean 70 — FPL is explicitly saying most of
  // them will play, and hard-zeroing 28 players the game rates at 70% both
  // hides real candidates and, worse, tells you to panic-sell anyone in your
  // own squad who picks up a knock.
  //
  // So: trust the percentage where the game gives one, and refuse only what is
  // genuinely impossible.
  if (
    status === PLAYER_STATUS.suspended ||
    status === PLAYER_STATUS.unavailable
  ) {
    return NEVER;
  }

  // FITNESS and ROLE are separate questions, and the API answers only the first.
  //
  // `chance_of_playing_next_round` is a fitness report. Null and 100 mean the
  // same thing — no concern — and neither says whether the player STARTS. Only
  // history answers that. Reading 100 as a positive signal would rank the few
  // players just cleared from injury above every nailed starter with no news.
  if (chanceOfPlayingNextRound === 0) return NEVER;

  // A flagged player with no percentage attached is not a fit player. For an
  // available player null means "no concern"; for a doubtful or injured one it
  // means the club has not said, and the harm is asymmetric — reading silence
  // as fitness buys an injured player, reading it as absence merely skips one.
  const flagged = status !== PLAYER_STATUS.available;
  if (flagged && chanceOfPlayingNextRound === null) return NEVER;

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

  // News multiplies fitness rather than replacing it, so a club percentage and
  // a news category compose: 75% fitness and a match-fitness note is a player
  // who is both doubtful AND likely to be eased in, and both facts count.
  const news = clampNewsMultiplier(input.newsMultiplier ?? 1);
  const adjusted = fitness * news;

  const pStart = rates.start * adjusted;
  const pCameo = rates.cameo * adjusted;

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
