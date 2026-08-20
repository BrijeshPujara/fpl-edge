import { notFound } from "next/navigation";
import { loadDecisionContext } from "@/lib/db/decision-context";
import { parseEntryId } from "@/lib/fpl/entry";
import { CaptainBoard } from "@/components/captain/captain-board";
import { NoEntry, Pending } from "@/components/ui/pending";

/**
 * The armband.
 *
 * Every other screen ranks on expected points, which is right for buying a
 * squad. This one shows the SHAPE of each candidate's outcome, because
 * doubling is linear — it cannot change which player has the highest mean — so
 * "highest EP" is only the right captain if you are indifferent to risk.
 *
 * The columns are the deviation, not the ranking: a manager protecting a
 * mini-league lead reads the floor, one chasing reads the haul probability,
 * and they can correctly reach different answers from the same table.
 */
export default async function CaptainPage({
  params,
}: {
  params: Promise<{ entryId: string }>;
}) {
  const entryId = parseEntryId((await params).entryId);
  if (entryId === null) notFound();

  // One gameweek, because captaincy is a one-week decision. The horizon that
  // governs a transfer is irrelevant to who wears the armband on Saturday.
  const context = await loadDecisionContext(entryId, 1);

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
        Supabase is not configured, so there is no squad to choose from.
      </Pending>
    );
  }
  if (context.state === "no-entry") return <NoEntry />;
  if (context.state === "no-squad") {
    return (
      <Pending phase="the first deadline">
        A captain is one of your own fifteen, and no squad has been synced yet.
        FPL publishes picks once a deadline has passed — after that,{" "}
        <span className="text-tertiary">refresh squad</span> pulls them in.
      </Pending>
    );
  }
  if (!context.projectable) {
    return (
      <Pending phase="gameweek 1">
        Captaincy turns on the shape of a player&apos;s outcome, and with
        nothing played the model cannot tell two players&apos; shapes apart.
      </Pending>
    );
  }

  return <CaptainBoard context={context} />;
}
