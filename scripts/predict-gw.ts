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
import {
  fitRatings,
  promotedPrior,
  relegatedFrom,
  XG_WEIGHT,
} from "./ratings";

async function main() {
  const season = await getSeasonContext();
  if (!season.available) throw new Error("FPL API unavailable");
  const gw = Number(process.argv[2] ?? season.gameweek.target.id);

  const fit = fitRatings();

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
  const names = teams.map((t) => t.name);
  const relegated = relegatedFrom(fit, names);
  const promoted = teams.filter((t) => !fit.strength.has(t.name));
  const prior: TeamStrength = promotedPrior(fit, names);
  const strengthOf = (name: string) => fit.strength.get(name) ?? prior;

  console.log(
    `\nGW${gw} · ratings fitted on 2025/26 ` +
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


void main();
