import { cn } from "@/lib/cn";

/**
 * Button styling, shared by real buttons and by links that act as buttons.
 *
 * A class builder rather than a component, because the two cases need
 * different elements — a form submit is a `<button>`, "switch team" is a
 * `<Link>` — and wrapping both in one component would mean re-implementing
 * either the form semantics or the prefetching.
 */
export function buttonClass(
  variant: "primary" | "secondary" = "secondary",
  className?: string,
): string {
  return cn(
    "inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg px-3.5 text-sm font-medium transition-colors",
    "disabled:cursor-not-allowed disabled:opacity-60",
    variant === "primary"
      ? "bg-accent text-white hover:bg-accent-bright hover:text-white"
      : "border border-edge-strong bg-panel text-secondary shadow-xs hover:bg-panel-hover hover:text-primary",
    className,
  );
}
