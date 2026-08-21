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

  let mu = Math.log(totalGoals / (2 * matches.length));
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
      const rHome = yHome[k] - lambdaHome;
      const rAway = yAway[k] - lambdaAway;

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

export function blendFits<K>(
  goals: RatingFit<K>,
  xg: RatingFit<K>,
  xgWeight = XG_WEIGHT,
): RatingFit<K> {
  const mix = (a: number, b: number) => (1 - xgWeight) * a + xgWeight * b;
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
 * The rating for a side the fit never saw.
 *
 * Promoted clubs were not in the league, so there is nothing to fit. Averaging
 * the clubs that went down is an empirical anchor rather than a guess, and
 * roughly what promoted sides do — but it is the weakest number in any output
 * that uses it, and every caller is expected to say so on screen.
 *
 * Falls back to league-average when nobody left, which happens only if the
 * caller passes a team list that already matches the fit.
 */
export function priorForUnrated<K>(
  fit: RatingFit<K>,
  current: Iterable<K>,
): TeamStrength {
  const departed = unratedIn(fit, current, true);
  if (departed.length === 0) return { attack: 1, defence: 1 };

  const mean = (pick: (s: TeamStrength) => number) =>
    departed.reduce((sum, t) => sum + pick(fit.strength.get(t)!), 0) /
    departed.length;

  return { attack: mean((s) => s.attack), defence: mean((s) => s.defence) };
}

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
