import { notFound } from "next/navigation";
import { getSeasonContext } from "@/lib/fpl/season";
import { getFixtures } from "@/lib/fpl/client";
import { classifyGameweek, countFixturesByTeam } from "@/lib/fpl/gameweek";
import { loadDecisionContext } from "@/lib/db/decision-context";
import { getDb } from "@/lib/db/client";
import { getChipsPlayed } from "@/lib/db/queries";
import { playedChipSets } from "@/lib/engine/chips";
import { parseEntryId } from "@/lib/fpl/entry";
import { CHIP_SCAN_HORIZON, DEFAULT_HORIZON } from "@/lib/engine/constants";
import { BriefPanel } from "@/components/dashboard/brief-panel";
import { FlagsCard } from "@/components/dashboard/flags-card";
import { GameweekScore } from "@/components/dashboard/gameweek-score";
import { WeekPlan } from "@/components/dashboard/week-plan";
import { PageHeader } from "@/components/ui/panel";
import { NoEntry, Pending, PriorSeasonBasis } from "@/components/ui/pending";

/**
 * The dashboard: this week's plan, last week's score, and who is injured.
 *
 * Everything else it used to carry has a home of its own — the EP list and the
 * live breakdown on My Team, chip windows on Chips, scorelines on Fixtures. See
 * `WeekPlan` for why.
 */
export default async function DashboardPage({
  params,
}: {
  params: Promise<{ entryId: string }>;
}) {
  // Validated by the layout above; parsed again here because a page cannot
  // assume its layout ran the check, and a bad id must never reach a query.
  const entryId = parseEntryId((await params).entryId);
  if (entryId === null) notFound();

  const season = await getSeasonContext();

  if (!season.available) {
    return (
      <Pending phase="upstream recovery">
        The dashboard reads its gameweek, deadline and chip windows from the FPL
        API. It is currently unreachable, so there is nothing truthful to show.
      </Pending>
    );
  }

  const { target } = season.gameweek;

  // Blank and double detection needs only the fixture list, no model.
  const fixtures = await getFixtures().catch(() => null);
  const shape =
    fixtures === null
      ? null
      : classifyGameweek(
          countFixturesByTeam(
            fixtures,
            season.teams.map((t) => t.id),
          ).get(target.id),
        );

  // Two horizons, because the questions differ: a transfer is judged over the
  // weeks it has to pay back in, a chip over the weeks it could be played in.
  const [context, chipContext] = await Promise.all([
    loadDecisionContext(entryId, DEFAULT_HORIZON),
    loadDecisionContext(entryId, CHIP_SCAN_HORIZON),
  ]);

  const played =
    context.state === "ready" && chipContext.state === "ready"
      ? playedChipSets(await getChipsPlayed(getDb(), entryId), chipContext.chipWindows)
      : [];

  return (
    <div className="grid grid-cols-1 items-start gap-5 sm:gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex flex-col gap-5">
        {context.state === "ready" &&
        context.projectable &&
        chipContext.state === "ready" ? (
          <>
            {context.basis === "prior-season" ? <PriorSeasonBasis /> : null}
            <WeekPlan
              context={context}
              chipContext={chipContext}
              played={played}
              deadline={target.deadline_time}
              shape={shape}
            />
            <BriefPanel entryId={entryId} gw={context.gw} />
          </>
        ) : (
          <>
            <PageHeader title={`GW${target.id} plan`} />
            {context.state === "no-db" ? (
              <Pending phase="configuration">
                Supabase is not configured, so there is no squad to advise on.
              </Pending>
            ) : context.state === "no-entry" ? (
              <NoEntry />
            ) : context.state === "no-squad" ? (
              <Pending phase="the first deadline">
                The engine is built and waiting. FPL only publishes a
                manager&apos;s picks once a gameweek deadline has passed, so
                there is no squad to advise on until{" "}
                <span className="text-tertiary">{target.name}</span> locks.
              </Pending>
            ) : (
              <Pending phase="gameweek 1">
                Your squad is loaded, but no gameweek has been played.
                Expected points need appearance history, and without it every
                player projects the same — so a plan would be an ordering of
                nothing.
              </Pending>
            )}
          </>
        )}
      </div>

      <div className="flex flex-col gap-4">
        <GameweekScore entryId={entryId} season={season} />
        {context.state === "ready" ? <FlagsCard squad={context.squad} /> : null}
      </div>
    </div>
  );
}
