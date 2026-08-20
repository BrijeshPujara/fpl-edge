import { loadDecisionContext } from "@/lib/db/decision-context";
import { toPlayerCandidate, type Candidate } from "@/lib/squad/candidates";
import { suggestTransfers, type TransferOption } from "@/lib/engine/transfers";
import { createGlpkSolver } from "@/lib/solver/glpk";
import { DEFAULT_HORIZON } from "@/lib/engine/constants";
import { HIT_BREAK_EVEN_EP, TRANSFER_HIT_COST } from "@/lib/rules";
import { ep as formatEp, epDelta, hit, money, moneyDelta } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Panel, Row, SectionLabel, StatRow } from "@/components/ui/panel";
import { Pending } from "@/components/ui/pending";

/**
 * Ranked transfer options.
 *
 * PLAN.md section 6's acceptance test is that this screen can recommend
 * ROLLING — doing nothing is a real answer and the most common correct one.
 * The roll is therefore always present as an option here, never an absence.
 */
export default async function TransfersPage() {
  const context = await loadDecisionContext(DEFAULT_HORIZON);

  if (context.state === "no-api") {
    return (
      <Pending phase="upstream recovery">
        The FPL API is unreachable, so the gameweek cannot be resolved.
      </Pending>
    );
  }

  if (context.state === "no-db") {
    return (
      <Pending phase="configuration">
        Supabase is not configured. Set{" "}
        <code className="font-mono text-tertiary">NEXT_PUBLIC_SUPABASE_URL</code>{" "}
        and{" "}
        <code className="font-mono text-tertiary">SUPABASE_SERVICE_ROLE_KEY</code>
        .
      </Pending>
    );
  }

  if (context.state === "no-squad") {
    return (
      <Pending phase="the first deadline">
        No squad has been synced yet, and a transfer is a change to a squad. The
        FPL API only publishes picks once a gameweek deadline has passed, so
        there is nothing to move until{" "}
        <span className="text-tertiary">{context.gwName}</span> locks.
      </Pending>
    );
  }

  // The honesty gate. With no gameweek played every projection is the same
  // positional prior, so a ranked table would be noise wearing the clothes of
  // analysis. PLAN.md is explicit that an invented number is worse than none.
  if (!context.projectable) {
    return (
      <div>
        <SectionLabel meta={`HORIZON ${DEFAULT_HORIZON} GW`}>
          TRANSFER CANDIDATES
        </SectionLabel>
        <Pending phase="gameweek 1">
          The optimiser is built and the squad is loaded, but no gameweek has
          been played. Expected points need appearance history to mean anything,
          and without it the model cannot tell two midfielders apart — so every
          transfer would rank equally and the ordering would be an artefact of
          nothing.
          <br />
          <br />
          Ranked moves appear once{" "}
          <span className="text-tertiary">results have synced</span> for a
          completed gameweek.
        </Pending>
      </div>
    );
  }

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

  const { recommended } = suggestion;

  return (
    <div className="grid grid-cols-1 items-start gap-4 sm:gap-6 lg:grid-cols-[1fr_300px]">
      <div className="flex flex-col gap-4 sm:gap-6">
        <div>
          <SectionLabel
            meta={`HORIZON ${DEFAULT_HORIZON} GW · ${context.freeTransfers} FREE`}
          >
            TRANSFER OPTIONS · GW{context.gw}
          </SectionLabel>

          <Panel>
            {suggestion.options.map((option) => (
              <OptionRow
                key={option.transfers}
                option={option}
                byId={byId}
                recommended={option === recommended}
              />
            ))}
          </Panel>
        </div>

        <div>
          <SectionLabel meta={`HIT = ${TRANSFER_HIT_COST} PTS PER EXTRA MOVE`}>
            THE VERDICT
          </SectionLabel>
          <Panel padded>
            <div
              className={cn(
                "font-mono text-tiny tracking-[0.14em]",
                suggestion.shouldRoll ? "text-warn" : "text-accent",
              )}
            >
              {suggestion.shouldRoll ? "ROLL THE TRANSFER" : "MAKE THE MOVE"}
            </div>
            <div className="mt-2 max-w-prose text-small leading-relaxed text-muted text-pretty">
              {suggestion.shouldRoll ? (
                <>
                  Nothing available clears the {HIT_BREAK_EVEN_EP}-point bar it
                  would cost. Banking the transfer keeps the option open and
                  carries it into next week, which is worth more than a move
                  that pays for itself and no more.
                </>
              ) : (
                <>
                  {recommended.transfers === 1 ? "One move" : `${recommended.transfers} moves`}{" "}
                  gains {formatEp(recommended.epGain)} points over{" "}
                  {DEFAULT_HORIZON} gameweeks
                  {recommended.hitCost > 0 ? (
                    <>
                      {" "}
                      and costs {recommended.hitCost} in hits, netting{" "}
                      {formatEp(recommended.netGain)}
                    </>
                  ) : (
                    <> at no cost, the transfer being free</>
                  )}
                  .
                </>
              )}
            </div>
          </Panel>
        </div>

        {recommended.transfers > 0 ? (
          <div>
            <SectionLabel meta="OUT → IN">RECOMMENDED MOVES</SectionLabel>
            <Panel>
              {recommended.playersOut.map((out, i) => {
                const incoming = recommended.playersIn[i];
                const a = byId.get(out.id);
                const b = incoming ? byId.get(incoming.id) : undefined;
                return (
                  <Row
                    key={out.id}
                    height="tall"
                    className="grid grid-cols-[1fr_16px_1fr] gap-2"
                  >
                    <PlayerCell candidate={a} tone="out" />
                    <div className="self-center text-center font-mono text-tiny text-fainter">
                      →
                    </div>
                    <PlayerCell candidate={b} tone="in" />
                  </Row>
                );
              })}
            </Panel>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-4 sm:gap-6">
        <div>
          <SectionLabel>POSITION</SectionLabel>
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
        </div>

        <div>
          <SectionLabel>WHAT £0.1M BUYS</SectionLabel>
          <Panel>
            <StatRow
              label="Marginal EP per £0.1m"
              value={
                recommended.marginalEpPerTenth === null
                  ? "—"
                  : recommended.marginalEpPerTenth.toFixed(3)
              }
              tone={
                recommended.marginalEpPerTenth === null ? "muted" : "accent"
              }
            />
          </Panel>
          <div className="mt-2 max-w-prose text-small leading-relaxed text-dim text-pretty">
            {recommended.marginalEpPerTenth === null ? (
              <>
                Rolling needs no solve, so there is no shadow price to read. An
                em dash rather than a zero: zero would claim money is worth
                nothing here, which is a different and much stronger statement.
              </>
            ) : recommended.marginalEpPerTenth === 0 ? (
              <>
                Budget is not binding. Extra money buys nothing at this squad,
                so holding cash for a rainy day costs you nothing — and gains
                you nothing either.
              </>
            ) : (
              <>
                A local estimate from the LP dual. The true marginal is a step
                function: an extra £0.1m buys nothing until it crosses a
                threshold, then buys a whole upgrade at once.
              </>
            )}
          </div>
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
    <Row
      height="tall"
      className="grid grid-cols-[64px_1fr_auto] gap-3 md:grid-cols-[64px_1fr_repeat(4,72px)]"
      hover
    >
      <div className="self-center">
        <div
          className={cn(
            "font-mono text-cell",
            recommended ? "text-accent" : "text-primary",
          )}
        >
          {option.transfers === 0 ? "ROLL" : `${option.transfers}×`}
        </div>
      </div>

      <div className="min-w-0 self-center">
        <div className="truncate text-small text-secondary">
          {option.transfers === 0 ? "Make no changes" : names || "—"}
        </div>
        {recommended ? (
          <div className="font-mono text-micro tracking-[0.12em] text-accent">
            RECOMMENDED
          </div>
        ) : null}
      </div>

      {/* On a phone only the deciding number survives; the breakdown needs a
          wider viewport to stay legible as a table. */}
      <Cell label="NET" className="md:hidden">
        <span className={option.netGain > 0 ? "text-accent" : "text-muted"}>
          {epDelta(option.netGain)}
        </span>
      </Cell>

      <Cell label="EP GAIN" className="hidden md:flex">
        {epDelta(option.epGain)}
      </Cell>
      <Cell label="HIT" className="hidden md:flex">
        <span className={option.hitCost > 0 ? "text-warn" : "text-muted"}>
          {hit(option.hitCost)}
        </span>
      </Cell>
      <Cell label="NET" className="hidden md:flex">
        <span className={option.netGain > 0 ? "text-accent" : "text-muted"}>
          {epDelta(option.netGain)}
        </span>
      </Cell>
      <Cell label="COST" className="hidden md:flex">
        <span className="text-muted">{moneyDelta(option.costDelta)}</span>
      </Cell>
    </Row>
  );
}

function Cell({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col justify-center text-right", className)}>
      <div className="font-mono text-micro tracking-[0.12em] text-label">
        {label}
      </div>
      <div className="font-mono text-cell text-primary">{children}</div>
    </div>
  );
}

function PlayerCell({
  candidate,
  tone,
}: {
  candidate: Candidate | undefined;
  tone: "in" | "out";
}) {
  if (!candidate) return <div className="text-small text-fainter">—</div>;
  return (
    <div className="min-w-0 self-center">
      <div
        className={cn(
          "truncate text-small",
          tone === "in" ? "text-primary" : "text-muted line-through",
        )}
      >
        {candidate.name}
      </div>
      <div className="font-mono text-micro tracking-[0.1em] text-fainter">
        {candidate.positionShort} · {candidate.club} · {money(candidate.price)} ·{" "}
        {formatEp(candidate.ep)} EP
      </div>
    </div>
  );
}
