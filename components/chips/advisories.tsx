import {
  loadDecisionContext,
  type ReadyDecisionContext,
} from "@/lib/db/decision-context";
import { getChipsPlayed } from "@/lib/db/queries";
import { getDb, isDbConfigured } from "@/lib/db/client";
import { toPlayerCandidate } from "@/lib/squad/candidates";
import { computeChipGains } from "@/lib/engine/chip-gains";
import {
  chipUrgency,
  planChips,
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
import { Panel, Row, SectionLabel } from "@/components/ui/panel";
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
        blank/double calendar above are live now.
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
        Recommendations appear once{" "}
        <span className="text-tertiary">results have synced</span> for a
        completed gameweek. To see the screen working before then, run{" "}
        <code className="font-mono text-tertiary">npm run backtest</code> once
        and open <code className="font-mono text-tertiary">/preview/chips</code>{" "}
        in development.
      </Pending>
    );
  }

  return (
    <>
      {context.basis === "prior-season" ? <PriorSeasonBasis /> : null}
      <ChipPlanPanels context={context} />
    </>
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
  const priceOf = (id: number) => context.priceDeltas.get(id) ?? 0;
  const withGameweeks = (c: (typeof context.pool)[number]) => ({
    ...toPlayerCandidate(c, priceOf(c.id)),
    epByGameweek: new Map(c.perGameweek.map((g) => [g.gw, g.ep])),
  });

  const gains = computeChipGains({
    squad: context.squad.map(withGameweeks),
    pool: context.pool.map(withGameweeks),
    gameweeks: context.gameweeks,
    budget: context.teamValue + context.bank,
    windows: context.chipWindows,
    currentGw: context.gw,
    solver,
  });

  const played = await resolvePlayedChips(context.entryId, context.chipWindows);

  const plan = planChips({
    windows: context.chipWindows,
    gains,
    alreadyPlayed: played,
    currentGw: context.gw,
    solver,
  });

  const assignedKeys = new Set(
    plan.assignments.map((a) => `${a.chip}#${a.set}`),
  );

  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <div>
        <SectionLabel
          meta={`SCANNING GW${context.gw}–${context.gw + CHIP_SCAN_HORIZON - 1}`}
        >
          CHIP PLAN
        </SectionLabel>

        {plan.assignments.length === 0 ? (
          <Panel padded>
            <div className="font-mono text-tiny tracking-[0.14em] text-warn">
              NOTHING WORTH PLAYING YET
            </div>
            <div className="mt-2 max-w-prose text-small leading-relaxed text-muted text-pretty">
              No chip earns its place in any gameweek currently in view. Holding
              is the recommendation, not a gap in the analysis — a chip played
              into a mediocre week is gone for good.
            </div>
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
      </div>

      {plan.unassigned.length > 0 ? (
        <div>
          <SectionLabel meta="AND WHY">NOT PLAYED</SectionLabel>
          <Panel>
            {plan.unassigned.map((chip) => (
              <UnassignedRow key={`${chip.chip}#${chip.set}`} chip={chip} />
            ))}
          </Panel>
        </div>
      ) : null}

      <div>
        <SectionLabel meta="RISES AS A WINDOW CLOSES">
          EXPIRY PRESSURE
        </SectionLabel>
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

function AssignmentRow({
  assignment,
  currentGw,
}: {
  assignment: ChipAssignment;
  currentGw: number;
}) {
  const thisWeek = assignment.gw === currentGw;

  return (
    <Row
      height="tall"
      className="grid grid-cols-[1fr_auto] gap-3 py-2 md:grid-cols-[1fr_84px_84px_92px]"
    >
      <div className="min-w-0 self-center">
        <div className="text-body text-primary">
          {assignment.label}
          {assignment.set > 1 ? (
            <span className="ml-1.5 font-mono text-micro text-fainter">
              SET {assignment.set}
            </span>
          ) : null}
        </div>
        <div className="font-mono text-micro tracking-[0.1em] text-fainter">
          {assignment.marginOverNextBest === null ? (
            <>NO OTHER WEEK FREE IN THIS WINDOW</>
          ) : (
            <>
              {formatEp(assignment.marginOverNextBest)} BETTER THAN GW
              {assignment.nextBestGw}
            </>
          )}
        </div>
      </div>

      <div className="flex flex-col justify-center text-right">
        <div className="font-mono text-micro tracking-[0.12em] text-label">
          PLAY IN
        </div>
        <div
          className={cn(
            "font-mono text-cell",
            thisWeek ? "text-accent" : "text-primary",
          )}
        >
          GW{assignment.gw}
        </div>
      </div>

      <div className="hidden flex-col justify-center text-right md:flex">
        <div className="font-mono text-micro tracking-[0.12em] text-label">
          GAIN
        </div>
        <div className="font-mono text-cell text-accent">
          +{formatEp(assignment.gain)}
        </div>
      </div>

      <div className="hidden flex-col justify-center text-right md:flex">
        <div className="font-mono text-micro tracking-[0.12em] text-label">
          CONFIDENCE
        </div>
        <div className="font-mono text-cell text-muted">
          {assignment.marginOverNextBest === null
            ? "—"
            : assignment.marginOverNextBest > assignment.gain * 0.2
              ? "CLEAR"
              : "NARROW"}
        </div>
      </div>
    </Row>
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
    <Row height="table" className="flex items-center justify-between gap-3">
      <div className="text-small text-muted">
        {chip.label}
        {chip.set > 1 ? (
          <span className="ml-1.5 font-mono text-micro text-fainter">
            SET {chip.set}
          </span>
        ) : null}
      </div>
      <div className="text-right font-mono text-micro tracking-[0.08em] text-fainter">
        {REASON_COPY[chip.reason].toUpperCase()}
      </div>
    </Row>
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
    <Row height="table" className="grid grid-cols-[1fr_64px_88px] gap-3">
      <div className="self-center text-small text-muted">
        {CHIP_LABEL[window.name]}
        {window.set > 1 ? (
          <span className="ml-1.5 font-mono text-micro text-fainter">
            SET {window.set}
          </span>
        ) : null}
      </div>
      <div className="self-center text-right font-mono text-cell text-muted">
        {remaining} GW
      </div>
      <div className="flex items-center justify-end gap-2">
        {/* A bar rather than a number: urgency is a feeling, not a measurement,
            and rendering it to three decimals would overstate what it knows. */}
        <div className="h-1 w-14 bg-track">
          <div
            className={cn(
              "h-full",
              urgency > 0.66
                ? "bg-warn"
                : urgency > 0.33
                  ? "bg-accent-dim"
                  : "bg-track-strong",
            )}
            style={{ width: `${Math.round(urgency * 100)}%` }}
          />
        </div>
      </div>
    </Row>
  );
}
