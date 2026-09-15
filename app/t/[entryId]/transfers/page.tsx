import { notFound } from "next/navigation";
import { loadDecisionContext } from "@/lib/db/decision-context";
import { parseEntryId } from "@/lib/fpl/entry";
import { DEFAULT_HORIZON } from "@/lib/engine/constants";
import { TransferBoard } from "@/components/transfers/transfer-board";
import { PageHeader } from "@/components/ui/panel";
import {
  NoEntry,
  Pending,
  PriorSeasonBasis,
} from "@/components/ui/pending";

/**
 * Ranked transfer options.
 *
 * PLAN.md section 6's acceptance test is that this screen can recommend
 * ROLLING — doing nothing is a real answer and the most common correct one.
 * The roll is therefore always present as an option, never an absence.
 *
 * This route only decides WHICH state to render. The board itself lives in
 * `components/transfers/transfer-board.tsx`, shared with the dev preview.
 */
export default async function TransfersPage({
  params,
}: {
  params: Promise<{ entryId: string }>;
}) {
  const entryId = parseEntryId((await params).entryId);
  if (entryId === null) notFound();

  const context = await loadDecisionContext(entryId, DEFAULT_HORIZON);

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

  if (context.state === "no-entry") return <NoEntry />;

  if (context.state === "no-squad") {
    return (
      <Pending phase="the first deadline">
        No squad has been synced yet, and a transfer is a change to a squad. The
        FPL API only publishes picks once a gameweek deadline has passed, so
        there is nothing to move until{" "}
        <span className="font-medium text-tertiary">{context.gwName}</span> locks.
        After it does, <span className="font-medium text-tertiary">refresh squad</span>{" "}
        pulls your team in immediately.
      </Pending>
    );
  }

  // The honesty gate. With no gameweek played every projection is the same
  // positional prior, so a ranked table would be noise wearing the clothes of
  // analysis. PLAN.md is explicit that an invented number is worse than none.
  if (!context.projectable) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="Transfers" subtitle={`Judged over ${DEFAULT_HORIZON} gameweeks`} />
        <Pending phase="gameweek 1">
          The optimiser is built and the squad is loaded, but no gameweek has
          been played. Expected points need appearance history to mean anything,
          and without it the model cannot tell two midfielders apart — so every
          transfer would rank equally and the ordering would be an artefact of
          nothing.
          <br />
          <br />
          Ranked moves appear once results have synced for a completed
          gameweek. To see the screen working before then, run{" "}
          <code className="font-mono text-tertiary">npm run backtest</code> once
          and open{" "}
          <code className="font-mono text-tertiary">/preview/transfers</code> in
          development.
        </Pending>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {context.basis === "prior-season" ? <PriorSeasonBasis /> : null}
      <TransferBoard context={context} />
    </div>
  );
}
