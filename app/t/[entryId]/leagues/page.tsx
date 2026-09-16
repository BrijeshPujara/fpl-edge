import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getDb, isDbConfigured } from "@/lib/db/client";
import { getEntryLeagues } from "@/lib/db/leagues";
import { standingsRevalidate, STANDINGS_REVALIDATE_SETTLED } from "@/lib/fpl/gameweek";
import { getSeasonContext } from "@/lib/fpl/season";
import { parseEntryId } from "@/lib/fpl/entry";
import { PageHeader } from "@/components/ui/panel";
import { Pending } from "@/components/ui/pending";
import { LeagueSelect } from "@/components/leagues/league-select";
import {
  LeagueTable,
  TableSkeleton,
  ordinal,
} from "@/components/leagues/league-table";

/**
 * League standings, one league at a time.
 *
 * Every league used to be stacked down one page, ten rows each, so finding the
 * one that mattered meant scrolling past the ones that did not. Now a selector
 * picks the league — kept in the URL as `?league=`, so a table can be linked
 * to and survives a refresh — and the table shows the whole first page of it
 * with the columns a mini-league is actually argued over: movement, chip,
 * hits, gameweek score, total.
 *
 * Nothing is configured. `entry/{id}/` lists every league a manager belongs to
 * and the app already registers them, so joining a league on the FPL site is
 * the entire setup.
 */
export default async function LeaguesPage({
  params,
  searchParams,
}: {
  params: Promise<{ entryId: string }>;
  searchParams: Promise<{ league?: string | string[] }>;
}) {
  const entryId = parseEntryId((await params).entryId);
  if (entryId === null) notFound();

  if (!isDbConfigured()) {
    return (
      <Pending phase="configuration">
        Supabase is not configured, so there is nowhere to record which leagues
        you are in.
      </Pending>
    );
  }

  const [memberships, season, query] = await Promise.all([
    getEntryLeagues(getDb(), entryId),
    getSeasonContext(),
    searchParams,
  ]);

  if (memberships.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="League standings" />
        <Pending phase="a squad sync">
          No leagues recorded yet. They are read from your entry rather than
          entered by hand, so they appear the first time your team is looked
          up — the nightly sync does it, or you can force it with{" "}
          <span className="font-medium text-tertiary">refresh squad</span> above.
        </Pending>
      </div>
    );
  }

  // With the API unreachable there is no way to tell a live gameweek from a
  // settled one, and the long window is the safe guess: it cannot make a stale
  // table staler, and the short one would hammer an API that is already failing.
  const revalidate = season.available
    ? standingsRevalidate(season.gameweek)
    : STANDINGS_REVALIDATE_SETTLED;

  // The gameweek the table's "GW" column scores — the latest one to have
  // started. Chips and hits are read for the same week, so a row can never
  // show one gameweek's score beside another's chip.
  const scoredGw = season.available
    ? (season.gameweek.current?.id ?? season.gameweek.previous?.id ?? null)
    : null;

  // Memberships arrive joined-leagues first, smallest first, so with no
  // choice made the default is the league someone is most likely to care about.
  const raw = Array.isArray(query.league) ? query.league[0] : query.league;
  const selected =
    memberships.find((m) => String(m.league.id) === raw) ?? memberships[0];

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <PageHeader
        title="League standings"
        subtitle={
          <>
            {selected.league.name}
            {selected.rank !== null ? (
              <>
                {" · "}
                <span className="font-medium text-primary">
                  you are {ordinal(selected.rank)}
                </span>
              </>
            ) : null}
          </>
        }
        actions={
          <LeagueSelect
            selected={selected.league.id}
            options={memberships.map((m) => ({
              id: m.league.id,
              name: m.league.name,
              kind: m.isPrivate ? "joined" : "global",
            }))}
          />
        }
      />

      {/* Keyed on the league, so switching shows the skeleton rather than the
          previous league's table sitting there looking current. */}
      <Suspense key={selected.league.id} fallback={<TableSkeleton />}>
        <LeagueTable
          membership={selected}
          entryId={entryId}
          revalidate={revalidate}
          scoredGw={scoredGw}
        />
      </Suspense>
    </div>
  );
}
