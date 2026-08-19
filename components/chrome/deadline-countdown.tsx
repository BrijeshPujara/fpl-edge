"use client";

import { useSyncExternalStore } from "react";
import { countdownTo } from "@/lib/fpl/gameweek";
import { countdown as formatCountdown } from "@/lib/format";
import { cn } from "@/lib/cn";

/**
 * A ticking deadline clock.
 *
 * The deadline itself is resolved on the server from `bootstrap-static` and
 * passed in as an ISO string — this component only owns the tick.
 *
 * The clock is an external system, so it is modelled as one: a single shared
 * interval that every countdown on the page subscribes to. That keeps the
 * masthead and the dashboard readout in lockstep instead of drifting apart on
 * two independent timers, and means N countdowns cost one interval, not N.
 */

let tick = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);

  if (timer === null) {
    // Seed immediately so the first paint after hydration shows a real time
    // rather than a placeholder for a second.
    tick = Date.now();
    timer = setInterval(() => {
      tick = Date.now();
      for (const listener of listeners) listener();
    }, 1000);
  }

  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const getSnapshot = () => tick;
/** On the server there is no clock; render a stable placeholder. */
const getServerSnapshot = () => 0;

export function DeadlineCountdown({
  deadline,
  className,
}: {
  deadline: string;
  className?: string;
}) {
  const now = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const text =
    now === 0
      ? "—"
      : formatCountdown(countdownTo(new Date(deadline), new Date(now)));

  return (
    <span className={cn("tabular-nums", className)} suppressHydrationWarning>
      {text}
    </span>
  );
}
