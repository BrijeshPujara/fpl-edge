import { getDb, isDbConfigured } from "@/lib/db/client";
import {
  getPredictions,
  likelyScoresOf,
  resolvePredictions,
  summarise,
  type PredictedFixture,
} from "@/lib/db/predictions";
import { getLiveGameweek } from "@/lib/fpl/live-context";
import { getRatings } from "@/lib/db/ratings";
import { captionFor } from "@/lib/engine/scoreline";
import { Panel, Row, SectionLabel } from "@/components/ui/panel";
import { GenerateScorelines } from "./generate-scorelines";
import { cn } from "@/lib/cn";

/**
 * Scoreline predictions for the gameweek.
 *
 * Renders nothing but the button until someone presses it. That is the point
 * of the feature: a prediction is a record, it is written once and scored
 * later, and a panel that quietly generated one on every page view would be
 * keeping a diary nobody wrote.
 *
 * Each result carries its own likeliest scoreline, and that is the design.
 *
 * A single scoreline for the match is not information — the likeliest cell of
 * the grid is right about one time in nine, and it is 1-1 in three quarters of
 * fixtures because 1-1 is simply the most common result in football. Printed
 * beside "61% home win" that reads as a contradiction even though both numbers
 * are right.
 *
 * So the row answers the question a reader actually has. If it is a home win,
 * what score; if a draw, what score; if away, what score. Measured over 560
 * held-out matches across two seasons that set contains the real score 27.1%
 * of the time, against 30.9% for the three likeliest overall — 3.8 points paid
 * for a row where no cell contradicts the one beside it.
 */
export async function ScorelinePanel({
  entryId,
  gw,
}: {
  entryId: number;
  gw: number;
}) {
  if (!isDbConfigured()) return null;

  const db = getDb();
  const live = await getLiveGameweek(gw);

  /*
   * Score anything that has finished, before reading the board.
   *
   * Resolution used to happen only on the results sync, which waits for the
   * whole gameweek to be `finished` AND `data_checked` — typically the Monday
   * after. So a Friday night result sat unscored all weekend and the board
   * showed a dash beside a match everyone had watched.
   *
   * Idempotent and cheap: it writes only for predictions with no outcome and a
   * finished fixture, so on almost every render it writes nothing. The sync
   * still does the same job, for gameweeks nobody happens to open.
   */
  if (live) {
    await resolvePredictions(db, gw, live.results).catch(() => 0);
  }

  const [predictions, ratings] = await Promise.all([
    getPredictions(db, gw),
    getRatings(db),
  ]);
  const record = summarise(predictions);

  return (
    <div>
      <SectionLabel
        meta={
          predictions.length > 0
            ? `${predictions.length} FIXTURES`
            : ratings === null
              ? "NO RATINGS"
              : undefined
        }
      >
        SCORELINES
      </SectionLabel>

      <Panel>
        <Row height="tall" className="flex justify-between gap-3">
          <div className="min-w-0 font-mono text-micro tracking-[0.12em] text-label">
            {predictions.length === 0
              ? `NOT YET GENERATED FOR GW${gw}`
              : `GENERATED FOR GW${gw}`}
          </div>
          <GenerateScorelines
            entryId={entryId}
            gw={gw}
            existing={predictions.length > 0}
          />
        </Row>

        {predictions.length > 0 ? (
          <>
            <Row
              height="table"
              className="grid grid-cols-[1fr_repeat(3,64px)] gap-2 font-mono text-micro tracking-[0.06em] text-ghost sm:grid-cols-[1fr_repeat(3,74px)_56px]"
            >
              <div>FIXTURE</div>
              <div className="text-right">HOME</div>
              <div className="text-right">DRAW</div>
              <div className="text-right">AWAY</div>
              {/* Only the result column drops away on a narrow screen; the
                  three that carry the prediction never do. */}
              <div className="hidden text-right sm:block">RESULT</div>
            </Row>
            {predictions.map((p) => (
              <FixtureRow key={p.prediction.id} predicted={p} />
            ))}
          </>
        ) : null}
      </Panel>

      <Footnote
        basis={ratings?.basis ?? null}
        hasRatings={ratings !== null}
        priorCount={ratings?.prior.size ?? 0}
        priorSeasons={ratings?.priorSeasons ?? 1}
        blendWeight={ratings?.blendWeight ?? 0}
        matches={ratings?.fit.matches ?? 0}
        // From the rows on screen, so the sentence describes what is actually
        // being shown rather than what the code currently computes.
        scoreMethod={predictions[0]?.prediction.score_method ?? null}
        record={record}
      />
    </div>
  );
}

/** The likeliest scoreline for one result, if it was stored. */
function scoreFor(
  predicted: PredictedFixture,
  outcome: "home" | "draw" | "away",
): string | null {
  const found = likelyScoresOf(predicted.prediction).find(
    (score) => score.outcome === outcome,
  );
  return found ? `${found.home}\u2013${found.away}` : null;
}

/**
 * One result: how likely it is, and what it most likely looks like.
 *
 * The probability leads because it is the trustworthy half — a result
 * probability is worth acting on and a scoreline never is.
 */
function Result({
  probability,
  score,
}: {
  probability: number | string;
  score: string | null;
}) {
  return (
    <div className="text-right font-mono tabular-nums">
      <div className="text-cell text-secondary">
        {Math.round(Number(probability) * 100)}%
      </div>
      {score ? <div className="text-micro text-ghost">{score}</div> : null}
    </div>
  );
}

function FixtureRow({ predicted }: { predicted: PredictedFixture }) {
  const { prediction: p, outcome } = predicted;
  return (
    <Row
      height="tall"
      className="grid grid-cols-[1fr_repeat(3,64px)] gap-2 sm:grid-cols-[1fr_repeat(3,74px)_56px]"
    >
      <div className="flex min-w-0 items-center gap-1.5 truncate text-small text-primary">
        <span className="truncate">
          {predicted.homeShort} v {predicted.awayShort}
        </span>
        {p.uses_prior ? (
          <span
            className="font-mono text-micro text-ghost"
            title="One side is newly promoted, so its rating is a prior rather than a measurement."
          >
            ?
          </span>
        ) : null}
      </div>

      <Result probability={p.p_home} score={scoreFor(predicted, "home")} />
      <Result probability={p.p_draw} score={scoreFor(predicted, "draw")} />
      <Result probability={p.p_away} score={scoreFor(predicted, "away")} />

      <div className="hidden text-right font-mono text-cell tabular-nums sm:block">
        {outcome === null ? (
          <span className="text-ghost">&mdash;</span>
        ) : (
          <span
            className={cn(
              outcome.exact_correct
                ? "text-accent"
                : outcome.outcome_correct
                  ? "text-accent-dim"
                  : "text-warn",
            )}
          >
            {outcome.actual_home}&ndash;{outcome.actual_away}
          </span>
        )}
      </div>
    </Row>
  );
}

/**
 * How the ratings' basis reads, given how many seasons are behind it.
 *
 * A function and not a lookup table, because the table was where the last
 * stale caption lived: it said "last season only" and stayed saying it after
 * the prior became three seasons, since `basis` had not changed — only the
 * number of seasons had, and nothing was reading that. It reads it now.
 */
export function basisLabel(basis: string | null, priorSeasons: number): string {
  const seasons =
    priorSeasons <= 1
      ? "last season"
      : priorSeasons === 2
        ? "the two seasons before this one"
        : `the ${NUMBER_WORD[priorSeasons] ?? priorSeasons} seasons before this one`;

  if (basis === "prior-season") return seasons;
  if (basis === "blended") return `${seasons}, moving toward this one`;
  if (basis === "this-season") return "this season";
  return basis ?? "an unknown basis";
}

const NUMBER_WORD: Record<number, string> = {
  3: "three",
  4: "four",
  5: "five",
};

function Footnote({
  basis,
  hasRatings,
  priorCount,
  priorSeasons,
  blendWeight,
  matches,
  scoreMethod,
  record,
}: {
  basis: string | null;
  hasRatings: boolean;
  priorCount: number;
  priorSeasons: number;
  blendWeight: number;
  matches: number;
  /** Read off the predictions themselves, not assumed. */
  scoreMethod: string | null;
  record: ReturnType<typeof summarise>;
}) {
  if (!hasRatings) {
    return (
      <div className="mt-2 max-w-prose text-small leading-relaxed text-dim text-pretty">
        No team ratings are stored yet, so there is nothing to predict from.
        They are fitted from played matches and written by a job, not by this
        page.
      </div>
    );
  }

  return (
    <div className="mt-2 flex max-w-prose flex-col gap-2 text-small leading-relaxed text-dim text-pretty">
      <p>
        Each result shows how likely it is, and{" "}
        <span className="text-tertiary">{captionFor(scoreMethod)}</span>. The
        percentages are the reliable half; a scoreline never is.
      </p>
      <p>
        Ratings fitted on{" "}
        <span className="text-tertiary">
          {basisLabel(basis, priorSeasons)}
        </span>
        {basis === "blended" || basis === "this-season" ? (
          <>
            {" "}
            &mdash;{" "}
            <span className="tabular-nums text-tertiary">
              {Math.round(blendWeight * 100)}%
            </span>{" "}
            this season, from {matches} matches, with recent ones counting for
            more
          </>
        ) : null}
        {priorCount > 0 ? (
          <>
            .{" "}
            <span className="text-tertiary">
              {priorCount} promoted {priorCount === 1 ? "side has" : "sides have"}
            </span>{" "}
            never played at this level, so each carries what promoted sides
            average rather than a rating of its own, marked{" "}
            <span className="font-mono text-tertiary">?</span> &mdash; the
            weakest number on this panel.
          </>
        ) : (
          "."
        )}
      </p>
      {record ? (
        <p>
          Scored so far: {record.outcomesRight} of {record.scored} results
          right, {record.exactRight} with the called scoreline exactly right.
          Mean RPS{" "}
          <span className="tabular-nums text-tertiary">
            {record.meanRps.toFixed(3)}
          </span>
          {" "}&mdash; lower is better, and a model that knew nothing would sit
          near 0.228.
        </p>
      ) : null}
    </div>
  );
}
