import type { Candidate } from "@/lib/squad/candidates";
import { cn } from "@/lib/cn";
import { Panel } from "@/components/ui/panel";

/** Fitness concerns in the fifteen, or a line saying there are none. */
export function FlagsCard({ squad }: { squad: Candidate[] }) {
  const flagged = squad.filter((c) => c.flag !== null);

  return (
    <Panel>
      <div className="flex items-center justify-between gap-3 border-b border-edge-subtle px-4 py-3 last:border-b-0">
        <div className="text-sm font-semibold text-primary">Fitness</div>
        <div
          className={cn(
            "text-xs font-medium",
            flagged.length > 0 ? "text-warn" : "text-accent",
          )}
        >
          {flagged.length > 0 ? `${flagged.length} flagged` : "All fit"}
        </div>
      </div>
      {flagged.map((c) => {
        const chance = c.flag?.chance ?? null;
        const serious = chance === null || chance < 50;
        return (
          <div
            key={c.id}
            className="flex items-start justify-between gap-3 border-b border-edge-subtle px-4 py-2.5 last:border-b-0"
          >
            <div className="min-w-0">
              <div className="text-sm font-medium text-primary">
                {c.name}{" "}
                <span className="text-xs font-normal text-muted">
                  {c.positionShort} · {c.club}
                </span>
              </div>
              <div className="text-xs text-muted text-pretty">{c.flag?.note}</div>
            </div>
            <span
              className={cn(
                "shrink-0 rounded-md px-1.5 py-0.5 text-xs font-semibold",
                serious
                  ? "bg-[color-mix(in_oklch,var(--danger)_12%,var(--surface-panel))] text-danger"
                  : "bg-[color-mix(in_oklch,var(--warn)_14%,var(--surface-panel))] text-warn",
              )}
            >
              {chance === null ? "Out" : `${chance}%`}
            </span>
          </div>
        );
      })}
    </Panel>
  );
}
