"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import { cn } from "@/lib/cn";

export interface LeagueOption {
  id: number;
  name: string;
  /** Leagues the manager joined, or ones the game put them in. */
  kind: "joined" | "global";
}

/**
 * Which league the table shows.
 *
 * The choice lives in the URL (`?league=`), not in component state, so a
 * standings table can be linked to, refreshed and navigated back to. A native
 * select rather than a custom listbox: it is keyboard- and screen-reader-
 * correct for free, and on a phone it opens the platform's own picker.
 */
export function LeagueSelect({
  options,
  selected,
}: {
  options: LeagueOption[];
  selected: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  const joined = options.filter((o) => o.kind === "joined");
  const global = options.filter((o) => o.kind === "global");

  return (
    <label className="flex w-full flex-col gap-1.5 sm:w-auto">
      <span className="text-xs font-medium text-muted">League</span>
      <select
        value={selected}
        aria-busy={pending}
        onChange={(event) => {
          const id = event.target.value;
          startTransition(() => router.push(`${pathname}?league=${id}`));
        }}
        className={cn(
          "h-10 w-full min-w-0 rounded-lg border border-edge-strong bg-panel px-3 text-sm text-primary shadow-xs sm:w-72",
          "focus:border-accent focus:ring-2 focus:ring-[color-mix(in_oklch,var(--accent)_25%,transparent)] focus:outline-none",
          pending && "opacity-60",
        )}
      >
        {joined.length > 0 ? (
          <optgroup label="Your leagues">
            {joined.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </optgroup>
        ) : null}
        {global.length > 0 ? (
          <optgroup label="Global leagues">
            {global.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
    </label>
  );
}
