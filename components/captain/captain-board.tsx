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
import { PageHeader, Panel, SectionLabel } from "@/components/ui/panel";
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
  const differential = ranked[1] && best && ranked[1].pHaul > best.pHaul ? ranked[1] : null;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Captain"
        subtitle={`GW${context.gw} · ranked on expected points`}
      />

      {context.basis === "prior-season" ? <PriorSeasonBasis /> : null}

      <Panel>
        {best ? (
          <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <div className="text-xs font-medium text-muted">Your captain</div>
              <div className="font-display text-3xl font-bold tracking-wide text-primary uppercase">
                {best.name}
              </div>
              <p className="mt-1 max-w-prose text-sm leading-relaxed text-muted text-pretty">
                {best.positionShort} · {best.club}. Hauls{" "}
                {percent(best.pHaul * 100, 0)} of the time and blanks{" "}
                {percent(best.pBlank * 100, 0)}.
                {differential ? (
                  <>
                    {" "}
                    <span className="font-semibold text-primary">
                      {differential.name} hauls more often
                    </span>{" "}
                    ({percent(differential.pHaul * 100, 0)}) despite the lower
                    mean — the differential pick if you are chasing.
                  </>
                ) : null}
              </p>
            </div>
            <div className="text-right">
              <div className="text-xs font-medium text-muted">Expected, doubled</div>
              <div className="font-display text-4xl font-bold text-accent">
                {formatEp(best.ep * CAPTAIN_MULTIPLIER)}
              </div>
            </div>
          </div>
        ) : (
          <p className="px-5 py-4 text-sm text-muted">
            No player in the squad projects above zero this gameweek.
          </p>
        )}
      </Panel>

      <section>
        <SectionLabel
          meta={`Haul = ${CAPTAIN_HAUL_THRESHOLD}+ points · blank = ${CAPTAIN_BLANK_THRESHOLD} or fewer`}
        >
          Every candidate
        </SectionLabel>
        <Panel>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-edge-strong bg-sunken text-left text-xs text-muted">
                  <th scope="col" className="py-2.5 pr-3 pl-4 font-medium">Player</th>
                  <th scope="col" className="py-2.5 pr-3 text-right font-medium">Expected</th>
                  <th scope="col" className="py-2.5 pr-3 text-right font-medium">Median</th>
                  <th scope="col" className="py-2.5 pr-3 text-right font-medium">Haul</th>
                  <th scope="col" className="py-2.5 pr-3 text-right font-medium">Blank</th>
                  <th scope="col" className="w-[120px] py-2.5 pr-4 font-medium">Shape</th>
                </tr>
              </thead>
              <tbody>
                {ranked.map((c, index) => (
                  <CandidateRow key={c.playerId} candidate={c} isPick={index === 0} />
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 bg-warn-dim" /> Blank
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 bg-track-strong" /> Ordinary
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 bg-accent" /> Haul
          </span>
        </div>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted text-pretty">
          Ranked by expected points, which is the risk-neutral answer. The median
          sits below the mean for anyone whose scoring is goal-dependent; the gap
          between them is how volatile that player is. Doubling multiplies both
          the ceiling and the blank, which is why a safe captain and a
          differential are genuinely different choices rather than degrees of the
          same one.
        </p>
      </section>
    </div>
  );
}

type Ranked = CaptainCandidate & { name: string; club: string; positionShort: string };

/** Rank the fifteen, attaching the names the engine deliberately does not carry. */
function rankFromContext(context: ReadyDecisionContext): Ranked[] {
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
    <tr
      className={cn(
        "border-b border-edge-subtle last:border-b-0",
        isPick ? "bg-active" : "hover:bg-panel-hover",
      )}
    >
      <td
        className={cn(
          "py-2.5 pr-3 pl-4",
          isPick && "shadow-[inset_4px_0_0_var(--text-primary)]",
        )}
      >
        <span className={cn("text-primary", isPick ? "font-bold" : "font-medium")}>
          {candidate.name}
        </span>{" "}
        <span className="text-xs text-muted">
          {candidate.positionShort} · {candidate.club}
        </span>
      </td>
      <td
        className={cn(
          "py-2.5 pr-3 text-right font-display text-base font-bold",
          isPick ? "text-accent" : "text-primary",
        )}
      >
        {formatEp(candidate.ep)}
      </td>
      <td className="py-2.5 pr-3 text-right font-display text-base font-bold text-muted">
        {candidate.median}
      </td>
      <td className="py-2.5 pr-3 text-right font-display text-base font-bold text-accent">
        {percent(candidate.pHaul * 100, 0)}
      </td>
      <td
        className={cn(
          "py-2.5 pr-3 text-right font-display text-base font-bold",
          candidate.pBlank > 0.5 ? "text-warn" : "text-muted",
        )}
      >
        {percent(candidate.pBlank * 100, 0)}
      </td>
      <td className="py-2.5 pr-4">
        <ShapeBar distribution={candidate.distribution} />
      </td>
    </tr>
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
      className="flex h-2.5 w-full overflow-hidden bg-track"
      title={`blank ${pct(blank)} · ordinary ${pct(middle)} · haul ${pct(haul)}`}
    >
      <div className="bg-warn-dim" style={{ width: pct(blank) }} />
      <div className="bg-track-strong" style={{ width: pct(middle) }} />
      <div className="bg-accent" style={{ width: pct(haul) }} />
    </div>
  );
}
