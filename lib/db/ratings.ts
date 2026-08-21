import "server-only";

import type { Db } from "./client";
import type { TablesInsert } from "./types.generated";
import type { TeamStrength } from "@/lib/engine/scoreline";
import {
  basisFor,
  blendSeasons,
  blendWeight,
  fitRatings,
  recencyWeights,
  PROMOTED_PRIOR,
  type RatingFit,
} from "@/lib/engine/team-ratings";
import { getPlayedMatches, matchesPerTeam } from "./match-history";
import { getTeams } from "./queries";

/**
 * Team ratings, stored as a set.
 *
 * Attack and defence are only meaningful against the league mean and home
 * advantage they were fitted with — so all twenty rows plus both scalars are
 * written in one transaction and read back together. Updating a single club
 * would leave a rating from one fit sitting beside a scale from another, and
 * nothing downstream could detect it.
 */

export type RatingBasis = "prior-season" | "blended" | "this-season";

export interface StoredRatings {
  /** What predictions use: last season blended toward this one. */
  fit: RatingFit<number>;
  /**
   * Last season alone, untouched by any refit.
   *
   * Kept because each refit blends against LAST SEASON, never against the
   * previous refit's output. Blending against the output would compound —
   * every refit dragging the ratings further from both seasons, silently.
   */
  priorFit: RatingFit<number> | null;
  basis: RatingBasis;
  /** How much this season counted, 0 to 1. */
  blendWeight: number;
  /** Clubs carrying the promoted prior rather than a fitted rating. */
  prior: Set<number>;
  updatedAt: string;
}

/** Everything needed to price a fixture, or null when nothing is stored. */
export async function getRatings(db: Db): Promise<StoredRatings | null> {
  const { data, error } = await db.from("team_ratings").select("*");
  if (error) throw new Error(`Failed to read ratings: ${error.message}`);
  if (!data || data.length === 0) return null;

  const strength = new Map<number, TeamStrength>();
  const priorStrength = new Map<number, TeamStrength>();
  const prior = new Set<number>();

  for (const row of data) {
    strength.set(row.team_id, {
      attack: Number(row.attack),
      defence: Number(row.defence),
    });
    if (row.prior_attack !== null && row.prior_defence !== null) {
      priorStrength.set(row.team_id, {
        attack: Number(row.prior_attack),
        defence: Number(row.prior_defence),
      });
    }
    if (row.is_prior) prior.add(row.team_id);
  }

  // The scalars are identical across rows by construction, so any row will do.
  const [first] = data;
  return {
    fit: {
      leagueMean: Number(first.league_mean),
      homeAdvantage: Number(first.home_advantage),
      strength,
      matches: first.matches,
    },
    priorFit:
      priorStrength.size > 0 && first.prior_league_mean !== null
        ? {
            leagueMean: Number(first.prior_league_mean),
            homeAdvantage: Number(first.prior_home_advantage),
            strength: priorStrength,
            matches: 0,
          }
        : null,
    basis: first.basis as RatingBasis,
    blendWeight: Number(first.blend_weight),
    prior,
    updatedAt: data
      .map((r) => r.updated_at)
      .sort()
      .at(-1)!,
  };
}

export interface SaveRatingsInput {
  /** The effective ratings, which predictions read. */
  fit: RatingFit<number>;
  /** Last season alone. Written on every save so it is never lost. */
  priorFit: RatingFit<number>;
  basis: RatingBasis;
  blendWeight: number;
  /** Clubs whose rating is the promoted prior rather than a measurement. */
  prior: Set<number>;
}

/**
 * Replace every rating.
 *
 * Deletes first rather than upserting, so a club that has left the league does
 * not linger with a stale rating that a future fixture could quietly pick up.
 */
export async function saveRatings(
  db: Db,
  input: SaveRatingsInput,
): Promise<number> {
  const rows: TablesInsert<"team_ratings">[] = [...input.fit.strength].map(
    ([teamId, strength]) => ({
      team_id: teamId,
      attack: strength.attack,
      defence: strength.defence,
      league_mean: input.fit.leagueMean,
      home_advantage: input.fit.homeAdvantage,
      basis: input.basis,
      blend_weight: input.blendWeight,
      matches: input.fit.matches,
      is_prior: input.prior.has(teamId),
      prior_attack: input.priorFit.strength.get(teamId)?.attack ?? null,
      prior_defence: input.priorFit.strength.get(teamId)?.defence ?? null,
      prior_league_mean: input.priorFit.leagueMean,
      prior_home_advantage: input.priorFit.homeAdvantage,
    }),
  );
  if (rows.length === 0) return 0;

  const { error: clearError } = await db
    .from("team_ratings")
    .delete()
    .gte("team_id", 0);
  if (clearError) {
    throw new Error(`Failed to clear ratings: ${clearError.message}`);
  }

  const { error } = await db.from("team_ratings").insert(rows);
  if (error) throw new Error(`Failed to save ratings: ${error.message}`);
  return rows.length;
}

export type RefitResult =
  | { status: "no-prior" }
  | { status: "refitted"; matches: number; perTeam: number; weight: number; basis: RatingBasis };

/**
 * Move the stored ratings toward this season.
 *
 * Runs on the sync, after results land. Fits this season's played matches from
 * the app's own tables and blends them with last season on the measured
 * schedule — see `RATING_BLEND_MATCHES`.
 *
 * Always blends against the STORED PRIOR, never against what the last refit
 * wrote. That is the whole reason the prior has its own columns: blending
 * against the previous output would compound every run, walking the ratings
 * away from both seasons with nothing able to notice.
 *
 * A no-op with nothing played, which is not an error — it is September.
 */
export async function refitRatings(db: Db): Promise<RefitResult> {
  const stored = await getRatings(db);
  if (stored === null || stored.priorFit === null) return { status: "no-prior" };

  const matches = await getPlayedMatches(db);
  const perTeam = matchesPerTeam(matches);
  const weight = blendWeight(perTeam);

  /*
   * Form. Recent matches count for more, on a measured half-life — a side
   * that started badly and has since turned it around should not be rated on
   * the average of the two.
   *
   * The most recent gameweek in the data is "now" rather than the live
   * gameweek, because a refit runs right after results land and the open
   * gameweek has by definition contributed nothing yet. Using the open one
   * would age every match by one for no reason.
   */
  const latestGw = matches.reduce((max, m) => Math.max(max, m.gw ?? 0), 0);
  const weighted = recencyWeights(matches, (m) => m.gw ?? null, latestGw);

  const current = fitRatings(weighted);
  const blended = blendSeasons(stored.priorFit, current, weight);

  // A club with no rating on either side still needs one, or its fixtures
  // cannot be priced at all.
  const teams = await getTeams(db);
  const fallback = PROMOTED_PRIOR;
  const missing = new Set<number>();
  for (const team of teams) {
    if (!blended.strength.has(team.id)) {
      blended.strength.set(team.id, fallback);
      missing.add(team.id);
    }
  }

  // A promoted side stops being a guess once it has played enough of its own
  // football to be fitted on.
  const stillPrior = new Set(
    [...stored.prior].filter((id) => !current.strength.has(id) || weight === 0),
  );
  for (const id of missing) stillPrior.add(id);

  const basis = basisFor(weight);
  await saveRatings(db, {
    fit: { ...blended, matches: matches.length },
    priorFit: stored.priorFit,
    basis,
    blendWeight: weight,
    prior: stillPrior,
  });

  return { status: "refitted", matches: matches.length, perTeam, weight, basis };
}
