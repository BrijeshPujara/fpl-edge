import { notFound } from "next/navigation";
import { getSeasonContext } from "@/lib/fpl/season";
import { gameweekInPlay } from "@/lib/fpl/gameweek";
import { parseEntryId } from "@/lib/fpl/entry";
import { PageHeader } from "@/components/ui/panel";
import { Pending } from "@/components/ui/pending";
import { ScorelinePanel } from "@/components/dashboard/scoreline-panel";

/**
 * Scoreline predictions for the gameweek being played.
 *
 * Moved off the dashboard, where it sat under the plan and made the one screen
 * meant to be read in ten seconds need scrolling. Keyed on the gameweek IN
 * PLAY rather than the target, for the reason `gameweekInPlay` gives.
 */
export default async function FixturesPage({
  params,
}: {
  params: Promise<{ entryId: string }>;
}) {
  const entryId = parseEntryId((await params).entryId);
  if (entryId === null) notFound();

  const season = await getSeasonContext();
  if (!season.available) {
    return (
      <Pending phase="upstream recovery">
        The FPL API is unreachable, so the gameweek cannot be resolved.
      </Pending>
    );
  }

  const gameweek = gameweekInPlay(season.gameweek);

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <PageHeader
        title="Fixtures"
        subtitle={`Predicted scorelines for ${gameweek.name}`}
      />
      <ScorelinePanel entryId={entryId} gw={gameweek.id} />
    </div>
  );
}
