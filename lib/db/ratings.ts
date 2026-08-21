import "server-only";

import type { Db } from "./client";
import type { TablesInsert } from "./types.generated";
import type { TeamStrength } from "@/lib/engine/scoreline";
import type { RatingFit } from "@/lib/engine/team-ratings";

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
  fit: RatingFit<number>;
  basis: RatingBasis;
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
  const prior = new Set<number>();
  for (const row of data) {
    strength.set(row.team_id, {
      attack: Number(row.attack),
      defence: Number(row.defence),
    });
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
    basis: first.basis as RatingBasis,
    prior,
    updatedAt: data
      .map((r) => r.updated_at)
      .sort()
      .at(-1)!,
  };
}

export interface SaveRatingsInput {
  fit: RatingFit<number>;
  basis: RatingBasis;
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
      matches: input.fit.matches,
      is_prior: input.prior.has(teamId),
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
