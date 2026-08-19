import { cn } from "@/lib/cn";
import { ep as formatEp, money } from "@/lib/format";
import { FixtureStrip } from "@/components/ui/fixture-strip";
import type { PlayerTileView, SquadView } from "@/lib/squad/view";

/**
 * The pitch view.
 *
 * Mobile-first: two tiles per row on a phone, opening out to the formation's
 * true width from the medium breakpoint. Each tile carries the four things
 * worth knowing at a glance — who, what they cost, what they are projected to
 * score, and how hard the next five fixtures are.
 */

function Tile({
  player,
  muted = false,
}: {
  player: PlayerTileView;
  muted?: boolean;
}) {
  const badge = player.isCaptain
    ? "C"
    : player.isVice
      ? "V"
      : player.flag
        ? player.flag.chance !== null
          ? `${player.flag.chance}%`
          : "!"
        : "";

  const severe = player.flag !== null && (player.flag.chance ?? 0) < 50;

  return (
    <div
      title={player.flag?.note ?? undefined}
      className={cn(
        "flex flex-col gap-1.5 border border-edge-strong px-2.5 pt-2 pb-2",
        muted ? "bg-sunken" : "bg-tile hover:bg-tile-hover",
      )}
      style={{
        borderTopWidth: "2px",
        borderTopColor: player.isCaptain
          ? "var(--accent)"
          : player.flag
            ? severe
              ? "var(--danger)"
              : "var(--warn)"
            : "var(--border-strong)",
      }}
    >
      <div className="flex items-baseline justify-between gap-1.5">
        <div
          className={cn(
            "truncate text-cell font-medium",
            muted ? "text-quaternary" : "text-primary",
          )}
        >
          {player.name}
        </div>
        {badge ? (
          <div
            className={cn(
              "font-mono text-tiny",
              player.isCaptain
                ? "text-accent"
                : severe
                  ? "text-danger"
                  : player.flag
                    ? "text-warn"
                    : "text-dim",
            )}
          >
            {badge}
          </div>
        ) : null}
      </div>

      <div className="flex items-baseline justify-between gap-2">
        <div className="font-mono text-[10.5px] tracking-[0.06em] text-label">
          {player.club} · {money(player.price)}
        </div>
        <div
          className={cn(
            "font-mono text-value font-medium",
            !player.epIsProjectable
              ? "text-faint"
              : player.ep >= 6
                ? "text-accent"
                : "text-secondary",
          )}
          title={
            player.epIsProjectable
              ? "Projected points over this gameweek"
              : "No appearance history yet — not a meaningful projection"
          }
        >
          {player.epIsProjectable ? formatEp(player.ep) : "—"}
        </div>
      </div>

      <FixtureStrip fixtures={player.fixtures} />
    </div>
  );
}

export function Pitch({ squad }: { squad: SquadView }) {
  return (
    <div className="border border-edge-strong bg-sunken p-3 sm:p-4">
      <div className="flex flex-col gap-3">
        {squad.rows.map((row) => (
          <div key={row.position} className="flex items-start gap-2.5 sm:gap-3.5">
            <div className="w-6 flex-none pt-2 font-mono text-tiny tracking-[0.1em] text-ghost">
              {row.label}
            </div>
            {/*
              Two tiles per row on a phone; the formation's true width from md
              up, driven by a custom property so the column count stays data
              rather than a hardcoded class per possible formation.
            */}
            <div
              className="grid flex-1 grid-cols-2 gap-2 md:[grid-template-columns:repeat(var(--cols),minmax(0,1fr))]"
              style={{ "--cols": row.players.length } as React.CSSProperties}
            >
              {row.players.map((p) => (
                <Tile key={p.playerId} player={p} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Bench({ players }: { players: PlayerTileView[] }) {
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
      {players.map((p) => (
        <Tile key={p.playerId} player={p} muted />
      ))}
    </div>
  );
}
