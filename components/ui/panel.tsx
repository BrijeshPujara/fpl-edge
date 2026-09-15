import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The primitives every screen is built from: a section label, a card below
 * it, rows inside, and a page header above it all.
 *
 * Restyled for the light redesign — white cards with a quiet border and a
 * one-pixel shadow, sentence-sized text instead of 9px mono. The props did not
 * change, so every screen picked the new look up at once; what each screen
 * puts INSIDE them is what still needs redesigning screen by screen.
 */

/** A page's title, its one line of context, and its controls. */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="font-display text-2xl font-bold tracking-wide text-primary uppercase">
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-0.5 text-sm text-muted">{subtitle}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-end gap-2">{actions}</div> : null}
    </div>
  );
}

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
      <div className="font-display text-sm font-bold tracking-[0.06em] text-tertiary uppercase">
        {children}
      </div>
      {meta ? (
        <div className="text-right text-xs text-fainter">{meta}</div>
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
        "overflow-hidden rounded-xl border border-edge-strong bg-panel shadow-xs",
        padded && "p-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * A row inside a panel. The small set of heights keeps the vertical rhythm from
 * drifting screen to screen.
 *
 * "auto" is the exception, for rows carrying wrapping prose. The fixed heights
 * clip rather than grow, so a three-line row inside a fixed slot overlaps the
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
        "items-center border-b border-edge-subtle px-4 last:border-b-0",
        // Touch targets first: 44px is the minimum a thumb hits reliably, so
        // the denser heights are a desktop enhancement, not the base.
        height === "dense" && "min-h-11 md:h-9 md:min-h-0",
        height === "table" && "min-h-11 md:h-10 md:min-h-0",
        height === "tall" && "min-h-11 md:h-12 md:min-h-0",
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
      <div className="text-sm text-muted">{label}</div>
      <div
        className={cn(
          "text-sm font-semibold",
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

/** A headline number with its label, e.g. bank or overall rank. */
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
    <div className={cn("flex flex-col justify-center gap-0.5", className)}>
      <div className="text-xs font-medium text-muted">{label}</div>
      <div
        className={cn(
          "font-display text-xl font-bold tracking-wide",
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
