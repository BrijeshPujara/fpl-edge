import Link from "next/link";
import { ArrowLeftRight, ArrowRight, Crown, Zap, type LucideIcon } from "lucide-react";
import type { ReadyDecisionContext } from "@/lib/db/decision-context";
import { toPlayerCandidate, type Candidate } from "@/lib/squad/candidates";
import { suggestTransfers } from "@/lib/engine/transfers";
import { captainAction } from "@/lib/engine/actions";
import { bestXi } from "@/lib/engine/best-xi";
import { planChipsForSquad } from "@/lib/squad/chip-plan";
import { createGlpkSolver } from "@/lib/solver/glpk";
import { DEFAULT_HORIZON } from "@/lib/engine/constants";
import {
  CHIP_LABEL,
  FREE_TRANSFERS_PER_GW,
  MAX_BANKED_FREE_TRANSFERS,
  type ChipName,
} from "@/lib/rules";
import { ep as formatEp, epDelta, hit } from "@/lib/format";
import { cn } from "@/lib/cn";
import { DeadlineCountdown } from "@/components/chrome/deadline-countdown";

/**
 * The dashboard: what to do before this deadline, and nothing else.
 *
 * It replaced a ranked action list, a fifteen-row EP distribution, a deadline
 * panel, a chip-window panel, a live score breakdown and a scoreline board, all
 * on one screen and all at the same weight. Each of those answered a real
 * question; together they buried the only one a manager opens the app to ask.
 *
 * So there are three lines — transfer, captain, chip — each a recommendation
 * with the one number that justifies it, each a link to the screen that shows
 * the working. A line always says something: "roll the transfer" and "hold your
 * chips" are answers, and usually the right ones.
 *
 * Shared with `/preview/dashboard`, so the harness renders exactly this.
 */
export async function WeekPlan({
  context,
  chipContext,
  played,
  deadline,
  shape,
}: {
  /** Loaded at DEFAULT_HORIZON, for transfers and the armband. */
  context: ReadyDecisionContext;
  /** Loaded at CHIP_SCAN_HORIZON — a chip plan needs weeks to compare. */
  chipContext: ReadyDecisionContext;
  played: { chip: ChipName; set: number }[];
  /** ISO deadline, or null when there is none to count down to. */
  deadline: string | null;
  /** "double" or "blank" when this gameweek is not an ordinary one. */
  shape: string | null;
}) {
  const solver = await createGlpkSolver();
  const byId = new Map(context.pool.map((c) => [c.id, c]));
  const name = (id: number) => byId.get(id)?.name ?? `#${id}`;
  const priceOf = (id: number) => context.priceDeltas.get(id) ?? 0;
  const base = `/t/${context.entryId}`;

  // --- Transfer ---------------------------------------------------------
  const suggestion = suggestTransfers(
    {
      currentSquad: context.squad.map((c) => toPlayerCandidate(c, priceOf(c.id))),
      candidates: context.pool.map((c) => toPlayerCandidate(c, priceOf(c.id))),
      freeTransfers: context.freeTransfers,
      // The one shared value, as the journal uses. This screen used to test
      // `basis !== "prior-season"`, which a single played gameweek satisfies.
      minutesKnown: context.minutesKnown,
      bank: context.bank,
    },
    solver,
    { priceWeight: "auto" },
  );
  const move = suggestion.recommended;
  const moving = move.transfers > 0 && move.netGain > 0;
  const bankedNextWeek = Math.min(
    MAX_BANKED_FREE_TRANSFERS,
    context.freeTransfers + FREE_TRANSFERS_PER_GW,
  );

  // --- Captain ----------------------------------------------------------
  // Chosen from the eleven expected to START. A captain on the bench scores
  // nothing, so ranking all fifteen could name a player you would not field.
  const epThisWeek = (c: Candidate) =>
    c.perGameweek.find((g) => g.gw === context.gw)?.ep ?? 0;
  const eleven = bestXi(
    context.squad.map((c) => ({ id: c.id, position: c.position, ep: epThisWeek(c) })),
  ).starting;
  const captain = captainAction(eleven.map((p) => ({ playerId: p.id, ep: p.ep })));

  // --- Chip -------------------------------------------------------------
  const plan = planChipsForSquad({
    squad: chipContext.squad,
    pool: chipContext.pool,
    gameweeks: chipContext.gameweeks,
    budget: chipContext.teamValue + chipContext.bank,
    windows: chipContext.chipWindows,
    currentGw: chipContext.gw,
    played,
    priceDeltas: chipContext.priceDeltas,
    solver,
  });
  const chipNow = plan.assignments.find((a) => a.gw === context.gw) ?? null;
  const nextChip = plan.assignments.find((a) => a.gw > context.gw) ?? null;

  return (
    <section className="overflow-hidden rounded-2xl border border-edge-strong bg-panel shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-edge-subtle bg-sunken px-5 py-4">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold tracking-wide text-primary uppercase">
            GW{context.gw} plan
          </h1>
          <p className="text-sm text-muted">
            What to do before the deadline
            {shape && shape !== "normal" ? (
              <>
                {" · "}
                <span className="font-medium text-warn">{shape} gameweek</span>
              </>
            ) : null}
          </p>
        </div>
        {deadline ? (
          <div className="text-right">
            <div className="text-xs font-medium text-muted">Deadline in</div>
            <div className="font-display text-2xl font-bold text-primary">
              <DeadlineCountdown deadline={deadline} />
            </div>
          </div>
        ) : null}
      </div>

      <PlanRow
        icon={ArrowLeftRight}
        label="Transfer"
        href={`${base}/transfers`}
        headline={
          moving
            ? `${move.playersOut.map((p) => name(p.id)).join(", ")} → ${move.playersIn.map((p) => name(p.id)).join(", ")}`
            : "Roll the transfer"
        }
        detail={
          moving
            ? move.hitCost > 0
              ? `+${formatEp(move.epGain)} over the next ${DEFAULT_HORIZON} gameweeks, less a ${hit(move.hitCost)} hit`
              : `+${formatEp(move.epGain)} over the next ${DEFAULT_HORIZON} gameweeks · free`
            : `Nothing beats saving it — you would have ${bankedNextWeek} free next week`
        }
        value={moving ? epDelta(move.netGain) : null}
      />

      <PlanRow
        icon={Crown}
        label="Captain"
        href={`${base}/captain`}
        headline={captain ? name(captain.playerId) : "No projection yet"}
        detail={
          captain
            ? [
                `${formatEp(captain.ep)} expected`,
                captain.runnerUpId !== null ? `vice ${name(captain.runnerUpId)}` : null,
                captain.runnerUpId !== null && captain.margin < 1 ? "a close call" : null,
              ]
                .filter(Boolean)
                .join(" · ")
            : "Projections need a played gameweek"
        }
        value={null}
      />

      <PlanRow
        icon={Zap}
        label="Chip"
        href={`${base}/chips`}
        emphasis={chipNow !== null}
        headline={chipNow ? `Play ${CHIP_LABEL[chipNow.chip]}` : "Hold your chips"}
        detail={
          chipNow
            ? chipNow.nextBestGw === null
              ? `+${formatEp(chipNow.gain)} this week — no other week in view is worth it`
              : `+${formatEp(chipNow.gain)} this week, better than GW${chipNow.nextBestGw} by ${formatEp(chipNow.marginOverNextBest ?? 0)}`
            : nextChip
              ? `Best week in view: ${CHIP_LABEL[nextChip.chip]} in GW${nextChip.gw}`
              : "No chip is worth playing in the weeks in view"
        }
        value={chipNow ? epDelta(chipNow.gain) : null}
      />
    </section>
  );
}

function PlanRow({
  icon: Icon,
  label,
  headline,
  detail,
  value,
  href,
  emphasis = false,
}: {
  icon: LucideIcon;
  label: string;
  headline: string;
  detail: string;
  value: string | null;
  href: string;
  emphasis?: boolean;
}) {
  return (
    <Link
      href={href}
      className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 border-b border-edge-subtle px-5 py-4 last:border-b-0 hover:bg-panel-hover"
    >
      <span
        className={cn(
          "grid size-10 place-items-center rounded-xl",
          // Yellow for the three decisions; black when the chip line is asking
          // for action this week, so the one that needs doing stands apart.
          emphasis ? "bg-sidebar text-signal" : "bg-signal text-signal-ink",
        )}
      >
        <Icon aria-hidden className="size-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-medium text-muted">{label}</span>
        {/* Wraps rather than truncates: on a phone a two-move transfer cut to
            "Tzolis, Pedro Porro →…" hides exactly who is coming in. */}
        <span className="block text-base font-semibold text-primary text-pretty">
          {headline}
        </span>
        <span className="block text-sm text-muted text-pretty">{detail}</span>
      </span>
      <span className="flex items-center gap-2">
        {value ? (
          <span className="text-base font-semibold text-accent">{value}</span>
        ) : null}
        <ArrowRight
          aria-hidden
          className="size-4 text-ghost transition-transform group-hover:translate-x-0.5 group-hover:text-muted"
        />
      </span>
    </Link>
  );
}
