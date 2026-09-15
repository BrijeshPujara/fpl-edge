import { ArrowDown, ArrowUp } from "lucide-react";
import { getDb, isDbConfigured } from "@/lib/db/client";
import { getLatestSquad } from "@/lib/db/queries";
import { getEntryHistory } from "@/lib/fpl/client";
import { getLiveGameweek } from "@/lib/fpl/live-context";
import type { SeasonContext } from "@/lib/fpl/season";
import { liveSquad } from "@/lib/squad/live";
import { cn } from "@/lib/cn";
import { Panel } from "@/components/ui/panel";

/**
 * One number about the gameweek just played, or being played.
 *
 * While matches are on it is the live score — the same number the official
 * site shows, before substitutions and the vice-captain resolve. Otherwise it
 * is the last finished gameweek, against the average and with the overall
 * rank's movement, which is what a manager glances at on Monday.
 *
 * The full player-by-player live breakdown lived here and is gone: My Team
 * shows each player's live score on the pitch, where it can be read against
 * who he is.
 */
export async function GameweekScore({
  entryId,
  season,
}: {
  entryId: number;
  season: SeasonContext;
}) {
  const { current, previous } = season.gameweek;

  // Live: the current gameweek, once its first match has kicked off.
  if (current && !current.finished && isDbConfigured()) {
    const stored = await getLatestSquad(getDb(), entryId, current.id);
    const live = stored ? await getLiveGameweek(current.id) : null;
    if (stored && live?.anyStarted) {
      const squad = liveSquad({
        picks: stored.picks.map((p) => ({
          playerId: p.player_id,
          position: p.position,
          isCaptain: p.is_captain,
          isVice: p.is_vice,
        })),
        elements: live.elements,
        startedFixtures: live.startedFixtures,
        chip: stored.squad.chip_played,
      });
      return (
        <ScoreCard
          title={`GW${current.id} so far`}
          points={squad.total}
          live
          notes={[
            squad.toPlay > 0 ? `${squad.toPlay} still to play` : "Every player has started",
            squad.provisional ? "includes provisional bonus" : null,
          ]}
        />
      );
    }
  }

  const settled = current?.finished ? current : previous;
  if (!settled) return null;

  // A failure to read the history is said, not hidden behind an empty card.
  const history = await getEntryHistory(entryId).catch(() => null);
  if (history === null) {
    return (
      <Panel padded>
        <div className="text-xs font-medium text-muted">GW{settled.id}</div>
        <div className="mt-1 text-sm text-warn">
          Your FPL history could not be loaded.
        </div>
      </Panel>
    );
  }

  const index = history.current.findIndex((r) => r.event === settled.id);
  const row = index >= 0 ? history.current[index] : null;
  if (!row) return null;
  const before = index > 0 ? history.current[index - 1] : null;

  const rankChange =
    before?.overall_rank && row.overall_rank
      ? before.overall_rank - row.overall_rank
      : null;

  return (
    <ScoreCard
      title={`GW${settled.id}`}
      points={row.points - row.event_transfers_cost}
      notes={[
        settled.average_entry_score ? `average ${settled.average_entry_score}` : null,
        row.event_transfers_cost > 0 ? `after a −${row.event_transfers_cost} hit` : null,
      ]}
      rankChange={rankChange}
    />
  );
}

function ScoreCard({
  title,
  points,
  notes,
  live = false,
  rankChange = null,
}: {
  title: string;
  points: number;
  notes: (string | null)[];
  live?: boolean;
  rankChange?: number | null;
}) {
  const up = rankChange !== null && rankChange > 0;
  return (
    <Panel padded>
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium text-muted">{title}</div>
        {live ? (
          <span className="flex items-center gap-1.5 text-xs font-medium text-accent">
            <span className="size-1.5 animate-pulse rounded-full bg-accent" />
            Live
          </span>
        ) : null}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-3xl font-semibold tracking-tight text-primary">
          {points}
        </span>
        <span className="text-sm text-muted">pts</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
        {notes.filter(Boolean).map((note) => (
          <span key={note}>{note}</span>
        ))}
        {rankChange !== null && rankChange !== 0 ? (
          <span
            className={cn(
              "flex items-center gap-0.5 font-medium",
              up ? "text-accent" : "text-danger",
            )}
          >
            {up ? (
              <ArrowUp aria-hidden className="size-3.5" />
            ) : (
              <ArrowDown aria-hidden className="size-3.5" />
            )}
            {Math.abs(rankChange).toLocaleString("en-GB")} overall
          </span>
        ) : null}
      </div>
    </Panel>
  );
}
