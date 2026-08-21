/**
 * Team attack and defence ratings, fitted from last season's matches.
 *
 * A staging post. The finished feature fits nightly on accumulated match xG
 * and stores the result in the database; this recovers the same thing from
 * `.backtest-cache/`, which is the only place match results currently live —
 * the `fixtures` table holds this season only, and nothing has been played.
 *
 * Shared by the scripts that need ratings rather than duplicated into each.
 */
import { readFileSync, readdirSync } from "node:fs";
import type { TeamStrength } from "@/lib/engine/scoreline";

const CACHE = ".backtest-cache";

export interface Match {
  home: string;
  away: string;
  homeGoals: number;
  awayGoals: number;
  homeXg: number;
  awayXg: number;
}

export interface Fit {
  leagueMean: number;
  /** Half-step, matching the convention in `scoreline.ts`. */
  homeAdvantage: number;
  strength: Map<string, TeamStrength>;
}

/** Minimal CSV reader — the cache is machine-written and well formed. */
function readCsv(path: string): Record<string, string>[] {
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  const header = splitRow(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitRow(line);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
  });
}

function splitRow(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.push(cell);
      cell = "";
    } else cell += ch;
  }
  out.push(cell);
  return out.map((c) => c.trim());
}

/**
 * Player-gameweek rows collapsed into matches.
 *
 * Each fixture appears once per player who featured in it, so grouping by
 * fixture id and reading the score off any row recovers the result, and
 * summing `expected_goals` over each side recovers team xG.
 */
export function loadMatches(): Match[] {
  const byFixture = new Map<string, Record<string, string>[]>();

  for (const file of readdirSync(CACHE)) {
    if (!/^gw\d+\.csv$/.test(file)) continue;
    for (const row of readCsv(`${CACHE}/${file}`)) {
      const key = `${row.round}:${row.fixture}`;
      byFixture.set(key, [...(byFixture.get(key) ?? []), row]);
    }
  }

  const matches: Match[] = [];
  for (const rows of byFixture.values()) {
    const home = new Set<string>();
    const away = new Set<string>();
    let homeXg = 0;
    let awayXg = 0;

    for (const row of rows) {
      const isHome = row.was_home.toLowerCase() === "true";
      (isHome ? home : away).add(row.team);
      const xg = Number(row.expected_goals) || 0;
      if (isHome) homeXg += xg;
      else awayXg += xg;
    }
    // A fixture with players attributed to more than one club a side is
    // corrupt; skip rather than fit on it.
    if (home.size !== 1 || away.size !== 1) continue;

    matches.push({
      home: [...home][0],
      away: [...away][0],
      homeGoals: Number(rows[0].team_h_score),
      awayGoals: Number(rows[0].team_a_score),
      homeXg,
      awayXg,
    });
  }
  return matches;
}

/**
 * Poisson attack/defence by gradient ascent on the log-likelihood.
 *
 * Concave, so plain ascent finds the optimum and a solver would be a
 * dependency for no gain. Attack and defence are re-centred each step, since
 * only their differences are identified.
 */
export function fitStrengths(
  matches: Match[],
  target: "goals" | "xg",
): Fit {
  const teams = [...new Set(matches.flatMap((m) => [m.home, m.away]))].sort();
  const index = new Map(teams.map((t, i) => [t, i]));
  const n = teams.length;

  const attack = new Array<number>(n).fill(0);
  const defence = new Array<number>(n).fill(0);
  const yHome = matches.map((m) => (target === "goals" ? m.homeGoals : m.homeXg));
  const yAway = matches.map((m) => (target === "goals" ? m.awayGoals : m.awayXg));

  let mu = Math.log(
    (yHome.reduce((a, b) => a + b, 0) + yAway.reduce((a, b) => a + b, 0)) /
      (2 * matches.length),
  );
  let hfa = 0.2;

  const RIDGE = 0.02;
  const LR = 0.05;

  for (let step = 0; step < 4000; step++) {
    const gAttack = new Array<number>(n).fill(0);
    const gDefence = new Array<number>(n).fill(0);
    let gMu = 0;
    let gHfa = 0;

    matches.forEach((m, k) => {
      const h = index.get(m.home)!;
      const a = index.get(m.away)!;
      const lh = Math.exp(mu + attack[h] - defence[a] + hfa);
      const la = Math.exp(mu + attack[a] - defence[h]);
      const rh = yHome[k] - lh;
      const ra = yAway[k] - la;

      gMu += rh + ra;
      gHfa += rh;
      gAttack[h] += rh;
      gAttack[a] += ra;
      gDefence[a] -= rh;
      gDefence[h] -= ra;
    });

    const scale = LR / matches.length;
    mu += scale * gMu;
    hfa += scale * gHfa;
    for (let i = 0; i < n; i++) {
      attack[i] += scale * (gAttack[i] - 2 * RIDGE * attack[i]);
      defence[i] += scale * (gDefence[i] - 2 * RIDGE * defence[i]);
    }
    recentre(attack);
    recentre(defence);
  }

  return {
    // The module keeps the league mean at the geometric centre and splits the
    // venue effect either side of it, so the fit is converted to match.
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
  };
}

function recentre(values: number[]): void {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  for (let i = 0; i < values.length; i++) values[i] -= mean;
}

/** Measured on 2025/26: xG carries roughly twice the weight of goals. */
export const XG_WEIGHT = 0.65;

export function blend(goals: Fit, xg: Fit): Fit {
  const mix = (a: number, b: number) => (1 - XG_WEIGHT) * a + XG_WEIGHT * b;
  const strength = new Map<string, TeamStrength>();
  for (const [team, g] of goals.strength) {
    const x = xg.strength.get(team)!;
    strength.set(team, {
      attack: mix(g.attack, x.attack),
      defence: mix(g.defence, x.defence),
    });
  }
  return {
    leagueMean: mix(goals.leagueMean, xg.leagueMean),
    homeAdvantage: mix(goals.homeAdvantage, xg.homeAdvantage),
    strength,
  };
}

/** Everything, fitted and blended. */
export function fitRatings(): Fit {
  const matches = loadMatches();
  return blend(fitStrengths(matches, "goals"), fitStrengths(matches, "xg"));
}

/**
 * The prior for a side with no rating, from the teams it replaced.
 *
 * Promoted sides were not in the league, so there is nothing to fit. Averaging
 * the three that went down is an empirical anchor rather than a guess, and
 * roughly what promoted sides do — but it is still the weakest number in any
 * output that uses it, and callers should say so.
 */
export function promotedPrior(fit: Fit, currentTeams: string[]): TeamStrength {
  const current = new Set(currentTeams);
  const relegated = [...fit.strength.keys()].filter((t) => !current.has(t));
  const mean = (values: number[]) =>
    values.reduce((a, b) => a + b, 0) / values.length;

  return {
    attack: mean(relegated.map((t) => fit.strength.get(t)!.attack)),
    defence: mean(relegated.map((t) => fit.strength.get(t)!.defence)),
  };
}

/** Which of last season's sides are no longer in the league. */
export function relegatedFrom(fit: Fit, currentTeams: string[]): string[] {
  const current = new Set(currentTeams);
  return [...fit.strength.keys()].filter((t) => !current.has(t));
}
