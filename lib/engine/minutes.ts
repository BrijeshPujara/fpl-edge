import {
  CHANCE_OF_PLAYING_DISCOUNT,
  NO_HISTORY_START_PRIOR,
  P_BENCH_CAMEO,
  P_STARTER_COMPLETES_60,
  START_RATE_WINDOW,
} from "./constants";
import { PLAYER_STATUS } from "@/lib/rules";
import type { PriorSeasonWorkload } from "./prior-season";
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
   * How much the player started LAST season, when there is no history yet.
   *
   * Ignored once this season has appearances — observed beats remembered. Its
   * whole job is the opening weeks, when it is the only thing separating a
   * nailed starter from a squad player.
   */
  priorSeason?: PriorSeasonWorkload | null;
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
): { start: number; cameo: number; samples: number } | null {
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

  // How much was actually seen, so the caller can decide how far to trust it.
  return { start, cameo, samples: size };
}

/**
 * Observed appearances, shrunk toward what came before them.
 *
 * The fallback used to be `observed ?? prior ?? flat`, which let ONE gameweek
 * replace an entire season. Measured the morning GW1 finalised: De Cuyper
 * started once, his start rate went from last season's 0.45 to 1.00, his
 * expected minutes therefore nearly doubled, and — because everything
 * downstream scales with minutes — a £4.6m defender came out projected at 8.8
 * points a gameweek. The optimiser then wanted to take an 8-point hit to buy
 * him.
 *
 * One start is evidence. It is not six. So the observed rate earns weight in
 * proportion to how many gameweeks it actually rests on, over the same window
 * the rate itself is measured over.
 *
 * The shrinkage target is last season where there is one, and the flat prior
 * where there is not — a promoted club's player with one good match is exactly
 * the case that produced the most extreme projections, and he has nothing else
 * behind him.
 */
function shrinkToPrior(
  observed: { start: number; cameo: number; samples: number },
  target: { start: number; cameo: number },
): { start: number; cameo: number } {
  const weight = Math.min(1, observed.samples / START_RATE_WINDOW);
  return {
    start: observed.start * weight + target.start * (1 - weight),
    cameo: observed.cameo * weight + target.cameo * (1 - weight),
  };
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

  /*
   * Role comes from observed appearances, then from last season, and only
   * then from a flat prior.
   *
   * The middle step used to be missing, which made the flat prior the answer
   * for every player until a gameweek had been played — a 3,000-minute
   * ever-present and a fringe squad player both modelled at 41 expected
   * minutes. Everything downstream scales with minutes, so every projection
   * came out roughly half what it should be.
   *
   * A flat prior is still right for a player nobody has data on, which is what
   * a genuine new signing is.
   */
  const prior = input.priorSeason;
  const fallback = prior
    ? {
        start: prior.startRate,
        // Measured from his own minutes, not assumed from a flat rate.
        cameo: prior.cameoRate,
      }
    : {
        start: NO_HISTORY_START_PRIOR,
        cameo: (1 - NO_HISTORY_START_PRIOR) * P_BENCH_CAMEO,
      };

  const observedRates = recentRates(recentStarts, recentMinutes);
  const rates =
    observedRates === null ? fallback : shrinkToPrior(observedRates, fallback);

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

  /*
   * Minutes when playing, shrunk on the same schedule and for the same reason.
   *
   * A single full ninety says "plays ninety" just as loudly as six of them do,
   * and it is the same £4.6m defender either way. Left unshrunk this quietly
   * undid half the fix above: the start rate would be pulled back toward last
   * season while the minutes-per-start stayed pinned at 90.
   */
  const playedMinutes = recentMinutes
    .slice(0, START_RATE_WINDOW)
    .filter((m) => m > 0);
  const priorMinutes = prior?.minutesPerStart ?? 75;
  const meanWhenPlaying =
    playedMinutes.length === 0
      ? priorMinutes
      : (() => {
          const mean =
            playedMinutes.reduce((a, b) => a + b, 0) / playedMinutes.length;
          const weight = Math.min(1, playedMinutes.length / START_RATE_WINDOW);
          return mean * weight + priorMinutes * (1 - weight);
        })();

  const expectedMinutes = pStart * meanWhenPlaying + pCameo * 20;

  return { pAppears, pSixty, pShort, expectedMinutes };
}
