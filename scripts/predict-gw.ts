/**
 * Scoreline predictions for a gameweek.
 *
 * Fits Poisson attack/defence on last season's match data (recovered from
 * `.backtest-cache/`, since the `fixtures` table holds only the current season
 * and nothing has been played), then runs `lib/engine/scoreline.ts` over the
 * gameweek's fixtures.
 *
 * A staging post, not the finished feature: the real one fits nightly on
 * accumulated match xG and stores ratings in the database. Reads only.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { readFileSync, readdirSync } from "node:fs";
import { getDb } from "@/lib/db/client";
import { getFixturesFrom, getTeams } from "@/lib/db/queries";
import { getSeasonContext } from "@/lib/fpl/season";
import {
  bothTeamsToScore,
  cleanSheetProbabilities,
  mostLikelyScoreByOutcome,
  outcomeProbabilities,
  overUnder,
  scoreline,
  type TeamStrength,
} from "@/lib/engine/scoreline";

const CACHE = ".backtest-cache";

interface Match {
  home: string;
  away: string;
  homeGoals: number;
  awayGoals: number;
  homeXg: number;
  awayXg: number;
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
    else if (ch === "," && !quoted) { out.push(cell); cell = ""; }
    else cell += ch;
  }
  out.push(cell);
  return out.map((c) => c.trim());
}

/**
 * Player-gameweek rows collapsed into matches.
 *
 * Each fixture appears once per player who featured in it, so grouping by
 * fixture id and reading the score off any row recovers the result; summing
 * `expected_goals` over each side recovers team xG.
 */
function loadMatches(): Match[] {
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

interface Fit {
  leagueMean: number;
  homeAdvantage: number;
  strength: Map<string, TeamStrength>;
}

/**
 * Poisson attack/defence by gradient ascent on the log-likelihood.
 *
 * Concave, so plain ascent finds the optimum; a solver would be a dependency
 * for no gain. Attack and defence are re-centred each step, since only their
 * differences are identified.
 */
function fitStrengths(matches: Match[], target: "goals" | "xg"): Fit {
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
const XG_WEIGHT = 0.65;

function blend(goals: Fit, xg: Fit): Fit {
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

async function main() {
  const season = await getSeasonContext();
  if (!season.available) throw new Error("FPL API unavailable");
  const gw = Number(process.argv[2] ?? season.gameweek.target.id);

  const matches = loadMatches();
  const fit = blend(fitStrengths(matches, "goals"), fitStrengths(matches, "xg"));

  const db = getDb();
  const [teams, fixtures] = await Promise.all([
    getTeams(db),
    getFixturesFrom(db, gw, gw),
  ]);

  /*
   * Promoted sides have no rating, because they were not in the league. The
   * prior is the average of the three teams they replaced — an empirical
   * anchor rather than a guess, and roughly what promoted sides do. It is
   * still the weakest number on this page and every fixture involving one
   * should be read with that in mind.
   */
  const current = new Set(teams.map((t) => t.name));
  const relegated = [...fit.strength.keys()].filter((t) => !current.has(t));
  const promoted = teams.filter((t) => !fit.strength.has(t.name));
  const prior: TeamStrength = {
    attack: mean(relegated.map((t) => fit.strength.get(t)!.attack)),
    defence: mean(relegated.map((t) => fit.strength.get(t)!.defence)),
  };
  const strengthOf = (name: string) => fit.strength.get(name) ?? prior;

  console.log(
    `\nGW${gw} · ratings fitted on ${matches.length} matches of 2025/26 ` +
      `(${(XG_WEIGHT * 100).toFixed(0)}% xG / ${((1 - XG_WEIGHT) * 100).toFixed(0)}% goals)`,
  );
  console.log(
    `league mean ${fit.leagueMean.toFixed(3)} goals/team · ` +
      `home advantage ${(fit.homeAdvantage ** 2).toFixed(3)}x`,
  );
  console.log(
    `promoted (no rating, using the average of ${relegated.join(", ")}): ` +
      `${promoted.map((t) => t.short_name).join(", ")} → ` +
      `attack ${prior.attack.toFixed(2)} defence ${prior.defence.toFixed(2)}\n`,
  );

  const byId = new Map(teams.map((t) => [t.id, t]));
  const pc = (x: number) => `${(x * 100).toFixed(0)}%`.padStart(4);

  const rows = fixtures
    .map((f) => {
      const home = byId.get(f.home_team)!;
      const away = byId.get(f.away_team)!;
      const s = scoreline(strengthOf(home.name), strengthOf(away.name), {
        leagueMean: fit.leagueMean,
        homeAdvantage: fit.homeAdvantage,
      });
      return { f, home, away, s, o: outcomeProbabilities(s) };
    })
    .sort((a, b) => (a.f.kickoff ?? "").localeCompare(b.f.kickoff ?? ""));

  console.log(
    "FIXTURE                    xG        SCORE   P    ROUND  HOME DRAW AWAY   CS(H) CS(A) BTTS  O2.5",
  );
  console.log("-".repeat(100));

  for (const { f, home, away, s, o } of rows) {
    const cs = cleanSheetProbabilities(s);
    // The most likely score inside the outcome the model actually favours.
    // The unconditional mode is 1-1 nearly everywhere and says nothing.
    const byOutcome = mostLikelyScoreByOutcome(s);
    const favoured =
      o.home >= o.draw && o.home >= o.away
        ? byOutcome.home
        : o.away >= o.draw
          ? byOutcome.away
          : byOutcome.draw;
    const guess = promoted.some((p) => p.id === home.id || p.id === away.id)
      ? " ?"
      : "  ";
    console.log(
      `${(home.short_name + " v " + away.short_name).padEnd(12)}${guess} ` +
        `${new Date(f.kickoff!).toUTCString().slice(0, 11)} ` +
        `${s.lambdaHome.toFixed(2)}-${s.lambdaAway.toFixed(2)}  ` +
        `${favoured.home}-${favoured.away} ${pc(favoured.probability)}  ` +
        `${Math.round(s.lambdaHome)}-${Math.round(s.lambdaAway)}   ` +
        `${pc(o.home)} ${pc(o.draw)} ${pc(o.away)}   ` +
        `${pc(cs.home)} ${pc(cs.away)} ${pc(bothTeamsToScore(s))} ` +
        `${pc(overUnder(s, 2.5).over)}`,
    );
  }

  console.log("\n? = a promoted side, rating is a prior rather than a measurement");
  console.log(
    "SCORE = most likely scoreline within the outcome the model favours, and its\n" +
      "        outright probability. ROUND = expected goals, rounded — what a\n" +
      "        pundit would say. CS(H) = home side keeps a clean sheet.\n",
  );
  process.exit(0);
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

void main();
