import {
  FORM_HALF_LIFE_GAMEWEEKS,
  RATING_BLEND_MATCHES,
} from "./constants";
import type { TeamStrength } from "./scoreline";

/**
 * Fitting attack and defence from played matches.
 *
 * Pure, and generic over how a club is identified — the scripts key on FPL's
 * team name because that is what the historical cache carries, and the app
 * keys on team id. Baking either in would force a conversion at one of the two
 * boundaries, and conversions between identifiers are where this codebase has
 * already been bitten once (season history is keyed on player CODE precisely
 * because FPL renumbers ids between seasons).
 *
 * The model is the standard one: each club gets an attack and a defence, goals
 * are Poisson around their product, and home advantage is a single league-wide
 * term. Fitted by gradient ascent on the log-likelihood, which is concave — a
 * solver would be a dependency for no gain.
 *
 * WHAT IT IS FITTED ON MATTERS MORE THAN THE MODEL. Measured over 280 held-out
 * matches of 2025/26, ratings fitted on xG beat ratings fitted on goals
 * (RPS 0.2105 against 0.2147), and blending the two beats either alone. Goals
 * are what happened; xG is a better estimate of what the teams are. Neither is
 * the thing you want on its own.
 */

export interface MatchResult<K = string> {
  home: K;
  away: K;
  homeGoals: number;
  awayGoals: number;
  homeXg: number;
  awayXg: number;
  /**
   * How much this match counts, relative to the others. Absent means one.
   *
   * This is where form lives. Recent football tells you more about a side
   * than early-season football, and rather than bolting a separate form term
   * onto the ratings, the ratings are simply fitted with recent matches
   * weighted up — see `recencyWeights`.
   */
  weight?: number;
}

export interface RatingFit<K = string> {
  /** League-average goals per team per match, at the geometric centre. */
  leagueMean: number;
  /**
   * Half-step venue multiplier — the ratio between the sides is its SQUARE.
   * Shares the convention of `HOME_ADVANTAGE` and `ScorelineOptions`, so it
   * can be passed straight through without conversion.
   */
  homeAdvantage: number;
  strength: Map<K, TeamStrength>;
  /** How many matches the fit saw. */
  matches: number;
}

export type FitTarget = "goals" | "xg";

export interface FitOptions {
  /**
   * Ridge penalty on the ratings.
   *
   * Not decoration: without it a club that has played six matches and won them
   * all gets an unbounded attack rating, because the likelihood is maximised
   * by sending it to infinity. This pulls every rating toward league average
   * by an amount that matters early in a season and stops mattering later,
   * which is exactly when it should.
   */
  ridge?: number;
  iterations?: number;
  learningRate?: number;
}

const DEFAULTS = { ridge: 0.02, iterations: 4000, learningRate: 0.05 };

export function fitTeamStrengths<K>(
  matches: MatchResult<K>[],
  target: FitTarget,
  options: FitOptions = {},
): RatingFit<K> {
  const ridge = options.ridge ?? DEFAULTS.ridge;
  const iterations = options.iterations ?? DEFAULTS.iterations;
  const learningRate = options.learningRate ?? DEFAULTS.learningRate;

  const teams = [...new Set(matches.flatMap((m) => [m.home, m.away]))];
  const index = new Map(teams.map((t, i) => [t, i]));
  const n = teams.length;

  const attack = new Array<number>(n).fill(0);
  const defence = new Array<number>(n).fill(0);

  const yHome = matches.map((m) => (target === "goals" ? m.homeGoals : m.homeXg));
  const yAway = matches.map((m) => (target === "goals" ? m.awayGoals : m.awayXg));

  /*
   * Weights normalised to average one.
   *
   * Not cosmetic: the gradient step and the ridge penalty are both scaled by
   * the match count, so raw weights that happened to average 0.3 would shrink
   * the effective learning rate and inflate the ridge, and the fit would come
   * out flatter than asked for. Normalising keeps a weighted fit comparable to
   * an unweighted one.
   */
  const raw = matches.map((m) =>
    m.weight === undefined || !Number.isFinite(m.weight) || m.weight < 0
      ? 1
      : m.weight,
  );
  const rawTotal = raw.reduce((a, b) => a + b, 0);
  const weights =
    rawTotal > 0
      ? raw.map((w) => (w * matches.length) / rawTotal)
      : raw.map(() => 1);

  const totalGoals = yHome.reduce((a, b) => a + b, 0) + yAway.reduce((a, b) => a + b, 0);
  if (matches.length === 0 || totalGoals <= 0) {
    // Nothing to fit. Everyone is average, which is honest rather than
    // arbitrary — and `basis` tells the caller not to trust it.
    return {
      leagueMean: 0,
      homeAdvantage: 1,
      strength: new Map(teams.map((t) => [t, { attack: 1, defence: 1 }])),
      matches: matches.length,
    };
  }

  const weightedGoals = matches.reduce(
    (sum, _, k) => sum + weights[k] * (yHome[k] + yAway[k]),
    0,
  );
  let mu = Math.log(Math.max(weightedGoals, 1e-9) / (2 * matches.length));
  let hfa = 0.2;

  for (let step = 0; step < iterations; step++) {
    const gAttack = new Array<number>(n).fill(0);
    const gDefence = new Array<number>(n).fill(0);
    let gMu = 0;
    let gHfa = 0;

    matches.forEach((m, k) => {
      const h = index.get(m.home)!;
      const a = index.get(m.away)!;
      const lambdaHome = Math.exp(mu + attack[h] - defence[a] + hfa);
      const lambdaAway = Math.exp(mu + attack[a] - defence[h]);
      // For a Poisson with a log link the gradient of the log-likelihood with
      // respect to the linear predictor is just the residual.
      const w = weights[k];
      const rHome = w * (yHome[k] - lambdaHome);
      const rAway = w * (yAway[k] - lambdaAway);

      gMu += rHome + rAway;
      gHfa += rHome;
      gAttack[h] += rHome;
      gAttack[a] += rAway;
      gDefence[a] -= rHome;
      gDefence[h] -= rAway;
    });

    const scale = learningRate / matches.length;
    mu += scale * gMu;
    hfa += scale * gHfa;
    for (let i = 0; i < n; i++) {
      attack[i] += scale * (gAttack[i] - 2 * ridge * attack[i]);
      defence[i] += scale * (gDefence[i] - 2 * ridge * defence[i]);
    }
    // Only the DIFFERENCES between ratings are identified — adding a constant
    // to every attack and subtracting it from every defence leaves the
    // likelihood unchanged. Re-centring each step pins the solution.
    recentre(attack);
    recentre(defence);
  }

  return {
    leagueMean: Math.exp(mu + hfa / 2),
    homeAdvantage: Math.exp(hfa / 2),
    strength: new Map(
      teams.map((t) => [
        t,
        {
          attack: Math.exp(attack[index.get(t)!]),
          // Higher means worse, so the sign flips.
          defence: Math.exp(-defence[index.get(t)!]),
        },
      ]),
    ),
    matches: matches.length,
  };
}

function recentre(values: number[]): void {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  for (let i = 0; i < values.length; i++) values[i] -= mean;
}

/** Measured on 2025/26: xG carries roughly twice the weight of goals. */
export const XG_WEIGHT = 0.65;

/**
 * Interpolate between two multiplicative ratings.
 *
 * GEOMETRIC, not arithmetic — `a^(1-w) * b^w`. Ratings are multipliers whose
 * geometric mean the fit pins to exactly 1, and arithmetic mixing does not
 * preserve that: average two centred sets and the result drifts off centre,
 * which quietly shifts every expected goal in the league.
 */
export function interpolate(a: number, b: number, weight: number): number {
  if (a <= 0 || b <= 0) return (1 - weight) * a + weight * b;
  return Math.exp((1 - weight) * Math.log(a) + weight * Math.log(b));
}

export function blendFits<K>(
  goals: RatingFit<K>,
  xg: RatingFit<K>,
  xgWeight = XG_WEIGHT,
): RatingFit<K> {
  const mix = (a: number, b: number) => interpolate(a, b, xgWeight);
  const strength = new Map<K, TeamStrength>();

  for (const [team, g] of goals.strength) {
    const x = xg.strength.get(team);
    strength.set(
      team,
      x === undefined
        ? g
        : { attack: mix(g.attack, x.attack), defence: mix(g.defence, x.defence) },
    );
  }

  return {
    leagueMean: mix(goals.leagueMean, xg.leagueMean),
    homeAdvantage: mix(goals.homeAdvantage, xg.homeAdvantage),
    strength,
    matches: goals.matches,
  };
}

/** Fit both targets and blend, which is the combination that measured best. */
export function fitRatings<K>(
  matches: MatchResult<K>[],
  options: FitOptions = {},
): RatingFit<K> {
  return blendFits(
    fitTeamStrengths(matches, "goals", options),
    fitTeamStrengths(matches, "xg", options),
  );
}

/**
 * What a newly promoted side is worth.
 *
 * MEASURED, not inferred from whoever went down. The previous version averaged
 * the clubs the promoted sides replaced, and that was wrong in a way worth
 * recording, because it looked reasonable:
 *
 *     season    prior said          they actually were   error
 *     2023/24   atk 0.86 def 1.28   atk 0.72 def 1.34    atk +0.14
 *     2024/25   atk 0.72 def 1.34   atk 0.63 def 1.46    atk +0.08
 *     2025/26   atk 0.63 def 1.46   atk 0.81 def 1.14    atk -0.18 def +0.31
 *
 * Each year's prior was the previous year's relegated cohort — three clubs,
 * themselves an extreme sample — so the estimate performed a random walk
 * rather than converging. By 2025/26 it had wandered to 0.63 attack and met a
 * promoted group averaging 0.81, of which Leeds at 1.01 was flatly average for
 * the division.
 *
 * These numbers are the mean of what promoted sides ACTUALLY did across those
 * three seasons — nine clubs rather than three, and measuring the quantity in
 * question rather than a proxy for it. Swapping one for the other never scored
 * worse and improved 2025/26 by 0.0011 RPS over gameweeks 1-19 (t = -1.83).
 *
 * Suggestive, not conclusive. It is adopted because the MECHANISM is sound —
 * nine observations of the right thing beat three of a proxy — and because it
 * cannot do harm, not because the p-value cleared a bar.
 */
export const PROMOTED_PRIOR: TeamStrength = { attack: 0.72, defence: 1.31 };

/**
 * Clubs on one side of the fit but not the other.
 *
 * `departed` picks the direction: true for sides in the fit that are no longer
 * in the league (relegated), false for sides in the league the fit never saw
 * (promoted).
 */
export function unratedIn<K>(
  fit: RatingFit<K>,
  current: Iterable<K>,
  departed = false,
): K[] {
  const now = new Set(current);
  if (departed) return [...fit.strength.keys()].filter((t) => !now.has(t));
  return [...now].filter((t) => !fit.strength.has(t));
}

/**
 * How much this season's ratings should count, given how much has been played.
 *
 * Linear from nothing to everything over `RATING_BLEND_MATCHES` matches per
 * club — see that constant for the sweep this came out of. Takes matches PER
 * CLUB rather than a gameweek number, so a blank or a double counts for what
 * it actually is and the schedule needs no special case for either.
 */
export function blendWeight(matchesPerTeam: number): number {
  if (!Number.isFinite(matchesPerTeam) || matchesPerTeam <= 0) return 0;
  return Math.min(1, matchesPerTeam / RATING_BLEND_MATCHES);
}

/**
 * Last season's ratings moving toward this season's as evidence accumulates.
 *
 * A club present in only one of the two keeps whichever rating exists rather
 * than being dragged toward a number that was never about it — a promoted side
 * has no prior, and a relegated one has no current.
 */
export function blendSeasons<K>(
  prior: RatingFit<K>,
  current: RatingFit<K>,
  weight: number,
): RatingFit<K> {
  const strength = new Map<K, TeamStrength>();

  for (const key of new Set([...prior.strength.keys(), ...current.strength.keys()])) {
    const before = prior.strength.get(key);
    const now = current.strength.get(key);
    if (before === undefined || now === undefined) {
      strength.set(key, (now ?? before)!);
      continue;
    }
    strength.set(key, {
      attack: interpolate(before.attack, now.attack, weight),
      defence: interpolate(before.defence, now.defence, weight),
    });
  }

  return {
    leagueMean: interpolate(prior.leagueMean, current.leagueMean, weight),
    homeAdvantage: interpolate(
      prior.homeAdvantage,
      current.homeAdvantage,
      weight,
    ),
    strength,
    matches: current.matches,
  };
}

/** What `basis` a blend weight amounts to, for the screens to report. */
export function basisFor(weight: number): "prior-season" | "blended" | "this-season" {
  if (weight <= 0) return "prior-season";
  if (weight >= 1) return "this-season";
  return "blended";
}

/**
 * Match weights that decay with age, so recent form counts for more.
 *
 * Exponential, with a half-life in gameweeks — a match `FORM_HALF_LIFE_GAMEWEEKS`
 * old counts half as much as one played this week. See that constant for the
 * sweep it came out of, including the negative result: a five-gameweek
 * half-life is worse than no decay at all, so chasing the last month is not
 * the same thing as respecting form.
 *
 * Matches with no gameweek, and any in the future, are treated as current
 * rather than dropped — a null gameweek means a postponed fixture whose data
 * arrived anyway, and guessing it is old would silently discount real
 * evidence.
 */
export function recencyWeights<T extends MatchResult<unknown>>(
  matches: T[],
  gameweekOf: (match: T) => number | null,
  currentGameweek: number,
  halfLife = FORM_HALF_LIFE_GAMEWEEKS,
): (T & { weight: number })[] {
  // Every match comes back carrying a weight, including when decay is off —
  // the type says so rather than leaving callers to check.
  if (halfLife <= 0) return matches.map((match) => ({ ...match, weight: 1 }));

  return matches.map((match) => {
    const gw = gameweekOf(match);
    const age = gw === null ? 0 : Math.max(0, currentGameweek - gw);
    return { ...match, weight: 0.5 ** (age / halfLife) };
  });
}
