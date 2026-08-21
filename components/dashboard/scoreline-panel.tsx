import { getDb, isDbConfigured } from "@/lib/db/client";
import {
  getPredictions,
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
 * The scoreline shown is the most likely one WITHIN the outcome the model
 * favours, not the most likely scoreline outright. Outright, it is 1-1 in nine
 * fixtures out of ten — the draw distribution is concentrated on a few cells
 * while wins are spread across many — so the unconditional mode carries no
 * information about the match at all. The probability beside it is the honest
 * one: it rarely clears one in six, and it is shown so nobody mistakes the
 * scoreline for a forecast.
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
              className="grid grid-cols-[1fr_58px_44px] gap-2 font-mono text-micro tracking-[0.06em] text-ghost sm:grid-cols-[1fr_58px_44px_repeat(3,46px)_56px]"
            >
              <div>FIXTURE</div>
              <div className="text-right">SCORE</div>
              <div className="text-right">P</div>
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
        record={record}
      />
    </div>
  );
}

function FixtureRow({ predicted }: { predicted: PredictedFixture }) {
  const { prediction: p, outcome } = predicted;
  const pc = (value: number | string) => `${Math.round(Number(value) * 100)}%`;

  return (
    <Row
      height="table"
      className="grid grid-cols-[1fr_58px_44px] gap-2 sm:grid-cols-[1fr_58px_44px_repeat(3,46px)_56px]"
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

      <div className="text-right font-mono text-cell tabular-nums text-primary">
        {p.score_home}&ndash;{p.score_away}
      </div>
      <div className="text-right font-mono text-cell tabular-nums text-dim">
        {pc(p.score_p)}
      </div>

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
  blended: "last season blended with this one",
  "this-season": "this season",
};

function Footnote({
  basis,
  hasRatings,
  priorCount,
  record,
}: {
  basis: string | null;
  hasRatings: boolean;
  priorCount: number;
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
        The scoreline is the most likely one within the result the model
        expects, and <span className="text-tertiary">P</span> is its outright
        chance &mdash; rarely better than one in six. Read the three
        probabilities, not the scoreline.
      </p>
      <p>
        Ratings fitted on{" "}
        <span className="text-tertiary">
          {BASIS_LABEL[basis ?? ""] ?? basis}
        </span>
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
          right, {record.exactRight} exact. Mean RPS{" "}
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
