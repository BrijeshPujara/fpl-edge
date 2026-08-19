import type { Countdown } from "@/lib/fpl/gameweek";

/**
 * The render boundary.
 *
 * Money lives as an integer in tenths of a million everywhere else in the
 * codebase. It becomes a "£" string exactly here and nowhere else — if you
 * find yourself writing `£` in a component, the conversion belongs in this
 * file instead.
 */

/** 65 -> "£6.5" */
export function money(tenths: number): string {
  return `£${(tenths / 10).toFixed(1)}`;
}

/** -6 -> "−£0.6", 26 -> "+£2.6". Uses a real minus sign, not a hyphen. */
export function moneyDelta(tenths: number): string {
  const sign = tenths < 0 ? "−" : "+";
  return `${sign}£${(Math.abs(tenths) / 10).toFixed(1)}`;
}

/** 6.42 -> "6.4" */
export function ep(value: number): string {
  return value.toFixed(1);
}

/** 6.42 -> "+6.4", -1.2 -> "−1.2". Uses a real minus sign. */
export function epDelta(value: number): string {
  const sign = value < 0 ? "−" : "+";
  return `${sign}${Math.abs(value).toFixed(1)}`;
}

/** 18.4 -> "18.4%" */
export function percent(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`;
}

/** 41208 -> "41,208" */
export function rank(value: number | null): string {
  if (value === null) return "—";
  return value.toLocaleString("en-GB");
}

/** A transfer hit of 4 points renders as "−4"; zero renders as "0". */
export function hit(points: number): string {
  return points === 0 ? "0" : `−${points}`;
}

/** { days: 1, hours: 17, minutes: 12, seconds: 38 } -> "1d 17:12:38" */
export function countdown(value: Countdown): string {
  if (value.expired) return "DEADLINE PASSED";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${value.days}d ${pad(value.hours)}:${pad(value.minutes)}:${pad(value.seconds)}`;
}

/**
 * Deadline stamp for the UI, in UK time — the FPL deadline is always quoted in
 * UK local time and the manager is always reading it in that frame, wherever
 * they are.
 */
export function deadlineStamp(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
    timeZoneName: "short",
  })
    .format(date)
    .toUpperCase();
}
