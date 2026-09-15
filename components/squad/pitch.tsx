import { cn } from "@/lib/cn";
import { ep as formatEp } from "@/lib/format";
import { FDR_MAX, FDR_MIN, POSITION } from "@/lib/rules";
import type { PlayerTileView, SquadView } from "@/lib/squad/view";
import type { LivePlayer } from "@/lib/squad/live";
import { PlayerShirt } from "./player-shirt";

/**
 * The pitch view.
 *
 * Built to be read at a glance, which the tile grid it replaced was not: every
 * tile carried a price, a projection, a five-fixture strip and a badge, all at
 * the same weight, so the screen had no first thing to look at. A player card
 * now carries three things in a fixed order — who, what they are expected to
 * score (or have scored, once their match is on), and who they play next —
 * and the club shirt places each player before any of it is read. (Shirts,
 * not photos — see `lib/fpl/shirts.ts`.)
 *
 * The five-fixture run moved off the pitch. It is a planning question, and
 * the transfers screen is where it is asked.
 */

const FDR_CLASS: Record<number, string> = {
  1: "bg-[var(--fdr-1-bg)] text-[var(--fdr-1-fg)]",
  2: "bg-[var(--fdr-2-bg)] text-[var(--fdr-2-fg)]",
  3: "bg-[var(--fdr-3-bg)] text-[var(--fdr-3-fg)]",
  4: "bg-[var(--fdr-4-bg)] text-[var(--fdr-4-fg)]",
  5: "bg-[var(--fdr-5-bg)] text-[var(--fdr-5-fg)]",
};

function fdrClass(difficulty: number): string {
  return FDR_CLASS[Math.min(FDR_MAX, Math.max(FDR_MIN, Math.round(difficulty)))];
}

function PlayerCard({
  player,
  live,
}: {
  player: PlayerTileView;
  /** This player's live score, once their gameweek is under way. */
  live?: LivePlayer;
}) {
  const severe = player.flag !== null && (player.flag.chance ?? 0) < 50;
  const badge = player.isCaptain
    ? "C"
    : player.isVice
      ? "V"
      : player.flag
        ? player.flag.chance !== null
          ? `${player.flag.chance}`
          : "!"
        : null;
  const next = player.fixtures[0];
  const playing = live !== undefined && live.started;

  return (
    <div
      className="flex w-[64px] flex-col items-center sm:w-[92px]"
      title={player.flag?.note ?? undefined}
    >
      <PlayerShirt
        teamCode={player.teamCode}
        goalkeeper={player.position === POSITION.GK}
        className="h-auto w-10 drop-shadow-[0_2px_2px_rgb(0_0_0/0.25)] sm:w-[52px]"
      />

      <div className="w-full overflow-hidden rounded-md text-center shadow-sm">
        <div
          className={cn(
            "flex items-center justify-center gap-1 px-1 py-0.5 text-[10.5px] font-semibold sm:text-xs",
            severe ? "bg-danger text-white" : "bg-[var(--pitch-label)] text-signal",
          )}
        >
          <span className="truncate">{player.name}</span>
          {/*
            In the name bar, not on the photo's corner. On the corner it floated
            over grass wherever a photo's transparent top left nothing to sit
            on, and read as belonging to whichever card was nearest.
          */}
          {badge ? (
            <span
              className={cn(
                "grid h-4 min-w-4 shrink-0 place-items-center rounded-full px-1 text-[9px] font-bold",
                player.isCaptain || player.isVice
                  ? "bg-white text-primary"
                  : severe
                    ? "bg-white text-danger"
                    : "bg-warn text-white",
              )}
              title={
                player.isCaptain
                  ? "Captain"
                  : player.isVice
                    ? "Vice-captain"
                    : `${player.flag?.chance ?? 0}% chance of playing`
              }
            >
              {badge}
            </span>
          ) : null}
        </div>
        <div
          className="bg-white px-1 py-0.5 text-[10.5px] font-semibold text-primary sm:text-xs"
          title={
            playing
              ? "Points scored so far this gameweek"
              : player.epIsProjectable
                ? "Projected points for the gameweek being planned"
                : "No appearance history yet — not a meaningful projection"
          }
        >
          {playing ? (
            // What he SCORED, doubled only where the armband applies. A bench
            // multiplier is zero, and "0 pts" under a player who played well
            // reads as a broken feed rather than as a bench.
            <span className={live.points > 0 ? "text-accent" : "text-muted"}>
              {live.multiplier > 1 ? live.counted : live.points}
              {live.provisionalBonus > 0 ? "*" : ""} pts
            </span>
          ) : player.epIsProjectable ? (
            <>
              {formatEp(player.ep)}
              <span className="font-normal text-muted"> xP</span>
            </>
          ) : (
            "—"
          )}
        </div>
        {next ? (
          <div
            className={cn("truncate px-1 py-px text-[10px] font-medium", fdrClass(next.difficulty))}
            title={`Next: ${next.opponent} (${next.isHome ? "home" : "away"}), difficulty ${next.difficulty}`}
          >
            {next.opponent} ({next.isHome ? "H" : "A"})
          </div>
        ) : (
          <div className="bg-[var(--fdr-3-bg)] px-1 py-px text-[10px] text-[var(--fdr-3-fg)]">
            No fixture
          </div>
        )}
      </div>
    </div>
  );
}

/** Pitch markings: an outline, the penalty area at the top, the centre circle below. */
function Markings() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-3 sm:inset-4">
      <div className="absolute inset-0 rounded-sm border-2 border-[var(--pitch-line)]" />
      <div className="absolute top-0 left-1/2 h-[16%] w-[46%] -translate-x-1/2 border-2 border-t-0 border-[var(--pitch-line)]" />
      <div className="absolute top-0 left-1/2 h-[6%] w-[20%] -translate-x-1/2 border-2 border-t-0 border-[var(--pitch-line)]" />
      <div className="absolute bottom-0 left-1/2 aspect-square w-[26%] translate-x-[-50%] translate-y-1/2 rounded-full border-2 border-[var(--pitch-line)]" />
    </div>
  );
}

const grass = {
  backgroundImage:
    "repeating-linear-gradient(to bottom, var(--pitch-grass) 0 48px, var(--pitch-grass-alt) 48px 96px)",
};

export function Pitch({
  squad,
  live,
}: {
  squad: SquadView;
  /** Live scores by player id, when the gameweek is under way. */
  live?: Map<number, LivePlayer>;
}) {
  return (
    <div
      className="relative overflow-hidden rounded-2xl bg-[var(--pitch-grass)] shadow-sm"
      style={grass}
    >
      <Markings />
      <div className="relative flex flex-col gap-4 px-2 py-6 sm:gap-7 sm:px-6 sm:py-9">
        {squad.rows.map((row) => (
          <div
            key={row.position}
            className="flex items-start justify-center gap-1.5 sm:gap-5"
          >
            {row.players.map((p) => (
              <PlayerCard key={p.playerId} player={p} live={live?.get(p.playerId)} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function Bench({
  players,
  live,
}: {
  players: PlayerTileView[];
  live?: Map<number, LivePlayer>;
}) {
  return (
    <div className="rounded-2xl bg-[var(--pitch-bench)] px-2 pt-3 pb-4 shadow-sm sm:px-6">
      <div className="mb-2 text-center text-xs font-semibold tracking-wide text-white/80 uppercase">
        Bench · substitution order
      </div>
      <div className="flex items-start justify-center gap-1.5 sm:gap-5">
        {players.map((p) => (
          <PlayerCard key={p.playerId} player={p} live={live?.get(p.playerId)} />
        ))}
      </div>
    </div>
  );
}

/** What the three lines on a card mean. Shown once per screen. */
export function PitchKey() {
  return (
    <div className="flex flex-col gap-3 text-sm text-muted">
      <div>
        <span className="font-semibold text-primary">xP</span> is projected points
        for the gameweek being planned. Once a player&apos;s match starts the
        card shows what he has scored instead.
      </div>
      <div className="flex flex-col gap-1.5">
        <div>Next opponent, coloured by difficulty:</div>
        <div className="flex gap-1">
          {[1, 2, 3, 4, 5].map((d) => (
            <div
              key={d}
              className={cn("flex-1 rounded px-1 py-0.5 text-center text-xs font-medium", fdrClass(d))}
            >
              {d}
            </div>
          ))}
        </div>
        <div className="flex justify-between text-xs">
          <span>Easiest</span>
          <span>Hardest</span>
        </div>
      </div>
      <div>
        <span className="font-semibold text-primary">C</span> captain,{" "}
        <span className="font-semibold text-primary">V</span> vice. An amber or
        red number is a fitness flag — the chance of playing.
      </div>
    </div>
  );
}
