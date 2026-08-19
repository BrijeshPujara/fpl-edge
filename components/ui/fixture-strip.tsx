import { FDR_MAX, FDR_MIN } from "@/lib/rules";
import { cn } from "@/lib/cn";

/**
 * The five-fixture difficulty strip that sits under every player tile.
 *
 * Difficulty is the one place this design uses colour as data rather than as
 * emphasis: green for easy, neutral grey for average, warm orange for hard.
 * The scale is the same green and orange hues as the accent and warning
 * colours, held at lower lightness so a strip of five never competes with a
 * headline number.
 */

export interface FixtureCell {
  /** Opponent short name, e.g. "BUR". Lowercase renders for away fixtures. */
  opponent: string;
  difficulty: number;
  isHome: boolean;
}

const FDR_CLASS: Record<number, string> = {
  1: "bg-[var(--fdr-1-bg)] text-[var(--fdr-1-fg)]",
  2: "bg-[var(--fdr-2-bg)] text-[var(--fdr-2-fg)]",
  3: "bg-[var(--fdr-3-bg)] text-[var(--fdr-3-fg)]",
  4: "bg-[var(--fdr-4-bg)] text-[var(--fdr-4-fg)]",
  5: "bg-[var(--fdr-5-bg)] text-[var(--fdr-5-fg)]",
};

function clampDifficulty(value: number): number {
  return Math.min(FDR_MAX, Math.max(FDR_MIN, Math.round(value)));
}

export function FixtureStrip({
  fixtures,
  length = 5,
}: {
  fixtures: FixtureCell[];
  length?: number;
}) {
  // Pad to a fixed length so strips align across tiles even when a player's
  // team has a blank at the end of the horizon.
  const cells: (FixtureCell | null)[] = Array.from(
    { length },
    (_, i) => fixtures[i] ?? null,
  );

  return (
    <div
      className="grid gap-0.5"
      style={{ gridTemplateColumns: `repeat(${length}, 1fr)` }}
    >
      {cells.map((cell, i) => (
        <div
          key={i}
          title={
            cell
              ? `${cell.opponent} (${cell.isHome ? "H" : "A"}) · difficulty ${cell.difficulty}`
              : "No fixture"
          }
          className={cn(
            "flex h-3.5 items-center justify-center font-mono text-[8px] tracking-[0.04em]",
            cell
              ? FDR_CLASS[clampDifficulty(cell.difficulty)]
              : "bg-track text-ghost",
          )}
        >
          {cell ? (cell.isHome ? cell.opponent : cell.opponent.toLowerCase()) : "—"}
        </div>
      ))}
    </div>
  );
}

/** The legend that explains the scale. Shown once per screen, not per strip. */
export function FixtureDifficultyKey() {
  const labels = ["very easy", "easy", "neutral", "hard", "very hard"];
  return (
    <div className="flex flex-col gap-2 p-3.5">
      {[1, 2, 3, 4, 5].map((d) => (
        <div key={d} className="flex items-center gap-2.5">
          <div className={cn("h-3 w-[22px] flex-none", FDR_CLASS[d])} />
          <div className="font-mono text-mini text-dim">
            {d}&nbsp;&nbsp;{labels[d - 1]}
          </div>
        </div>
      ))}
    </div>
  );
}
