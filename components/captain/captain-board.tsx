import type { ReadyDecisionContext } from "@/lib/db/decision-context";
import { rankCaptains, type CaptainCandidate } from "@/lib/engine/captain";
import { atLeast } from "@/lib/engine/distribution";
import {
  CAPTAIN_BLANK_THRESHOLD,
  CAPTAIN_HAUL_THRESHOLD,
} from "@/lib/engine/constants";
import { CAPTAIN_MULTIPLIER } from "@/lib/rules";
import { ep as formatEp, percent } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Panel, Row, SectionLabel } from "@/components/ui/panel";
import { PriorSeasonBasis } from "@/components/ui/pending";

/**
 * The captaincy table, given a loaded context.
 *
 * Shared with the preview harness so the two cannot drift, exactly as the
 * transfer board and chip panels are.
 */
export function CaptainBoard({ context }: { context: ReadyDecisionContext }) {
  const ranked = rankFromContext(context);
  const best = ranked[0];

  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      {context.basis === "prior-season" ? <PriorSeasonBasis /> : null}

      <div>
        <SectionLabel meta={`GW${context.gw} · DOUBLED`}>
          THE ARMBAND
        </SectionLabel>
        <Panel padded>
          <div className="font-mono text-tiny tracking-[0.14em] text-accent">
            {best ? best.name.toUpperCase() : "NO CANDIDATE"}
          </div>
          <div className="mt-2 max-w-prose text-small leading-relaxed text-muted text-pretty">
            {best ? (
              <>
                Highest expected return at{" "}
                {formatEp(best.ep * CAPTAIN_MULTIPLIER)} doubled. It hauls{" "}
                {percent(best.pHaul * 100, 0)} of the time and blanks{" "}
                {percent(best.pBlank * 100, 0)} of the time.
                {ranked[1] && ranked[1].pHaul > best.pHaul ? (
                  <>
                    {" "}
                    <span className="text-tertiary">
                      {ranked[1].name} hauls more often
                    </span>{" "}
                    ({percent(ranked[1].pHaul * 100, 0)}) despite the lower
                    mean — the differential pick if you are chasing.
                  </>
                ) : null}
              </>
            ) : (
              <>No player in the squad projects above zero this gameweek.</>
            )}
          </div>
        </Panel>
      </div>

      <div>
        <SectionLabel
          meta={`HAUL = ${CAPTAIN_HAUL_THRESHOLD}+ · BLANK = ${CAPTAIN_BLANK_THRESHOLD} OR FEWER`}
        >
          CANDIDATES
        </SectionLabel>
        <Panel className="overflow-x-auto">
          <div className="min-w-[680px]">
            <Row height="dense" className="grid grid-cols-[1fr_54px_54px_60px_60px_92px] gap-2.5">
              {["", "EP", "MEDIAN", "HAUL", "BLANK", "SHAPE"].map((h, i) => (
                <div
                  key={h || i}
                  className={cn(
                    "font-mono text-micro tracking-[0.12em] text-label",
                    i > 0 && "text-right",
                    i === 5 && "text-left",
                  )}
                >
                  {h}
                </div>
              ))}
            </Row>
            {ranked.map((c, index) => (
              <CandidateRow key={c.playerId} candidate={c} isPick={index === 0} />
            ))}
          </div>
        </Panel>
        <div className="mt-2 max-w-prose text-small leading-relaxed text-dim text-pretty">
          Ranked by expected points, which is the risk-neutral answer. The
          median sits below the mean for anyone whose scoring is goal-dependent;
          the gap between them is how volatile that player is. Doubling
          multiplies both the ceiling and the blank, which is why a safe captain
          and a differential are genuinely different choices rather than degrees
          of the same one.
        </div>
      </div>
    </div>
  );
}

type Ranked = CaptainCandidate & { name: string; club: string; positionShort: string };

/** Rank the fifteen, attaching the names the engine deliberately does not carry. */
function rankFromContext(
  context: ReadyDecisionContext,
): Ranked[] {
  const byId = new Map(context.squad.map((c) => [c.id, c]));

  const ranked = rankCaptains(
    context.squad.map((candidate) => ({
      playerId: candidate.id,
      input: candidate.modelInput,
      fixtures: candidate.thisGameweek,
    })),
  );

  return ranked.flatMap((c) => {
    const candidate = byId.get(c.playerId);
    if (!candidate) return [];
    return [
      {
        ...c,
        name: candidate.name,
        club: candidate.club,
        positionShort: candidate.positionShort,
      },
    ];
  });
}

function CandidateRow({
  candidate,
  isPick,
}: {
  candidate: Ranked;
  isPick: boolean;
}) {
  return (
    <Row
      height="table"
      className={cn(
        "grid grid-cols-[1fr_54px_54px_60px_60px_92px] items-center gap-2.5",
        isPick && "bg-active",
      )}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <div
          className={cn(
            "truncate text-small",
            isPick ? "text-primary" : "text-secondary",
          )}
        >
          {candidate.name}
        </div>
        <div className="shrink-0 font-mono text-micro tracking-[0.1em] text-fainter">
          {candidate.positionShort} · {candidate.club}
        </div>
      </div>

      <div
        className={cn(
          "text-right font-mono text-cell",
          isPick ? "text-accent" : "text-primary",
        )}
      >
        {formatEp(candidate.ep)}
      </div>
      <div className="text-right font-mono text-cell text-muted">
        {candidate.median}
      </div>
      <div className="text-right font-mono text-cell text-accent">
        {percent(candidate.pHaul * 100, 0)}
      </div>
      <div
        className={cn(
          "text-right font-mono text-cell",
          candidate.pBlank > 0.5 ? "text-warn" : "text-muted",
        )}
      >
        {percent(candidate.pBlank * 100, 0)}
      </div>

      <ShapeBar distribution={candidate.distribution} />
    </Row>
  );
}

/**
 * A three-band bar: blank, ordinary, haul.
 *
 * The point of the screen in one glance. Two players with the same expected
 * points can have visibly different bars, and the bar is the thing that tells
 * you which one to double.
 */
function ShapeBar({ distribution }: { distribution: number[] }) {
  const haul = atLeast(distribution, CAPTAIN_HAUL_THRESHOLD);
  const blank = 1 - atLeast(distribution, CAPTAIN_BLANK_THRESHOLD + 1);
  const middle = Math.max(0, 1 - haul - blank);
  const pct = (value: number) => `${Math.round(value * 100)}%`;

  return (
    <div
      className="flex h-1.5 w-full overflow-hidden bg-track"
      title={`blank ${pct(blank)} · ordinary ${pct(middle)} · haul ${pct(haul)}`}
    >
      <div className="bg-warn-dim" style={{ width: pct(blank) }} />
      <div className="bg-track-strong" style={{ width: pct(middle) }} />
      <div className="bg-accent" style={{ width: pct(haul) }} />
    </div>
  );
}

