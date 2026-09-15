import { Suspense } from "react";
import { notFound } from "next/navigation";
import { ArrowDown, ArrowUp } from "lucide-react";
import { getDb, isDbConfigured } from "@/lib/db/client";
import { getEntryLeagues, type LeagueMembership } from "@/lib/db/leagues";
import {
  FplSchemaError,
  getEntryHistory,
  getLeagueStandings,
} from "@/lib/fpl/client";
import { standingsRevalidate, STANDINGS_REVALIDATE_SETTLED } from "@/lib/fpl/gameweek";
import { getSeasonContext } from "@/lib/fpl/season";
import { parseEntryId } from "@/lib/fpl/entry";
import { rankMovement } from "@/lib/leagues/table";
import { chipShort, managerWeek, type ManagerWeek } from "@/lib/leagues/chips";
import { mapWithConcurrency } from "@/lib/concurrency";
import { cn } from "@/lib/cn";
import { PageHeader, Panel } from "@/components/ui/panel";
import { Pending } from "@/components/ui/pending";
import { LeagueSelect } from "@/components/leagues/league-select";

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
 * the entire setup. Standings are fetched rather than stored: they are display
 * data, and a snapshot would only go stale.
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
          <span className="text-tertiary">refresh squad</span> above.
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

type StandingResult = Awaited<
  ReturnType<typeof getLeagueStandings>
>["standings"]["results"][number];

/** How many rival histories are fetched at once. See `mapWithConcurrency`. */
const HISTORY_CONCURRENCY = 6;

async function LeagueTable({
  membership,
  entryId,
  revalidate,
  scoredGw,
}: {
  membership: LeagueMembership;
  entryId: number;
  revalidate: number;
  scoredGw: number | null;
}) {
  const { league } = membership;

  // A head-to-head league is scored by fixtures rather than by a table, so the
  // classic standings endpoint does not describe it. Saying so is better than
  // rendering a table that means something else.
  if (league.scoring !== "c") {
    return (
      <Panel padded>
        <div className="text-sm font-semibold text-primary">Head-to-head league</div>
        <div className="mt-1 text-sm text-muted">
          Head-to-head leagues are scored by weekly fixtures, not by a cumulative
          table, so a standings table would not describe this one. Not yet
          modelled.
        </div>
      </Panel>
    );
  }

  /*
   * A shape change and an outage are different failures, and this used to
   * report them identically.
   *
   * FPL dropped `id` from every standings row mid-season. The schema rejected
   * the response, the catch swallowed it, and the screen showed "could not be
   * fetched" — indistinguishable from the API being down. A validation failure
   * means we are reading the API incorrectly, which is our bug, and it should
   * say so rather than blaming the network.
   */
  const standings = await getLeagueStandings(league.id, 1, { revalidate }).catch(
    (error: unknown) => (error instanceof Error ? error : new Error("unknown")),
  );

  if (standings instanceof Error) {
    const isShapeChange =
      standings instanceof FplSchemaError || standings.message.includes("Invalid input");
    return (
      <Panel padded>
        <div className="text-sm font-semibold text-warn">
          {isShapeChange ? "The standings changed shape" : "Standings unavailable"}
        </div>
        <div className="mt-1 text-sm text-muted">
          {isShapeChange ? (
            <>
              The standings arrived but did not match what this app expects, so
              they were rejected rather than displayed half-read. That is a bug
              here, not an outage &mdash; the API has changed shape and the
              schema in{" "}
              <code className="font-mono text-tertiary">lib/fpl/schemas.ts</code>{" "}
              needs updating.
            </>
          ) : (
            <>
              Standings for this league could not be fetched. The league is still
              recorded; only the table is missing.
            </>
          )}
        </div>
      </Panel>
    );
  }

  const rows = standings.standings.results;

  if (rows.length === 0) {
    return (
      <Panel padded>
        <div className="text-sm text-muted">
          No table yet. Classic leagues rank on total points, and nobody has
          scored any until a gameweek has been played.
        </div>
      </Panel>
    );
  }

  /*
   * Chips and hits, which the standings endpoint does not carry.
   *
   * One history per manager, a few at a time, each cached for the same window
   * as the table. A failure is kept per row and COUNTED rather than rendered
   * as "no chip": a manager whose history failed to load did not necessarily
   * play nothing, and a column of dashes would say they had.
   */
  const weeks: (ManagerWeek | Error)[] =
    scoredGw === null
      ? []
      : await mapWithConcurrency(rows, HISTORY_CONCURRENCY, (row) =>
          getEntryHistory(row.entry, { revalidate }).then(
            (history) => managerWeek(history, scoredGw),
            (error: unknown) => (error instanceof Error ? error : new Error("unknown")),
          ),
        );
  const failures = weeks.filter((w) => w instanceof Error);
  const shapeFailure = failures.some((w) => w instanceof FplSchemaError);

  const managers = `${rows.length}${standings.standings.has_next ? "+" : ""} managers`;
  const youOnPage = rows.some((r) => r.entry === entryId);

  return (
    <div className="flex flex-col gap-2">
      <Panel>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-edge-strong bg-sunken text-left text-xs font-medium text-muted">
                <th scope="col" className="w-[76px] py-2.5 pr-2 pl-4 font-medium">Rank</th>
                <th scope="col" className="py-2.5 pr-3 font-medium">Team &amp; manager</th>
                <th scope="col" className="w-[56px] py-2.5 pr-3 text-center font-medium">Chip</th>
                <th scope="col" className="w-[64px] py-2.5 pr-3 text-right font-medium">
                  {scoredGw !== null ? `GW${scoredGw}` : "GW"}
                </th>
                <th scope="col" className="w-[52px] py-2.5 pr-3 text-right font-medium">Hits</th>
                <th scope="col" className="w-[72px] py-2.5 pr-4 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <StandingRow
                  key={row.entry}
                  row={row}
                  week={weeks[i]}
                  isYou={row.entry === entryId}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 px-1 text-xs text-muted">
        <span>
          {managers}
          {!youOnPage && membership.rank !== null
            ? ` · you are ${ordinal(membership.rank)}, below this page`
            : ""}
        </span>
        {failures.length > 0 ? (
          <span className="text-warn">
            {shapeFailure
              ? `Chips and hits for ${failures.length} managers were rejected: FPL's history response changed shape (lib/fpl/schemas.ts).`
              : `Chips and hits could not be loaded for ${failures.length} managers.`}
          </span>
        ) : null}
      </div>
    </div>
  );
}

const CHIP_PILL: Record<string, string> = {
  wildcard: "bg-[var(--chip-wc-bg)] text-[var(--chip-wc-fg)]",
  freehit: "bg-[var(--chip-fh-bg)] text-[var(--chip-fh-fg)]",
  bboost: "bg-[var(--chip-bb-bg)] text-[var(--chip-bb-fg)]",
  "3xc": "bg-[var(--chip-tc-bg)] text-[var(--chip-tc-fg)]",
};

const CHIP_NAME: Record<string, string> = {
  wildcard: "Wildcard",
  freehit: "Free Hit",
  bboost: "Bench Boost",
  "3xc": "Triple Captain",
};

const MEDAL: Record<number, string> = {
  1: "bg-[var(--medal-1-bg)] text-[var(--medal-1-fg)]",
  2: "bg-[var(--medal-2-bg)] text-[var(--medal-2-fg)]",
  3: "bg-[var(--medal-3-bg)] text-[var(--medal-3-fg)]",
};

function StandingRow({
  row,
  week,
  isYou,
}: {
  row: StandingResult;
  week: ManagerWeek | Error | undefined;
  isYou: boolean;
}) {
  const movement = rankMovement(row.rank, row.last_rank);

  return (
    <tr
      className={cn(
        "border-b border-edge-subtle last:border-b-0",
        isYou ? "bg-active" : "hover:bg-panel-hover",
      )}
      aria-current={isYou ? "true" : undefined}
    >
      <td
        className={cn(
          "py-2.5 pr-2 pl-4",
          isYou && "shadow-[inset_4px_0_0_var(--text-primary)]",
        )}
      >
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "grid h-6 min-w-6 place-items-center rounded-full px-1 text-xs font-semibold",
              MEDAL[row.rank] ?? "text-tertiary",
            )}
          >
            {row.rank > 0 ? row.rank : "—"}
          </span>
          <Movement value={movement} />
        </div>
      </td>

      <td className="max-w-0 py-2.5 pr-3">
        {/* Black on your yellow row: green is for gains, and green on yellow
            is hard to read. */}
        <div className={cn("truncate text-primary", isYou ? "font-bold" : "font-medium")}>
          {row.entry_name}
          {isYou ? <span className="ml-1.5 text-xs font-normal text-muted">(you)</span> : null}
        </div>
        <div className="truncate text-xs text-muted">{row.player_name}</div>
      </td>

      <td className="py-2.5 pr-3 text-center">
        {week === undefined ? (
          <span className="text-ghost">—</span>
        ) : week instanceof Error ? (
          <span className="text-warn" title="Could not load this manager's history">
            ?
          </span>
        ) : week.chip ? (
          <span
            className={cn(
              "inline-block rounded-md px-1.5 py-0.5 text-[11px] font-bold",
              CHIP_PILL[week.chip] ?? "bg-sunken text-tertiary",
            )}
            title={CHIP_NAME[week.chip] ?? week.chip}
          >
            {chipShort(week.chip)}
          </span>
        ) : (
          <span className="text-ghost">—</span>
        )}
      </td>

      <td className="py-2.5 pr-3 text-right">
        <span className="inline-block min-w-9 rounded-md bg-sunken px-1.5 py-0.5 text-center font-medium text-secondary">
          {row.event_total}
        </span>
      </td>

      <td className="py-2.5 pr-3 text-right">
        {week === undefined || week instanceof Error ? (
          <span className="text-ghost">—</span>
        ) : week.hits > 0 ? (
          <span className="font-medium text-danger">−{week.hits}</span>
        ) : (
          <span className="text-fainter">0</span>
        )}
      </td>

      <td className="py-2.5 pr-4 text-right text-base font-semibold text-primary">
        {row.total}
      </td>
    </tr>
  );
}

/** Places gained or lost since the previous gameweek. */
function Movement({ value }: { value: number | null }) {
  if (value === null || value === 0) {
    return <span aria-hidden className="w-6" />;
  }
  const up = value > 0;
  const Icon = up ? ArrowUp : ArrowDown;
  return (
    <span
      className={cn(
        "flex w-6 items-center text-[11px] font-medium",
        up ? "text-accent" : "text-danger",
      )}
      title={`${up ? "Up" : "Down"} ${Math.abs(value)} since last gameweek`}
    >
      <Icon aria-hidden className="size-3" strokeWidth={2.5} />
      {Math.abs(value)}
    </span>
  );
}

function TableSkeleton() {
  return (
    <Panel>
      {Array.from({ length: 8 }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-4 border-b border-edge-subtle px-4 py-3.5 last:border-b-0"
        >
          <div className="h-6 w-6 animate-pulse rounded-full bg-track" />
          <div
            className="h-3 animate-pulse rounded-full bg-track"
            style={{ width: `${48 - i * 3}%`, animationDelay: `${i * 60}ms` }}
          />
        </div>
      ))}
    </Panel>
  );
}

/** 1 → "1st", 22 → "22nd", 111 → "111th", grouped for big ranks. */
function ordinal(n: number): string {
  const mod100 = n % 100;
  const suffix =
    mod100 >= 11 && mod100 <= 13
      ? "th"
      : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n.toLocaleString("en-GB")}${suffix}`;
}
