import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The three primitives every screen in the design is built from: a small
 * uppercase mono section label, a bordered panel below it, and rows inside.
 *
 * There are no cards with shadows, no rounded corners and no gradients
 * anywhere in this design. A panel is a 1px border on a slightly lifted
 * surface — that is the whole visual vocabulary.
 */

export function SectionLabel({
  children,
  meta,
  className,
}: {
  children: ReactNode;
  /** Right-aligned secondary text, e.g. "HORIZON 5 GW". */
  meta?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-2.5 flex items-baseline justify-between gap-4",
        className,
      )}
    >
      <div className="font-mono text-tiny tracking-[0.16em] text-label">
        {children}
      </div>
      {meta ? (
        <div className="font-mono text-tiny tracking-[0.08em] text-fainter">
          {meta}
        </div>
      ) : null}
    </div>
  );
}

export function Panel({
  children,
  className,
  padded = false,
}: {
  children: ReactNode;
  className?: string;
  /** Panels containing rows are unpadded; panels containing prose are padded. */
  padded?: boolean;
}) {
  return (
    <div
      className={cn(
        "border border-edge-strong bg-panel",
        padded && "p-3.5",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * A fixed-height row inside a panel. The design uses a small set of heights
 * (30px for dense lists, 34px for tables, 44px for two-line rows) — keeping
 * them named stops the vertical rhythm drifting screen to screen.
 *
 * "auto" is the exception, for rows carrying wrapping prose. The fixed heights
 * clip rather than grow, so a three-line row inside a 44px slot overlaps the
 * row beneath it instead of pushing it down.
 */
export function Row({
  children,
  className,
  height = "dense",
  hover = false,
}: {
  children: ReactNode;
  className?: string;
  height?: "dense" | "table" | "tall" | "auto";
  hover?: boolean;
}) {
  return (
    <div
      className={cn(
        "items-center border-b border-edge-subtle px-3.5 last:border-b-0",
        // Touch targets first: 44px is the minimum a thumb hits reliably, so
        // the dense canvas heights are a desktop enhancement, not the base.
        height === "dense" && "min-h-11 md:h-[30px] md:min-h-0",
        height === "table" && "min-h-11 md:h-[34px] md:min-h-0",
        height === "tall" && "min-h-11 md:h-[44px] md:min-h-0",
        height === "auto" && "min-h-11 py-2.5",
        hover && "hover:bg-panel-hover",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A label/value pair, e.g. the squad totals list. */
export function StatRow({
  label,
  value,
  tone = "primary",
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: "primary" | "accent" | "warn" | "muted";
}) {
  return (
    <Row className="flex justify-between gap-2.5" height="table">
      <div className="text-small text-muted">{label}</div>
      <div
        className={cn(
          "font-mono text-cell",
          tone === "primary" && "text-primary",
          tone === "accent" && "text-accent",
          tone === "warn" && "text-warn",
          tone === "muted" && "text-muted",
        )}
      >
        {value}
      </div>
    </Row>
  );
}

/**
 * A masthead readout — the header strip's DEADLINE / PROJ. EP / BANK cells.
 */
export function Readout({
  label,
  value,
  tone = "primary",
  className,
}: {
  label: string;
  value: ReactNode;
  tone?: "primary" | "warn" | "accent";
  className?: string;
}) {
  return (
    <div
      className={cn("flex flex-col justify-center py-1.5", className)}
    >
      <div className="font-mono text-micro tracking-[0.14em] text-label">
        {label}
      </div>
      <div
        className={cn(
          "font-mono text-value font-medium tracking-[0.02em]",
          tone === "primary" && "text-primary",
          tone === "warn" && "text-warn",
          tone === "accent" && "text-accent",
        )}
      >
        {value}
      </div>
    </div>
  );
}
