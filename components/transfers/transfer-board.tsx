import { ArrowRight } from "lucide-react";
import { toPlayerCandidate, type Candidate } from "@/lib/squad/candidates";
import type { ReadyDecisionContext } from "@/lib/db/decision-context";
import { suggestTransfers, type TransferOption } from "@/lib/engine/transfers";
import { createGlpkSolver } from "@/lib/solver/glpk";
import { DEFAULT_HORIZON } from "@/lib/engine/constants";
import { HIT_BREAK_EVEN_EP, TRANSFER_HIT_COST } from "@/lib/rules";
import { ep as formatEp, epDelta, hit, money, moneyDelta } from "@/lib/format";
import { cn } from "@/lib/cn";
import { PageHeader, Panel, SectionLabel, StatRow } from "@/components/ui/panel";

/**
 * The transfer board itself, given a loaded context.
 *
 * Split from the route so the dev preview can render exactly the same
 * component against synthetic history. A preview that renders a near-copy of
 * the real screen is worth very little; this one cannot drift from it.
 *
 * Laid out in the order the decision is made: the verdict first, then the
 * moves it means, then every option it was chosen from.
 */
export async function TransferBoard({
  context,
}: {
  context: ReadyDecisionContext;
}) {
  const solver = await createGlpkSolver();
  const byId = new Map(context.pool.map((c) => [c.id, c]));
  const priceOf = (id: number) => context.priceDeltas.get(id) ?? 0;

  const suggestion = suggestTransfers(
    {
      currentSquad: context.squad.map((c) => toPlayerCandidate(c, priceOf(c.id))),
      candidates: context.pool.map((c) => toPlayerCandidate(c, priceOf(c.id))),
      freeTransfers: context.freeTransfers,
      // Before a gameweek is played the model cannot tell a starter from a
      // squad player, so it must not spend points on the difference.
      minutesKnown: context.minutesKnown,
      bank: context.bank,
    },
    solver,
    { priceWeight: "auto" },
  );

  const { recommended } = suggestion;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Transfers"
        subtitle={`GW${context.gw} · ${context.freeTransfers} free transfer${context.freeTransfers === 1 ? "" : "s"} · ${money(context.bank)} in the bank · judged over ${DEFAULT_HORIZON} gameweeks`}
      />

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex flex-col gap-5">
          <Panel>
            <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <div className="text-xs font-medium text-muted">The verdict</div>
                <div className="font-display text-2xl font-bold tracking-wide text-primary uppercase">
                  {suggestion.shouldRoll
                    ? "Roll the transfer"
                    : recommended.transfers === 1
                      ? "Make one move"
                      : `Make ${recommended.transfers} moves`}
                </div>
                <p className="mt-1 max-w-prose text-sm leading-relaxed text-muted text-pretty">
                  {suggestion.shouldRoll ? (
                    <>
                      Nothing available clears the {HIT_BREAK_EVEN_EP}-point bar
                      it would cost. Banking the transfer carries it into next
                      week, which is worth more than a move that only pays for
                      itself.
                    </>
                  ) : (
                    <>
                      Gains {formatEp(recommended.epGain)} points over{" "}
                      {DEFAULT_HORIZON} gameweeks
                      {recommended.hitCost > 0
                        ? `, less ${recommended.hitCost} in hits.`
                        : ", and the transfer is free."}
                    </>
                  )}
                </p>
              </div>
              {!suggestion.shouldRoll ? (
                <div className="text-right">
                  <div className="text-xs font-medium text-muted">Net gain</div>
                  <div className="font-display text-4xl font-bold text-accent">
                    {epDelta(recommended.netGain)}
                  </div>
                </div>
              ) : null}
            </div>

            {suggestion.withheld ? (
              <div className="border-t border-warn-dim bg-[color-mix(in_oklch,var(--warn)_8%,var(--surface-panel))] px-5 py-3">
                <div className="text-sm font-semibold text-warn">
                  A bigger move was available, and isn&apos;t advised
                </div>
                <p className="mt-1 max-w-prose text-sm leading-relaxed text-secondary text-pretty">
                  {suggestion.withheld.transfers} moves score{" "}
                  <span className="font-semibold">
                    {formatEp(suggestion.withheld.netGain)}
                  </span>{" "}
                  after a {suggestion.withheld.hitCost}-point hit. That gain rests
                  on how these players were used last season. Summer transfers, a
                  new manager and a lost place are all invisible until real minutes
                  arrive, and a hit is a certain four points against a gain that
                  old. Free moves are unaffected: one that turns out wrong costs
                  only the move.
                </p>
              </div>
            ) : null}
          </Panel>

          {recommended.transfers > 0 ? (
            <section>
              <SectionLabel meta="Out → in">Recommended moves</SectionLabel>
              <Panel>
                {recommended.playersOut.map((out, i) => {
                  const incoming = recommended.playersIn[i];
                  return (
                    <div
                      key={out.id}
                      className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-b border-edge-subtle px-4 py-3 last:border-b-0"
                    >
                      <PlayerCell candidate={byId.get(out.id)} tone="out" />
                      <ArrowRight aria-hidden className="size-4 text-muted" />
                      <PlayerCell
                        candidate={incoming ? byId.get(incoming.id) : undefined}
                        tone="in"
                      />
                    </div>
                  );
                })}
              </Panel>
            </section>
          ) : null}

          <section>
            <SectionLabel meta={`A hit costs ${TRANSFER_HIT_COST} points per extra move`}>
              Every option
            </SectionLabel>
            <Panel>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-edge-strong bg-sunken text-left text-xs text-muted">
                      <th scope="col" className="py-2.5 pr-3 pl-4 font-medium">Moves</th>
                      <th scope="col" className="py-2.5 pr-3 font-medium">Bringing in</th>
                      <th scope="col" className="hidden py-2.5 pr-3 text-right font-medium sm:table-cell">Gain</th>
                      <th scope="col" className="hidden py-2.5 pr-3 text-right font-medium sm:table-cell">Hit</th>
                      <th scope="col" className="py-2.5 pr-3 text-right font-medium">Net</th>
                      <th scope="col" className="hidden py-2.5 pr-4 text-right font-medium md:table-cell">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {suggestion.options.map((option) => (
                      <OptionRow
                        key={option.transfers}
                        option={option}
                        byId={byId}
                        recommended={option === recommended}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </section>
        </div>

        <div className="flex flex-col gap-5">
          <section>
            <SectionLabel>Your position</SectionLabel>
            <Panel>
              <StatRow label="Free transfers" value={String(context.freeTransfers)} />
              <StatRow label="In the bank" value={money(context.bank)} />
              <StatRow label="Squad value" value={money(context.teamValue)} />
              <StatRow
                label="Budget available"
                value={money(context.teamValue + context.bank)}
                tone="muted"
              />
            </Panel>
          </section>

          <section>
            <SectionLabel>What £0.1m buys</SectionLabel>
            <Panel>
              <StatRow
                label="Points per £0.1m"
                value={
                  recommended.marginalEpPerTenth === null
                    ? "—"
                    : recommended.marginalEpPerTenth.toFixed(3)
                }
                tone={recommended.marginalEpPerTenth === null ? "muted" : "accent"}
              />
              <p className="px-4 py-3 text-sm leading-relaxed text-muted text-pretty">
                {recommended.marginalEpPerTenth === null ? (
                  <>
                    Rolling needs no solve, so there is no shadow price to read.
                    A dash rather than a zero: zero would claim money is worth
                    nothing here, which is a different and much stronger
                    statement.
                  </>
                ) : recommended.marginalEpPerTenth === 0 ? (
                  <>
                    Budget is not binding. Extra money buys nothing at this
                    squad, so holding cash costs you nothing — and gains you
                    nothing either.
                  </>
                ) : (
                  <>
                    A local estimate from the LP dual. The true marginal is a
                    step: an extra £0.1m buys nothing until it crosses a
                    threshold, then buys a whole upgrade at once.
                  </>
                )}
              </p>
            </Panel>
          </section>
        </div>
      </div>
    </div>
  );
}

/** One transfer count, with the deltas PLAN.md section 6 specifies. */
function OptionRow({
  option,
  byId,
  recommended,
}: {
  option: TransferOption;
  byId: Map<number, Candidate>;
  recommended: boolean;
}) {
  const names = option.playersIn
    .map((p) => byId.get(p.id)?.name)
    .filter(Boolean)
    .join(", ");

  return (
    <tr
      className={cn(
        "border-b border-edge-subtle last:border-b-0",
        recommended ? "bg-active" : "hover:bg-panel-hover",
      )}
    >
      <td
        className={cn(
          "py-3 pr-3 pl-4 align-top whitespace-nowrap",
          recommended && "shadow-[inset_4px_0_0_var(--text-primary)]",
        )}
      >
        <div className="font-display text-base font-bold text-primary uppercase">
          {option.transfers === 0
            ? "Roll"
            : `${option.transfers} move${option.transfers === 1 ? "" : "s"}`}
        </div>
        {recommended ? (
          <span className="mt-1 inline-block bg-signal px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-signal-ink uppercase">
            Recommended
          </span>
        ) : null}
      </td>
      <td className="max-w-0 py-3 pr-3 align-top">
        <div className="truncate text-secondary">
          {option.transfers === 0 ? "Make no changes" : names || "—"}
        </div>
      </td>
      <td className="hidden py-3 pr-3 text-right align-top font-display text-base font-bold sm:table-cell">
        {epDelta(option.epGain)}
      </td>
      <td
        className={cn(
          "hidden py-3 pr-3 text-right align-top font-display text-base font-bold sm:table-cell",
          option.hitCost > 0 ? "text-danger" : "text-fainter",
        )}
      >
        {hit(option.hitCost)}
      </td>
      <td
        className={cn(
          "py-3 pr-3 text-right align-top font-display text-lg font-bold",
          option.netGain > 0 ? "text-accent" : "text-muted",
        )}
      >
        {epDelta(option.netGain)}
      </td>
      <td className="hidden py-3 pr-4 text-right align-top text-muted md:table-cell">
        {moneyDelta(option.costDelta)}
      </td>
    </tr>
  );
}

function PlayerCell({
  candidate,
  tone,
}: {
  candidate: Candidate | undefined;
  tone: "in" | "out";
}) {
  if (!candidate) return <div className="text-sm text-fainter">—</div>;
  return (
    <div className={cn("min-w-0", tone === "in" && "text-right")}>
      <div
        className={cn(
          "truncate text-sm",
          tone === "in" ? "font-semibold text-primary" : "text-muted line-through",
        )}
      >
        {candidate.name}
      </div>
      <div className="truncate text-xs text-muted">
        {candidate.positionShort} · {candidate.club} · {money(candidate.price)} ·{" "}
        {formatEp(candidate.ep)} pts over {DEFAULT_HORIZON} GWs
      </div>
    </div>
  );
}
