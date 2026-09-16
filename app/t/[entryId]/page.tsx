import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getSeasonContext } from "@/lib/fpl/season";
import { getFixtures } from "@/lib/fpl/client";
import {
  classifyGameweek,
  countFixturesByTeam,
  standingsRevalidate,
} from "@/lib/fpl/gameweek";
import { loadDecisionContext } from "@/lib/db/decision-context";
import { getDb, isDbConfigured } from "@/lib/db/client";
import { getEntryLeagues } from "@/lib/db/leagues";
import { getChipsPlayed } from "@/lib/db/queries";
import { playedChipSets } from "@/lib/engine/chips";
import { parseEntryId } from "@/lib/fpl/entry";
import { CHIP_SCAN_HORIZON, DEFAULT_HORIZON } from "@/lib/engine/constants";
import { loadSquadView } from "@/lib/squad/squad-view";
import { BriefPanel } from "@/components/dashboard/brief-panel";
import { FlagsCard } from "@/components/dashboard/flags-card";
import { GameweekScore } from "@/components/dashboard/gameweek-score";
import { WeekPlan } from "@/components/dashboard/week-plan";
import { LeagueTable, TableSkeleton } from "@/components/leagues/league-table";
import { Pitch } from "@/components/squad/pitch";
import { PageHeader, SectionLabel } from "@/components/ui/panel";
import { NoEntry, Pending, PriorSeasonBasis } from "@/components/ui/pending";

/**
 * The dashboard: this week's plan, then your team and your league.
 *
 * The plan answers what to do before the deadline. Beneath it sit the two
 * things a manager checks next — the eleven on the pitch and where they stand
 * in their league — each a compact version of its own page, with a link to it.
 * Chip windows live on Chips and scorelines on Fixtures; see `WeekPlan` for
 * why the plan itself stays three lines.
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
  const [context, chipContext, squad, memberships] = await Promise.all([
    loadDecisionContext(entryId, DEFAULT_HORIZON),
    loadDecisionContext(entryId, CHIP_SCAN_HORIZON),
    loadSquadView(entryId, season),
    isDbConfigured() ? getEntryLeagues(getDb(), entryId) : Promise.resolve([]),
  ]);

  const played =
    context.state === "ready" && chipContext.state === "ready"
      ? playedChipSets(await getChipsPlayed(getDb(), entryId), chipContext.chipWindows)
      : [];

  // The league someone is most likely to care about: joined leagues come
  // first, smallest first. See `getEntryLeagues`.
  const league = memberships[0] ?? null;
  const scoredGw = season.gameweek.current?.id ?? season.gameweek.previous?.id ?? null;
  const base = `/t/${entryId}`;

  return (
    <div className="flex flex-col gap-5 sm:gap-6">
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
                  <span className="font-medium text-tertiary">{target.name}</span>{" "}
                  locks.
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

      <div className="grid grid-cols-1 items-start gap-5 sm:gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <section>
          <SectionLabel meta={<SeeAll href={`${base}/squad`}>Full team</SeeAll>}>
            Your team
          </SectionLabel>
          {squad.state === "ready" ? (
            <Pitch squad={squad.view} live={squad.live} />
          ) : (
            <Pending phase="the first deadline">
              Your pitch appears once FPL publishes your picks, which happens when
              a gameweek deadline passes.
            </Pending>
          )}
        </section>

        <section>
          <SectionLabel meta={<SeeAll href={`${base}/leagues`}>All leagues</SeeAll>}>
            {league ? league.league.name : "League standings"}
          </SectionLabel>
          {league ? (
            <Suspense fallback={<TableSkeleton rows={4} />}>
              <LeagueTable
                membership={league}
                entryId={entryId}
                revalidate={standingsRevalidate(season.gameweek)}
                scoredGw={scoredGw}
                limit={6}
                compact
              />
            </Suspense>
          ) : (
            <Pending phase="a squad sync">
              No leagues recorded yet. They appear the first time your team is
              synced.
            </Pending>
          )}
        </section>
      </div>
    </div>
  );
}

function SeeAll({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="font-semibold text-primary underline underline-offset-4 hover:text-accent"
    >
      {children} →
    </Link>
  );
}
