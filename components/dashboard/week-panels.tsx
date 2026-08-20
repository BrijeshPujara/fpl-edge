import type { ReadyDecisionContext } from "@/lib/db/decision-context";
import { toPlayerCandidate, type Candidate } from "@/lib/squad/candidates";
import { suggestTransfers } from "@/lib/engine/transfers";
import { computeChipGains } from "@/lib/engine/chip-gains";
import { planChips } from "@/lib/engine/chips";
import { rankActions, type Action } from "@/lib/engine/actions";
import { createGlpkSolver } from "@/lib/solver/glpk";
import { DEFAULT_HORIZON } from "@/lib/engine/constants";
import { CHIP_LABEL } from "@/lib/rules";
import { ep as formatEp, epDelta, hit, money } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Panel, Row, SectionLabel } from "@/components/ui/panel";

/**
 * The dashboard's two live panels: what to do this week, and where the points
 * are sitting.
 *
 * Shared with `/preview/dashboard`, so the harness renders exactly this rather
 * than a lookalike.
 */
export async function WeekPanels({
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
      bank: context.bank,
    },
    solver,
    { priceWeight: "auto" },
  );

  // Only THIS gameweek is scanned for a chip. The dashboard answers "what do I
  // do before this deadline"; a chip worth playing in six weeks belongs on
  // /chips, and scanning the full horizon here would cost twenty solves to
  // render a panel that then discards nineteen of them.
  const withGameweeks = (c: Candidate) => ({
    ...toPlayerCandidate(c, priceOf(c.id)),
    epByGameweek: new Map(c.perGameweek.map((g) => [g.gw, g.ep])),
  });

  const gains = computeChipGains({
    squad: context.squad.map(withGameweeks),
    pool: context.pool.map(withGameweeks),
    gameweeks: [context.gw],
    budget: context.teamValue + context.bank,
    windows: context.chipWindows,
    currentGw: context.gw,
    solver,
  });

  const chipPlan = planChips({
    windows: context.chipWindows,
    gains,
    currentGw: context.gw,
    solver,
  });
  const chipNow = chipPlan.assignments.find((a) => a.gw === context.gw) ?? null;

  const epThisWeek = (c: Candidate) =>
    c.perGameweek.find((g) => g.gw === context.gw)?.ep ?? 0;

  const actions = rankActions({
    transfer:
      suggestion.recommended.transfers > 0
        ? {
            transfers: suggestion.recommended.transfers,
            playersIn: suggestion.recommended.playersIn.map((p) => p.id),
            playersOut: suggestion.recommended.playersOut.map((p) => p.id),
            epGain: suggestion.recommended.epGain,
            hitCost: suggestion.recommended.hitCost,
            netGain: suggestion.recommended.netGain,
          }
        : null,
    squadThisWeek: context.squad.map((c) => ({
      playerId: c.id,
      ep: epThisWeek(c),
    })),
    chipThisWeek: chipNow
      ? {
          chip: chipNow.chip,
          set: chipNow.set,
          gain: chipNow.gain,
          margin: chipNow.marginOverNextBest,
        }
      : null,
  });

  const ranked = [...context.squad]
    .map((c) => ({ candidate: c, ep: epThisWeek(c) }))
    .sort((a, b) => b.ep - a.ep);
  const ceiling = ranked[0]?.ep ?? 0;

  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <div>
        <SectionLabel meta={`HORIZON ${DEFAULT_HORIZON} GW · ${context.freeTransfers} FREE`}>
          RECOMMENDED ACTIONS
        </SectionLabel>
        <Panel>
          {actions.slice(0, 3).map((action, index) => (
            <ActionRow
              key={`${action.kind}-${index}`}
              action={action}
              byId={byId}
              primary={index === 0}
            />
          ))}
        </Panel>
      </div>

      <div>
        <SectionLabel meta="THIS GAMEWEEK ONLY">
          SQUAD EP DISTRIBUTION
        </SectionLabel>
        <Panel>
          {ranked.map(({ candidate, ep }) => (
            <Row
              key={candidate.id}
              height="table"
              className="grid grid-cols-[1fr_44px_54px] items-center gap-2.5"
            >
              <div className="flex min-w-0 items-center gap-2">
                <div className="truncate text-small text-secondary">
                  {candidate.name}
                </div>
                <div className="font-mono text-micro tracking-[0.1em] text-fainter">
                  {candidate.positionShort} · {candidate.club}
                </div>
                {candidate.flag ? (
                  <div className="font-mono text-micro text-warn">FLAG</div>
                ) : null}
              </div>
              {/* A bar rather than a second number: the shape of the squad is
                  the point, and fifteen right-aligned decimals do not show it. */}
              <div className="h-1 bg-track">
                <div
                  className={cn(
                    "h-full",
                    ep >= ceiling * 0.66 ? "bg-accent" : "bg-accent-dim",
                  )}
                  style={{
                    width: ceiling > 0 ? `${Math.round((ep / ceiling) * 100)}%` : "0%",
                  }}
                />
              </div>
              <div className="text-right font-mono text-cell text-primary">
                {formatEp(ep)}
              </div>
            </Row>
          ))}
        </Panel>
      </div>
    </div>
  );
}

function ActionRow({
  action,
  byId,
  primary,
}: {
  action: Action;
  byId: Map<number, Candidate>;
  primary: boolean;
}) {
  const name = (id: number) => byId.get(id)?.name ?? `#${id}`;

  const content = (() => {
    switch (action.kind) {
      case "transfer":
        return {
          tag: action.transfers === 1 ? "TRANSFER" : `${action.transfers} TRANSFERS`,
          headline: `${action.playersOut.map(name).join(", ")} → ${action.playersIn.map(name).join(", ")}`,
          detail:
            action.hitCost > 0
              ? `Gains ${formatEp(action.epGain)} over the horizon and costs ${hit(action.hitCost)} in hits.`
              : `Gains ${formatEp(action.epGain)} over the horizon, free.`,
          value: epDelta(action.netGain),
        };
      case "captain":
        return {
          tag: "CAPTAIN",
          headline: name(action.playerId),
          detail:
            action.runnerUpId === null
              ? "No alternative in the squad."
              : action.margin < 1
                ? `Barely ahead of ${name(action.runnerUpId)} — this call is close to a coin flip.`
                : `Clear of ${name(action.runnerUpId)}, the next best option.`,
          value: epDelta(action.impact),
        };
      case "chip":
        return {
          tag: "CHIP",
          headline: `Play ${CHIP_LABEL[action.chip]}`,
          detail:
            action.margin === null
              ? "No better week available inside the window."
              : `Better than the next available week by ${formatEp(action.margin)}.`,
          value: epDelta(action.gain),
        };
      case "hold":
        return {
          tag: "HOLD",
          headline: "Do nothing",
          detail:
            "Nothing on offer clears the points it would cost. Banking the transfer is worth more than a move that only pays for itself.",
          value: "—",
        };
    }
  })();

  return (
    <Row height="auto" className="grid grid-cols-[1fr_auto] gap-3">
      <div className="min-w-0 self-center">
        <div
          className={cn(
            "font-mono text-micro tracking-[0.14em]",
            primary ? "text-accent" : "text-label",
          )}
        >
          {content.tag}
        </div>
        <div className="truncate text-body text-primary">{content.headline}</div>
        <div className="text-small text-muted text-pretty">{content.detail}</div>
      </div>
      <div className="flex flex-col justify-center text-right">
        <div className="font-mono text-micro tracking-[0.12em] text-label">
          AT STAKE
        </div>
        <div
          className={cn(
            "font-mono text-cell",
            action.kind === "hold" ? "text-muted" : "text-accent",
          )}
        >
          {content.value}
        </div>
      </div>
    </Row>
  );
}

/** Flagged players in the squad, for the sidebar. */
export function FlagPanel({ squad }: { squad: Candidate[] }) {
  const flagged = squad.filter((c) => c.flag !== null);

  if (flagged.length === 0) {
    return (
      <Panel>
        <Row height="table" className="flex">
          <div className="text-small text-muted">
            No fitness concerns in the fifteen.
          </div>
        </Row>
      </Panel>
    );
  }

  return (
    <Panel>
      {flagged.map((candidate) => (
        <Row key={candidate.id} height="auto" className="flex flex-col justify-center gap-0.5">
          <div className="flex items-baseline justify-between gap-2">
            <div className="text-small text-primary">{candidate.name}</div>
            <div className="font-mono text-micro text-warn">
              {candidate.flag?.chance === null
                ? "UNAVAILABLE"
                : `${candidate.flag?.chance}%`}
            </div>
          </div>
          <div className="text-small leading-snug text-muted text-pretty">
            {candidate.flag?.note}
          </div>
          <div className="font-mono text-micro tracking-[0.1em] text-fainter">
            {money(candidate.price)} · {candidate.positionShort} · {candidate.club}
          </div>
        </Row>
      ))}
    </Panel>
  );
}
