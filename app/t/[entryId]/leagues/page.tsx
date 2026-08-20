import { notFound } from "next/navigation";
import { getDb, isDbConfigured } from "@/lib/db/client";
import { getEntryLeagues, type LeagueMembership } from "@/lib/db/leagues";
import { getLeagueStandings } from "@/lib/fpl/client";
import { parseEntryId } from "@/lib/fpl/entry";
import { rank as formatRank } from "@/lib/format";
import { rankMovement, visibleStandings } from "@/lib/leagues/table";
import { cn } from "@/lib/cn";
import { Panel, Row, SectionLabel } from "@/components/ui/panel";
import { Pending } from "@/components/ui/pending";

/**
 * Mini-leagues.
 *
 * Nothing here is configured. `entry/{id}/` lists every league a manager
 * belongs to and the app already fetches it to register them, so joining a
 * league on the FPL site is the entire setup.
 *
 * Standings are fetched live rather than stored. They are read-only display
 * data that arrives in one cached request; a table and a sync job would buy
 * nothing until the question becomes "how has my rank moved", which needs
 * history rather than a snapshot.
 */
export default async function LeaguesPage({
  params,
}: {
  params: Promise<{ entryId: string }>;
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

  const memberships = await getEntryLeagues(getDb(), entryId);

  if (memberships.length === 0) {
    return (
      <div>
        <SectionLabel>MINI-LEAGUES</SectionLabel>
        <Pending phase="a squad sync">
          No leagues recorded yet. They are read from your entry rather than
          entered by hand, so they appear the first time your team is looked
          up — the nightly sync does it, or you can force it by re-entering
          your team id from <span className="text-tertiary">switch team</span>.
        </Pending>
      </div>
    );
  }

  const mine = memberships.filter((m) => m.isPrivate);
  const global = memberships.filter((m) => !m.isPrivate);

  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <div>
        <SectionLabel meta={`${mine.length} JOINED · READ FROM YOUR ENTRY`}>
          YOUR LEAGUES
        </SectionLabel>
        {mine.length === 0 ? (
          <Panel padded>
            <div className="text-small leading-relaxed text-muted text-pretty">
              You are not in any private leagues. Join one on the FPL site and
              it appears here on the next sync — there is nothing to configure.
            </div>
          </Panel>
        ) : (
          <div className="flex flex-col gap-4 sm:gap-6">
            {mine.map((membership) => (
              <LeagueTable
                key={membership.league.id}
                membership={membership}
                entryId={entryId}
              />
            ))}
          </div>
        )}
      </div>

      {global.length > 0 ? (
        <div>
          <SectionLabel meta="THE GAME ENROLS EVERYONE">
            GLOBAL LEAGUES
          </SectionLabel>
          <Panel>
            {global.map((membership) => (
              <Row
                key={membership.league.id}
                height="table"
                className="flex items-center justify-between gap-3"
              >
                <div className="truncate text-small text-muted">
                  {membership.league.name}
                </div>
                <div className="shrink-0 font-mono text-cell text-fainter">
                  {formatRank(membership.rank)}
                </div>
              </Row>
            ))}
          </Panel>
          <div className="mt-2 max-w-prose text-small leading-relaxed text-dim text-pretty">
            Nobody joins these — the game puts everyone in their country, their
            favourite club and the overall table. They are listed for
            completeness and ranked below the leagues you actually chose.
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** How many rows of a league to show. Enough for context, not a phone book. */
const VISIBLE_ROWS = 10;

async function LeagueTable({
  membership,
  entryId,
}: {
  membership: LeagueMembership;
  entryId: number;
}) {
  const { league } = membership;

  // A head-to-head league is scored by fixtures rather than by a table, so the
  // classic standings endpoint does not describe it. Saying so is better than
  // rendering a table that means something else.
  if (league.scoring !== "c") {
    return (
      <div>
        <SectionLabel meta="HEAD-TO-HEAD">{league.name}</SectionLabel>
        <Panel padded>
          <div className="text-small leading-relaxed text-muted text-pretty">
            Head-to-head leagues are scored by weekly fixtures, not by a
            cumulative table, so the standings above do not describe them. Not
            yet modelled.
          </div>
        </Panel>
      </div>
    );
  }

  const standings = await getLeagueStandings(league.id).catch(() => null);

  if (standings === null) {
    return (
      <div>
        <SectionLabel>{league.name}</SectionLabel>
        <Panel padded>
          <div className="text-small leading-relaxed text-muted text-pretty">
            Standings for this league could not be fetched. The league is still
            recorded; only the table is missing.
          </div>
        </Panel>
      </div>
    );
  }

  const view = visibleStandings(
    standings.standings.results,
    entryId,
    VISIBLE_ROWS,
  );
  const rows = standings.standings.results;

  return (
    <div>
      <SectionLabel
        meta={
          rows.length === 0
            ? "AWAITING GAMEWEEK 1"
            : `${rows.length}${standings.standings.has_next ? "+" : ""} MANAGERS`
        }
      >
        {league.name}
      </SectionLabel>

      {rows.length === 0 ? (
        <Panel padded>
          <div className="text-small leading-relaxed text-muted text-pretty">
            No table yet. Classic leagues rank on total points, and nobody has
            scored any until a gameweek has been played.
          </div>
        </Panel>
      ) : (
        <Panel>
          {view.top.map((row) => (
            <StandingRow key={row.entry} row={row} isYou={row.entry === entryId} />
          ))}
          {view.showGap ? (
            <Row height="dense" className="flex items-center">
              <div className="font-mono text-micro tracking-[0.2em] text-ghost">
                ···
              </div>
            </Row>
          ) : null}
          {view.pinned ? <StandingRow row={view.pinned} isYou /> : null}
        </Panel>
      )}
    </div>
  );
}

type StandingResult = Awaited<
  ReturnType<typeof getLeagueStandings>
>["standings"]["results"][number];

function StandingRow({ row, isYou }: { row: StandingResult; isYou: boolean }) {
  const movement = rankMovement(row.rank, row.last_rank);

  return (
    <Row
      height="table"
      className={cn(
        "grid grid-cols-[36px_1fr_auto] items-center gap-2.5",
        isYou && "bg-active",
      )}
    >
      <div
        className={cn(
          "font-mono text-cell",
          isYou ? "text-accent" : "text-muted",
        )}
      >
        {row.rank > 0 ? row.rank : "—"}
      </div>

      <div className="flex min-w-0 items-baseline gap-2">
        <div
          className={cn(
            "truncate text-small",
            isYou ? "text-primary" : "text-secondary",
          )}
        >
          {row.entry_name}
        </div>
        <div className="hidden shrink-0 font-mono text-micro tracking-[0.1em] text-fainter sm:block">
          {row.player_name.toUpperCase()}
        </div>
      </div>

      <div className="flex items-baseline gap-3">
        <Movement value={movement} />
        <div className="w-9 text-right font-mono text-cell text-muted">
          {row.event_total}
        </div>
        <div
          className={cn(
            "w-12 text-right font-mono text-cell",
            isYou ? "text-accent" : "text-primary",
          )}
        >
          {row.total}
        </div>
      </div>
    </Row>
  );
}

/** Places gained or lost since last gameweek. */
function Movement({ value }: { value: number | null }) {
  if (value === null || value === 0) {
    return <div className="w-8 text-right font-mono text-micro text-ghost">—</div>;
  }
  return (
    <div
      className={cn(
        "w-8 text-right font-mono text-micro",
        value > 0 ? "text-accent" : "text-warn",
      )}
    >
      {value > 0 ? `▲${value}` : `▼${Math.abs(value)}`}
    </div>
  );
}
