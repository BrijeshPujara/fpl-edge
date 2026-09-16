import { ArrowDown, ArrowUp } from "lucide-react";
import type { LeagueMembership } from "@/lib/db/leagues";
import {
  FplSchemaError,
  getEntryHistory,
  getLeagueStandings,
} from "@/lib/fpl/client";
import { rankMovement, visibleStandings } from "@/lib/leagues/table";
import { chipShort, managerWeek, type ManagerWeek } from "@/lib/leagues/chips";
import { mapWithConcurrency } from "@/lib/concurrency";
import { cn } from "@/lib/cn";
import { Panel } from "@/components/ui/panel";

/**
 * One league's standings table.
 *
 * Shared by the Leagues page (the whole first page of the table) and the
 * dashboard (`limit` rows with your own pinned beneath, and `compact` columns).
 *
 * Standings are fetched rather than stored: they are display data, and a
 * snapshot would only go stale.
 */

type StandingResult = Awaited<
  ReturnType<typeof getLeagueStandings>
>["standings"]["results"][number];

/** How many rival histories are fetched at once. See `mapWithConcurrency`. */
const HISTORY_CONCURRENCY = 6;

export async function LeagueTable({
  membership,
  entryId,
  revalidate,
  scoredGw,
  limit,
  compact = false,
}: {
  membership: LeagueMembership;
  entryId: number;
  revalidate: number;
  /** The gameweek the GW column scores; chips and hits are read for it too. */
  scoredGw: number | null;
  /** Show only the top N, with your own row pinned beneath when it falls below. */
  limit?: number;
  /** Rank, team, chip and total only — for a narrow card. */
  compact?: boolean;
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

  const visible =
    limit === undefined
      ? { top: rows, pinned: null, showGap: false }
      : visibleStandings(rows, entryId, limit);
  const shown = visible.pinned ? [...visible.top, visible.pinned] : visible.top;

  /*
   * Chips and hits, which the standings endpoint does not carry.
   *
   * One history per manager SHOWN, a few at a time, each cached for the same
   * window as the table. A failure is kept per row and COUNTED rather than
   * rendered as "no chip": a manager whose history failed to load did not
   * necessarily play nothing, and a column of dashes would say they had.
   */
  const weekList: (ManagerWeek | Error)[] =
    scoredGw === null
      ? []
      : await mapWithConcurrency(shown, HISTORY_CONCURRENCY, (row) =>
          getEntryHistory(row.entry, { revalidate }).then(
            (history) => managerWeek(history, scoredGw),
            (error: unknown) => (error instanceof Error ? error : new Error("unknown")),
          ),
        );
  const weekOf = new Map(weekList.map((w, i) => [shown[i].entry, w]));
  const failures = weekList.filter((w) => w instanceof Error);
  const shapeFailure = failures.some((w) => w instanceof FplSchemaError);

  const managers = `${rows.length}${standings.standings.has_next ? "+" : ""} managers`;
  const youShown = shown.some((r) => r.entry === entryId);

  // On a phone the full table drops GW and hits rather than scrolling: a table
  // that scrolls sideways puts Total — the column that decides the league —
  // off the edge of the screen.
  const detailCell = compact ? "hidden" : "hidden sm:table-cell";

  return (
    <div className="flex flex-col gap-2">
      <Panel>
        <table className="w-full table-fixed border-collapse text-sm">
          <thead>
            <tr className="border-b border-edge-strong bg-sunken text-left text-xs font-medium text-muted">
              <th scope="col" className="w-[76px] py-2.5 pr-2 pl-4 font-medium">Rank</th>
              <th scope="col" className="py-2.5 pr-3 font-medium">Team &amp; manager</th>
              <th scope="col" className="w-[52px] py-2.5 pr-3 text-center font-medium">Chip</th>
              <th scope="col" className={cn("w-[64px] py-2.5 pr-3 text-right font-medium", detailCell)}>
                {scoredGw !== null ? `GW${scoredGw}` : "GW"}
              </th>
              <th scope="col" className={cn("w-[52px] py-2.5 pr-3 text-right font-medium", detailCell)}>
                Hits
              </th>
              <th scope="col" className="w-[64px] py-2.5 pr-4 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {visible.top.map((row) => (
              <StandingRow
                key={row.entry}
                row={row}
                week={weekOf.get(row.entry)}
                isYou={row.entry === entryId}
                detailCell={detailCell}
              />
            ))}
            {visible.showGap ? (
              <tr className="border-b border-edge-subtle">
                <td colSpan={6} className="py-1 text-center text-xs tracking-[0.3em] text-fainter">
                  ···
                </td>
              </tr>
            ) : null}
            {visible.pinned ? (
              <StandingRow
                row={visible.pinned}
                week={weekOf.get(visible.pinned.entry)}
                isYou
                detailCell={detailCell}
              />
            ) : null}
          </tbody>
        </table>
      </Panel>

      <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 px-1 text-xs text-muted">
        <span>
          {managers}
          {!youShown && membership.rank !== null
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
  detailCell,
}: {
  row: StandingResult;
  week: ManagerWeek | Error | undefined;
  isYou: boolean;
  detailCell: string;
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

      <td className="py-2.5 pr-3">
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

      <td className={cn("py-2.5 pr-3 text-right", detailCell)}>
        <span className="inline-block min-w-9 rounded-md bg-sunken px-1.5 py-0.5 text-center font-medium text-secondary">
          {row.event_total}
        </span>
      </td>

      <td className={cn("py-2.5 pr-3 text-right", detailCell)}>
        {week === undefined || week instanceof Error ? (
          <span className="text-ghost">—</span>
        ) : week.hits > 0 ? (
          <span className="font-medium text-danger">−{week.hits}</span>
        ) : (
          <span className="text-fainter">0</span>
        )}
      </td>

      <td className="py-2.5 pr-4 text-right font-display text-lg font-bold text-primary">
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

export function TableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <Panel>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-4 border-b border-edge-subtle px-4 py-3.5 last:border-b-0"
        >
          <div className="h-6 w-6 animate-pulse rounded-full bg-track" />
          <div
            className="h-3 animate-pulse bg-track"
            style={{ width: `${48 - i * 3}%`, animationDelay: `${i * 60}ms` }}
          />
        </div>
      ))}
    </Panel>
  );
}

/** 1 → "1st", 22 → "22nd", 111 → "111th", grouped for big ranks. */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  const suffix =
    mod100 >= 11 && mod100 <= 13
      ? "th"
      : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n.toLocaleString("en-GB")}${suffix}`;
}
