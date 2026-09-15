import {
  loadDecisionContext,
  type ReadyDecisionContext,
} from "@/lib/db/decision-context";
import { getChipsPlayed } from "@/lib/db/queries";
import { getDb, isDbConfigured } from "@/lib/db/client";
import { planChipsForSquad } from "@/lib/squad/chip-plan";
import {
  chipUrgency,
  playedChipSets,
  type ChipAssignment,
  type UnassignedChip,
} from "@/lib/engine/chips";
import { createGlpkSolver } from "@/lib/solver/glpk";
import { CHIP_SCAN_HORIZON } from "@/lib/engine/constants";
import { CHIP_LABEL, type ChipName } from "@/lib/rules";
import type { ChipWindow } from "@/lib/fpl/gameweek";
import { ep as formatEp } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Panel, SectionLabel } from "@/components/ui/panel";
import {
  NoEntry,
  Pending,
  PriorSeasonBasis,
} from "@/components/ui/pending";

/**
 * Which gameweek to play each chip.
 *
 * Solved rather than triggered — see `lib/engine/chips.ts`. The number worth
 * looking at on this screen is not the gain but the MARGIN: how much better the
 * chosen week is than the next-best week for the same chip. A wide margin is a
 * decision; a narrow one is a coin flip that should be revisited next week.
 */
export async function ChipAdvisories({ entryId }: { entryId: number }) {
  const context = await loadDecisionContext(entryId, CHIP_SCAN_HORIZON);

  if (context.state === "no-api") {
    return (
      <Pending phase="upstream recovery">
        The FPL API is unreachable, so chip windows cannot be resolved.
      </Pending>
    );
  }

  if (context.state === "no-db") {
    return (
      <Pending phase="configuration">
        Supabase is not configured, so there is no squad to value a chip
        against.
      </Pending>
    );
  }

  if (context.state === "no-entry") return <NoEntry />;

  if (context.state === "no-squad") {
    return (
      <Pending phase="the first deadline">
        Every chip is worth something only relative to the squad you own — a
        Bench Boost is your bench, a Triple Captain is your captain. No squad
        has been synced yet, so there is nothing to value. The windows and the
        blank and double calendar above are live now.
      </Pending>
    );
  }

  if (!context.projectable) {
    return (
      <Pending phase="gameweek 1">
        The planner is built and the windows are known, but no gameweek has been
        played. A Bench Boost is worth whatever your bench scores, and without
        appearance history the model cannot separate your bench from your
        starters — so every gameweek would look equally good and the
        recommendation would be an accident of ordering.
        <br />
        <br />
        Recommendations appear once results have synced for a completed
        gameweek. To see the screen working before then, run{" "}
        <code className="font-mono text-tertiary">npm run backtest</code> once
        and open <code className="font-mono text-tertiary">/preview/chips</code>{" "}
        in development.
      </Pending>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {context.basis === "prior-season" ? <PriorSeasonBasis /> : null}
      <ChipPlanPanels context={context} />
    </div>
  );
}

/**
 * The panels themselves, given a loaded context.
 *
 * Separated from the loading above so the dev preview renders exactly this
 * component rather than a lookalike that can drift from it.
 */
export async function ChipPlanPanels({
  context,
}: {
  context: ReadyDecisionContext;
}) {
  const solver = await createGlpkSolver();
  const played = await resolvePlayedChips(context.entryId, context.chipWindows);

  // The shared plan, so this screen, the dashboard and the shadow manager
  // cannot give three different answers. See `planChipsForSquad`.
  const plan = planChipsForSquad({
    squad: context.squad,
    pool: context.pool,
    gameweeks: context.gameweeks,
    budget: context.teamValue + context.bank,
    windows: context.chipWindows,
    currentGw: context.gw,
    played,
    priceDeltas: context.priceDeltas,
    solver,
  });

  const assignedKeys = new Set(
    plan.assignments.map((a) => `${a.chip}#${a.set}`),
  );

  return (
    <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section>
        <SectionLabel
          meta={`Scanning GW${context.gw}–${context.gw + CHIP_SCAN_HORIZON - 1}`}
        >
          The plan
        </SectionLabel>

        {plan.assignments.length === 0 ? (
          <Panel padded>
            <div className="font-display text-xl font-bold tracking-wide text-primary uppercase">
              Hold every chip
            </div>
            <p className="mt-1 max-w-prose text-sm leading-relaxed text-muted text-pretty">
              No chip earns its place in any gameweek currently in view. Holding
              is the recommendation, not a gap in the analysis — a chip played
              into a mediocre week is gone for good.
            </p>
          </Panel>
        ) : (
          <Panel>
            {plan.assignments.map((assignment) => (
              <AssignmentRow
                key={`${assignment.chip}#${assignment.set}`}
                assignment={assignment}
                currentGw={context.gw}
              />
            ))}
          </Panel>
        )}
      </section>

      <div className="flex flex-col gap-5">
        {plan.unassigned.length > 0 ? (
          <section>
            <SectionLabel>Not being played</SectionLabel>
            <Panel>
              {plan.unassigned.map((chip) => (
                <UnassignedRow key={`${chip.chip}#${chip.set}`} chip={chip} />
              ))}
            </Panel>
          </section>
        ) : null}

        <section>
          <SectionLabel meta="Rises as a window closes">Expiry pressure</SectionLabel>
          <Panel>
            {context.chipWindows
              .filter((w) => w.stopEvent >= context.gw)
              .map((window) => {
                const urgency = chipUrgency(
                  window,
                  context.gw,
                  assignedKeys.has(`${window.name}#${window.set}`),
                );
                return (
                  <UrgencyRow
                    key={`${window.name}#${window.set}`}
                    window={window}
                    urgency={urgency}
                    remaining={window.stopEvent - context.gw + 1}
                  />
                );
              })}
          </Panel>
        </section>
      </div>
    </div>
  );
}

/** Chips this manager has already used. See `playedChipSets`. */
async function resolvePlayedChips(
  entryId: number,
  windows: ChipWindow[],
): Promise<{ chip: ChipName; set: number }[]> {
  if (!isDbConfigured()) return [];
  return playedChipSets(await getChipsPlayed(getDb(), entryId), windows);
}

function SetTag({ set }: { set: number }) {
  return set > 1 ? (
    <span className="ml-1.5 text-xs font-normal text-muted">set {set}</span>
  ) : null;
}

function AssignmentRow({
  assignment,
  currentGw,
}: {
  assignment: ChipAssignment;
  currentGw: number;
}) {
  const thisWeek = assignment.gw === currentGw;
  const clear =
    assignment.marginOverNextBest !== null &&
    assignment.marginOverNextBest > assignment.gain * 0.2;

  return (
    <div
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-edge-subtle px-4 py-3.5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto_auto]",
        thisWeek && "bg-active shadow-[inset_4px_0_0_var(--text-primary)]",
      )}
    >
      <div className="min-w-0">
        <div className="text-base font-semibold text-primary">
          {assignment.label}
          <SetTag set={assignment.set} />
        </div>
        <div className="text-sm text-muted">
          {assignment.marginOverNextBest === null
            ? "No other week in this window is free"
            : `${formatEp(assignment.marginOverNextBest)} better than GW${assignment.nextBestGw}`}
          {assignment.marginOverNextBest !== null ? (
            <span
              className={cn(
                "ml-2 inline-block px-1.5 py-0.5 text-[10px] font-bold tracking-wide uppercase",
                clear
                  ? "bg-sunken text-tertiary"
                  : "bg-[color-mix(in_oklch,var(--warn)_14%,var(--surface-panel))] text-warn",
              )}
            >
              {clear ? "Clear call" : "Close call"}
            </span>
          ) : null}
        </div>
      </div>

      <div className="hidden text-right sm:block">
        <div className="text-xs font-medium text-muted">Worth</div>
        <div className="font-display text-xl font-bold text-accent">
          +{formatEp(assignment.gain)}
        </div>
      </div>

      <div className="text-right">
        <div className="text-xs font-medium text-muted">Play in</div>
        {thisWeek ? (
          <span className="inline-block bg-signal px-2 py-0.5 font-display text-base font-bold tracking-wide text-signal-ink uppercase">
            This week
          </span>
        ) : (
          <div className="font-display text-xl font-bold text-primary">
            GW{assignment.gw}
          </div>
        )}
      </div>
    </div>
  );
}

const REASON_COPY: Record<UnassignedChip["reason"], string> = {
  "already-played": "Already used this season",
  "window-closed": "The window has closed",
  "no-projections": "No projections inside the window yet",
  "no-positive-gain": "Worth nothing in any week currently in view",
  "gameweek-taken": "Its best week is worth more to another chip",
};

function UnassignedRow({ chip }: { chip: UnassignedChip }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-edge-subtle px-4 py-2.5 last:border-b-0">
      <div className="text-sm font-medium text-primary">
        {chip.label}
        <SetTag set={chip.set} />
      </div>
      <div className="text-xs text-muted">{REASON_COPY[chip.reason]}</div>
    </div>
  );
}

function UrgencyRow({
  window,
  urgency,
  remaining,
}: {
  window: ChipWindow;
  urgency: number;
  remaining: number;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_56px_72px] items-center gap-3 border-b border-edge-subtle px-4 py-2.5 last:border-b-0">
      <div className="truncate text-sm text-primary">
        {CHIP_LABEL[window.name]}
        <SetTag set={window.set} />
      </div>
      <div className="text-right font-display text-base font-bold text-muted">
        {remaining} GW
      </div>
      {/* A bar rather than a number: urgency is a feeling, not a measurement,
          and rendering it to three decimals would overstate what it knows. */}
      <div className="h-2 w-full bg-track">
        <div
          className={cn(
            "h-full",
            urgency > 0.66
              ? "bg-warn"
              : urgency > 0.33
                ? "bg-warn-dim"
                : "bg-track-strong",
          )}
          style={{ width: `${Math.round(urgency * 100)}%` }}
        />
      </div>
    </div>
  );
}
