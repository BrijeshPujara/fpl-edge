import { getDb, isDbConfigured } from "@/lib/db/client";
import {
  getPredictions,
  likelyScoresOf,
  summarise,
  type PredictedFixture,
} from "@/lib/db/predictions";
import { getRatings } from "@/lib/db/ratings";
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
 * It shows THREE scorelines, not one, and that is the whole design.
 *
 * A single scoreline is not information. Measured over 280 held-out matches
 * the model names 2-1 or 1-2 in 53.6% of fixtures and the top cell is right
 * 12.5% of the time — it says the same thing half the time and is wrong seven
 * times in eight. The grid is not at fault: that top cell carries 14.2% of the
 * probability against a 12.5% hit rate, which is calibrated. Printing one cell
 * of a calibrated distribution as though it were a call is what over-claimed.
 *
 * Three cells are right 33.6% of the time and carry 34.5%. Same honesty, far
 * more use, and the percentages are on screen so nobody has to take it on
 * trust.
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
              className="grid grid-cols-[1fr_150px] gap-2 font-mono text-micro tracking-[0.06em] text-ghost sm:grid-cols-[1fr_170px_repeat(3,46px)_56px]"
            >
              <div>FIXTURE</div>
              <div className="text-right">LIKELY SCORES</div>
              {/*
                The three probabilities and the result drop away on a narrow
                screen, but the header itself must not — hiding the whole row
                left SCORE and P unlabelled on a phone, which is where the
                caution about P being small matters most.
              */}
              <div className="hidden text-right sm:block">HOME</div>
              <div className="hidden text-right sm:block">DRAW</div>
              <div className="hidden text-right sm:block">AWAY</div>
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
        blendWeight={ratings?.blendWeight ?? 0}
        matches={ratings?.fit.matches ?? 0}
        record={record}
      />
    </div>
  );
}

/**
 * The three most likely scorelines.
 *
 * Three rather than one because one is not information. Measured over 280
 * held-out matches the top cell is right 12.5% of the time while the model
 * names 2-1 or 1-2 in 53.6% of fixtures — it says the same thing half the
 * time and is wrong seven times in eight. Three are right 33.6% of the time.
 *
 * Both sets are calibrated against the probability they carry; what was wrong
 * was printing one cell of a calibrated distribution as though it were a call.
 */
function LikelyScores({ predicted }: { predicted: PredictedFixture }) {
  const scores = likelyScoresOf(predicted.prediction);

  // Predictions stored before this column existed have nothing to show, and a
  // regenerate fills them in.
  if (scores.length === 0) {
    return (
      <div className="text-right font-mono text-cell tabular-nums text-primary">
        {predicted.prediction.score_home}&ndash;{predicted.prediction.score_away}
      </div>
    );
  }

  return (
    <div className="flex items-baseline justify-end gap-2 font-mono tabular-nums">
      {scores.map((score, i) => (
        <span key={`${score.home}-${score.away}`} className="whitespace-nowrap">
          <span className={i === 0 ? "text-cell text-primary" : "text-cell text-muted"}>
            {score.home}&ndash;{score.away}
          </span>
          {/* The % is not decoration: a bare number beside a scoreline reads
              as part of it. */}
          <span className="ml-0.5 text-micro text-ghost">
            {Math.round(Number(score.p) * 100)}%
          </span>
        </span>
      ))}
    </div>
  );
}

function FixtureRow({ predicted }: { predicted: PredictedFixture }) {
  const { prediction: p, outcome } = predicted;
  const pc = (value: number | string) => `${Math.round(Number(value) * 100)}%`;

  return (
    <Row
      height="table"
      className="grid grid-cols-[1fr_150px] gap-2 sm:grid-cols-[1fr_170px_repeat(3,46px)_56px]"
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

      <LikelyScores predicted={predicted} />

      <div className="hidden text-right font-mono text-cell tabular-nums text-secondary sm:block">
        {pc(p.p_home)}
      </div>
      <div className="hidden text-right font-mono text-cell tabular-nums text-secondary sm:block">
        {pc(p.p_draw)}
      </div>
      <div className="hidden text-right font-mono text-cell tabular-nums text-secondary sm:block">
        {pc(p.p_away)}
      </div>

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

const BASIS_LABEL: Record<string, string> = {
  "prior-season": "last season only",
  blended: "last season moving toward this one",
  "this-season": "this season",
};

function Footnote({
  basis,
  hasRatings,
  priorCount,
  blendWeight,
  matches,
  record,
}: {
  basis: string | null;
  hasRatings: boolean;
  priorCount: number;
  blendWeight: number;
  matches: number;
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
        The three most likely scorelines, with the percentage chance of each.
        One of them lands about a third of the time; the leading one alone
        about one time in eight. The result probabilities are the reliable
        part &mdash; a scoreline never is.
      </p>
      <p>
        Ratings fitted on{" "}
        <span className="text-tertiary">
          {BASIS_LABEL[basis ?? ""] ?? basis}
        </span>
        {basis === "blended" ? (
          <>
            {" "}
            &mdash;{" "}
            <span className="tabular-nums text-tertiary">
              {Math.round(blendWeight * 100)}%
            </span>{" "}
            this season, from {matches} matches, and rising until it is all of
            it
          </>
        ) : null}
        {priorCount > 0 ? (
          <>
            .{" "}
            <span className="text-tertiary">
              {priorCount} promoted {priorCount === 1 ? "side has" : "sides have"}
            </span>{" "}
            no rating at all and carry the average of the clubs they replaced,
            marked <span className="font-mono text-tertiary">?</span> &mdash; the
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
