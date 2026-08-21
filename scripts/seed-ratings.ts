/**
 * Seed `team_ratings` from last season.
 *
 * The app fits nothing at request time. It reads ratings that were fitted
 * ahead of it, which is what lets a button press be fast and what makes a
 * prediction reproducible months later — the numbers behind it are on a row,
 * not recomputed from whatever the code does today.
 *
 * Until this season has played matches, "last season" is all there is, so
 * `basis` is written as 'prior-season' and every screen is expected to say so.
 * Once `player_gw_stats` has enough of this season in it, the same fit runs on
 * the database instead and the basis becomes 'blended', then 'this-season'.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { getDb } from "@/lib/db/client";
import { getTeams } from "@/lib/db/queries";
import { saveRatings } from "@/lib/db/ratings";
import { ensureSeason, fitFromCache, PRIOR_SEASONS } from "./ratings";
import { PROMOTED_PRIOR, unratedIn } from "@/lib/engine/team-ratings";
import type { TeamStrength } from "@/lib/engine/scoreline";

async function main() {
  const db = getDb();
  const teams = await getTeams(db);

  // Fetch anything the cache is missing. Idempotent, and a no-op once warm.
  for (const season of PRIOR_SEASONS) {
    const fetched = await ensureSeason(season);
    if (fetched > 0) console.log(`fetched ${fetched} gameweeks of ${season}`);
  }

  const fit = fitFromCache();

  const names = teams.map((t) => t.name);
  const promoted = unratedIn(fit, names);
  const relegated = unratedIn(fit, names, true);
  const prior: TeamStrength = PROMOTED_PRIOR;

  // Re-key from FPL's team name, which is what the historical cache carries,
  // onto team id, which is what every fixture in the database references.
  const strength = new Map<number, TeamStrength>();
  const usesPrior = new Set<number>();
  for (const team of teams) {
    const fitted = fit.strength.get(team.name);
    strength.set(team.id, fitted ?? prior);
    if (fitted === undefined) usesPrior.add(team.id);
  }

  // The prior is written to BOTH sides. It is the effective rating until this
  // season has been played, and it stays on the prior columns forever as the
  // fixed point every later refit blends away from.
  const seeded = { ...fit, strength };
  const written = await saveRatings(db, {
    fit: seeded,
    priorFit: seeded,
    basis: "prior-season",
    blendWeight: 0,
    prior: usesPrior,
  });

  console.log(
    `\nFitted on ${fit.matches} matches across ${PRIOR_SEASONS.join(", ")}.`,
  );
  console.log(
    `league mean ${fit.leagueMean.toFixed(3)} · ` +
      `home advantage ${(fit.homeAdvantage ** 2).toFixed(3)}x\n`,
  );

  const sorted = [...teams].sort(
    (a, b) => strength.get(b.id)!.attack - strength.get(a.id)!.attack,
  );
  for (const team of sorted) {
    const s = strength.get(team.id)!;
    console.log(
      `  ${team.short_name.padEnd(4)} attack ${s.attack.toFixed(2)}  ` +
        `defence ${s.defence.toFixed(2)}` +
        (usesPrior.has(team.id)
          ? "   (promoted — the measured promoted average, not this club)"
          : ""),
    );
  }

  console.log(
    `\nWrote ${written} ratings. ${promoted.length} promoted ` +
      `(${promoted.join(", ")}) priced from what promoted sides average, ` +
      `not from ${relegated.join(", ")}.\n`,
  );
  process.exit(0);
}

void main();
