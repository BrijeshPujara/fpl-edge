import "server-only";

import type { Db } from "./client";
import type { Tables, TablesInsert } from "./types.generated";
import { getRatings } from "./ratings";
import { getFixturesFrom, getTeams } from "./queries";
import {
  bothTeamsToScore,
  cleanSheetProbabilities,
  logLoss,
  expectedScoreByOutcome,
  outcomeOf,
  outcomeProbabilities,
  overUnder,
  rankedProbabilityScore,
  scoreline,
  type MatchOutcome,
  type TeamStrength,
} from "@/lib/engine/scoreline";
import { PROMOTED_PRIOR } from "@/lib/engine/team-ratings";

/**
 * Scoreline predictions, recorded and scored.
 *
 * The same discipline as the decision journal, for the same reason: a
 * prediction nobody scores is an opinion. Two rules make the record worth
 * keeping, and both are enforced here rather than trusted to callers.
 *
 *   1. NOTHING IS PREDICTED AFTER KICKOFF. A fixture that has started is
 *      skipped, so no row can ever be written with knowledge of the result.
 *      This is the whole basis of the record; without it the table is a log of
 *      hindsight and every accuracy figure computed from it is a lie.
 *
 *   2. Regenerating REPLACES rather than appends. The row that survives a
 *      kickoff is the last thing the model said while it could still be wrong.
 */

export type PredictionRow = Tables<"predictions">;

/** One entry of `predictions.likely_scores`: the likeliest score for one result. */
export interface LikelyScore {
  outcome: MatchOutcome;
  home: number;
  away: number;
  p: number;
}

/*
 * One scoreline per result, rather than the three likeliest overall.
 *
 * The three likeliest overall are marginally more accurate as a set — over 560
 * held-out matches across two seasons, right 30.9% of the time against 27.1% —
 * and they are unusable, because the leading one is 1-1 in 74.6% of fixtures.
 * A panel that says "1-1" beside "61% home win" reads as broken even when both
 * numbers are correct, and a reader cannot tell which result each of three
 * near-identical draws belongs to.
 *
 * One per result costs 3.8 points of set accuracy and buys a row where every
 * cell means something the reader asked for: if it is a home win, 2-1; if a
 * draw, 1-1; if away, 1-2. The leading cell is 1-1 in 0.5% of fixtures, and
 * only when a draw is genuinely the likeliest result.
 */

/** Read the stored scorelines, whatever PostgREST hands back. */
export function likelyScoresOf(row: PredictionRow): LikelyScore[] {
  const raw = row.likely_scores;
  if (!Array.isArray(raw)) return [];

  // Rows written before this column existed carry an empty array, and jsonb
  // is untyped by definition — so the shape is checked rather than asserted.
  return (raw as unknown[]).filter(
    (entry): entry is LikelyScore =>
      typeof entry === "object" &&
      entry !== null &&
      "home" in entry &&
      "away" in entry &&
      "p" in entry &&
      "outcome" in entry,
  );
}
export type PredictionOutcomeRow = Tables<"prediction_outcomes">;

export interface PredictedFixture {
  prediction: PredictionRow;
  homeShort: string;
  awayShort: string;
  kickoff: string | null;
  outcome: PredictionOutcomeRow | null;
}

export type GenerateResult =
  | { status: "no-ratings" }
  | { status: "no-fixtures"; gw: number }
  | { status: "generated"; gw: number; written: number; skipped: number };

/**
 * Compute and store predictions for every fixture in a gameweek that has not
 * yet kicked off.
 *
 * `skipped` is not an error condition: pressing generate midway through a
 * gameweek legitimately finds some matches already played, and refusing to
 * predict those is the point.
 */
export async function generatePredictions(
  db: Db,
  gw: number,
): Promise<GenerateResult> {
  const stored = await getRatings(db);
  if (stored === null) return { status: "no-ratings" };

  const fixtures = await getFixturesFrom(db, gw, gw);
  if (fixtures.length === 0) return { status: "no-fixtures", gw };

  const prior: TeamStrength = PROMOTED_PRIOR;
  const strengthOf = (teamId: number) =>
    stored.fit.strength.get(teamId) ?? prior;
  const rated = (teamId: number) =>
    stored.fit.strength.has(teamId) && !stored.prior.has(teamId);

  const rows: TablesInsert<"predictions">[] = [];
  let skipped = 0;

  for (const fixture of fixtures) {
    if (fixture.started || fixture.finished) {
      skipped += 1;
      continue;
    }

    const s = scoreline(
      strengthOf(fixture.home_team),
      strengthOf(fixture.away_team),
      {
        leagueMean: stored.fit.leagueMean,
        homeAdvantage: stored.fit.homeAdvantage,
      },
    );
    const probabilities = outcomeProbabilities(s);
    const cs = cleanSheetProbabilities(s);
    const byOutcome = expectedScoreByOutcome(s);
    const favoured =
      probabilities.home >= probabilities.draw &&
      probabilities.home >= probabilities.away
        ? byOutcome.home
        : probabilities.away >= probabilities.draw
          ? byOutcome.away
          : byOutcome.draw;

    rows.push({
      gw,
      fixture_id: fixture.id,
      lambda_home: round(s.lambdaHome, 3),
      lambda_away: round(s.lambdaAway, 3),
      p_home: round(probabilities.home, 4),
      p_draw: round(probabilities.draw, 4),
      p_away: round(probabilities.away, 4),
      score_home: favoured.home,
      score_away: favoured.away,
      score_p: round(favoured.probability, 4),
      cs_home: round(cs.home, 4),
      cs_away: round(cs.away, 4),
      btts: round(bothTeamsToScore(s), 4),
      over_two_five: round(overUnder(s, 2.5).over, 4),
      // The EXPECTED scoreline for each result — the conditional mean, not
      // the mode. The mode understates every decisive result by about a third
      // of a goal of margin and effectively never says "comfortable win"; see
      // `expectedScoreByOutcome`.
      likely_scores: (["home", "draw", "away"] as const).map((outcome) => ({
        outcome,
        home: byOutcome[outcome].home,
        away: byOutcome[outcome].away,
        p: round(byOutcome[outcome].probability, 4),
      })) as unknown as TablesInsert<"predictions">["likely_scores"],
      basis: stored.basis,
      uses_prior:
        !rated(fixture.home_team) || !rated(fixture.away_team),
    });
  }

  if (rows.length > 0) {
    const { error } = await db
      .from("predictions")
      .upsert(rows, { onConflict: "fixture_id" });
    if (error) {
      throw new Error(`Failed to store predictions: ${error.message}`);
    }
  }

  return { status: "generated", gw, written: rows.length, skipped };
}

/** Every prediction for a gameweek, in kickoff order, with results if scored. */
export async function getPredictions(
  db: Db,
  gw: number,
): Promise<PredictedFixture[]> {
  const { data, error } = await db
    .from("predictions")
    .select("*, prediction_outcomes (*)")
    .eq("gw", gw);

  if (error) throw new Error(`Failed to read predictions: ${error.message}`);
  if (!data || data.length === 0) return [];

  const [teams, fixtures] = await Promise.all([
    getTeams(db),
    getFixturesFrom(db, gw, gw),
  ]);
  const shortOf = new Map(teams.map((t) => [t.id, t.short_name]));
  const fixtureOf = new Map(fixtures.map((f) => [f.id, f]));

  return data
    .map((row) => {
      const { prediction_outcomes, ...prediction } = row as PredictionRow & {
        prediction_outcomes:
          | PredictionOutcomeRow
          | PredictionOutcomeRow[]
          | null;
      };
      const fixture = fixtureOf.get(prediction.fixture_id);
      return {
        prediction,
        homeShort: shortOf.get(fixture?.home_team ?? -1) ?? "???",
        awayShort: shortOf.get(fixture?.away_team ?? -1) ?? "???",
        kickoff: fixture?.kickoff ?? null,
        // PostgREST returns an embedded one-to-one as an object or a
        // single-item array depending on how it infers the relationship.
        outcome: Array.isArray(prediction_outcomes)
          ? (prediction_outcomes[0] ?? null)
          : prediction_outcomes,
      };
    })
    .sort((a, b) => (a.kickoff ?? "").localeCompare(b.kickoff ?? ""));
}

/**
 * Score every unresolved prediction whose fixture has finished.
 *
 * Idempotent — anything already scored is skipped, so this is safe to run on
 * every sync.
 */
export async function resolvePredictions(
  db: Db,
  gw: number,
): Promise<number> {
  const predictions = await getPredictions(db, gw);
  const fixtures = await getFixturesFrom(db, gw, gw);
  const fixtureOf = new Map(fixtures.map((f) => [f.id, f]));

  const rows: TablesInsert<"prediction_outcomes">[] = [];

  for (const { prediction, outcome } of predictions) {
    if (outcome !== null) continue;

    const fixture = fixtureOf.get(prediction.fixture_id);
    if (!fixture?.finished) continue;
    if (fixture.home_score === null || fixture.away_score === null) continue;

    rows.push(
      scorePrediction(prediction, fixture.home_score, fixture.away_score),
    );
  }

  if (rows.length === 0) return 0;

  const { error } = await db
    .from("prediction_outcomes")
    .upsert(rows, { onConflict: "prediction_id" });
  if (error) {
    throw new Error(`Failed to write prediction outcomes: ${error.message}`);
  }
  return rows.length;
}

/** What a prediction was worth. Pure, so the scoring is testable. */
export function scorePrediction(
  prediction: Pick<
    PredictionRow,
    "id" | "p_home" | "p_draw" | "p_away" | "score_home" | "score_away"
  >,
  actualHome: number,
  actualAway: number,
): TablesInsert<"prediction_outcomes"> {
  const probabilities = {
    home: Number(prediction.p_home),
    draw: Number(prediction.p_draw),
    away: Number(prediction.p_away),
  };
  const actual: MatchOutcome = outcomeOf(actualHome, actualAway);
  const predicted: MatchOutcome = outcomeOf(
    prediction.score_home,
    prediction.score_away,
  );

  return {
    prediction_id: prediction.id,
    actual_home: actualHome,
    actual_away: actualAway,
    outcome_correct: predicted === actual,
    exact_correct:
      prediction.score_home === actualHome &&
      prediction.score_away === actualAway,
    rps: round(rankedProbabilityScore(probabilities, actual), 5),
    log_loss: round(logLoss(probabilities, actual), 5),
  };
}

export interface PredictionRecord {
  scored: number;
  outcomesRight: number;
  exactRight: number;
  meanRps: number;
  meanLogLoss: number;
}

/** How the model has been doing. Null until anything has been scored. */
export function summarise(
  predictions: PredictedFixture[],
): PredictionRecord | null {
  const scored = predictions.filter((p) => p.outcome !== null);
  if (scored.length === 0) return null;

  return {
    scored: scored.length,
    outcomesRight: scored.filter((p) => p.outcome!.outcome_correct).length,
    exactRight: scored.filter((p) => p.outcome!.exact_correct).length,
    meanRps:
      scored.reduce((sum, p) => sum + Number(p.outcome!.rps), 0) / scored.length,
    meanLogLoss:
      scored.reduce((sum, p) => sum + Number(p.outcome!.log_loss), 0) /
      scored.length,
  };
}

/** Postgres numeric columns have fixed scale; round rather than let it round. */
function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
