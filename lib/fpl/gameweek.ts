import { CHIP, type ChipName } from "@/lib/rules";
import type { FplChip, FplEvent } from "./schemas";

/**
 * Gameweek and chip-window resolution.
 *
 * Pure functions over the `events` and `chips` arrays from bootstrap-static.
 * Nothing here reads the clock except where a `now` is passed in explicitly,
 * which keeps it all testable.
 *
 * Rule: never derive a gameweek number or a deadline from a hardcoded date.
 * The API is the only authority on what gameweek it is.
 */

export interface GameweekState {
  /** The gameweek in progress, or null before the season starts. */
  current: FplEvent | null;
  /** The next gameweek whose deadline has not passed, or null at season end. */
  next: FplEvent | null;
  /** The most recently completed gameweek, or null before GW1 finishes. */
  previous: FplEvent | null;
  /**
   * The gameweek the app should display and plan for: the next one if its
   * deadline is still ahead, otherwise the current one. This is the number
   * that belongs in the header.
   */
  target: FplEvent;
  /** True before the GW1 deadline — no picks exist for any manager yet. */
  isPreSeason: boolean;
}

export function resolveGameweekState(events: FplEvent[]): GameweekState {
  if (events.length === 0) {
    throw new Error("bootstrap-static returned no events");
  }

  const current = events.find((e) => e.is_current) ?? null;
  const next = events.find((e) => e.is_next) ?? null;
  const previous = events.find((e) => e.is_previous) ?? null;

  // Before GW1 there is no current event; after GW38 there is no next one.
  const target = next ?? current ?? events[events.length - 1];

  return {
    current,
    next,
    previous,
    target,
    isPreSeason: current === null && next?.id === 1,
  };
}

/**
 * The gameweek whose football is worth looking at.
 *
 * NOT the same as `target`, and the difference is visible the moment a
 * gameweek kicks off. `target` is what you are DECIDING for, so it becomes the
 * next gameweek as soon as the current deadline passes — correct for
 * transfers, captaincy and chips, and wrong for anything describing matches.
 * A scoreline board flipping to next week's fixtures while this week's are
 * still being played is the symptom.
 *
 * Falls back to `target` once the current gameweek has finished, so the board
 * moves on rather than dwelling on a settled week.
 */
export function gameweekInPlay(state: GameweekState): FplEvent {
  const { current, target } = state;
  return current !== null && !current.finished ? current : target;
}

/** The deadline for a gameweek, as a Date. */
export function deadlineOf(event: FplEvent): Date {
  return new Date(event.deadline_time);
}

/** Milliseconds until a gameweek's deadline. Negative once it has passed. */
export function msUntilDeadline(event: FplEvent, now: Date): number {
  return deadlineOf(event).getTime() - now.getTime();
}

export interface Countdown {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  /** True once the deadline has passed. */
  expired: boolean;
}

export function countdownTo(target: Date, now: Date): Countdown {
  const totalSeconds = Math.floor((target.getTime() - now.getTime()) / 1000);
  if (totalSeconds <= 0) {
    return { days: 0, hours: 0, minutes: 0, seconds: 0, expired: true };
  }
  return {
    days: Math.floor(totalSeconds / 86_400),
    hours: Math.floor((totalSeconds % 86_400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    expired: false,
  };
}

// ---------------------------------------------------------------------------
// Chip windows
// ---------------------------------------------------------------------------

export interface ChipWindow {
  name: ChipName;
  /** 1 for the first-half set, 2 for the second. */
  set: number;
  startEvent: number;
  stopEvent: number;
}

const KNOWN_CHIP_NAMES = new Set<string>(Object.values(CHIP));

/**
 * Chip availability windows, read from the API rather than assumed.
 *
 * Two full sets run this season, one per half, and the first set expires when
 * its window closes. Hardcoding that gameweek would be the same mistake as
 * hardcoding a deadline: it is data, and the API reports it.
 *
 * Sets are numbered by window order, so the earliest window for a given chip
 * is set 1 regardless of what the API calls it.
 */
export function resolveChipWindows(chips: FplChip[]): ChipWindow[] {
  const byName = new Map<ChipName, FplChip[]>();

  for (const chip of chips) {
    if (!KNOWN_CHIP_NAMES.has(chip.name)) continue;
    const name = chip.name as ChipName;
    const existing = byName.get(name);
    if (existing) existing.push(chip);
    else byName.set(name, [chip]);
  }

  const windows: ChipWindow[] = [];
  for (const [name, group] of byName) {
    group
      .slice()
      .sort((a, b) => a.start_event - b.start_event)
      .forEach((chip, index) => {
        windows.push({
          name,
          set: index + 1,
          startEvent: chip.start_event,
          stopEvent: chip.stop_event,
        });
      });
  }

  return windows.sort(
    (a, b) => a.startEvent - b.startEvent || a.name.localeCompare(b.name),
  );
}

/** The window a chip may currently be played in, or null if none is open. */
export function activeChipWindow(
  windows: ChipWindow[],
  name: ChipName,
  gw: number,
): ChipWindow | null {
  return (
    windows.find(
      (w) => w.name === name && gw >= w.startEvent && gw <= w.stopEvent,
    ) ?? null
  );
}

/**
 * Gameweeks remaining before an open chip window closes, inclusive of the
 * current gameweek. Null when no window is open.
 *
 * This is the urgency signal: an unused chip with two gameweeks left is a
 * wasted asset in the making.
 */
export function gameweeksUntilExpiry(
  windows: ChipWindow[],
  name: ChipName,
  gw: number,
): number | null {
  const window = activeChipWindow(windows, name, gw);
  if (!window) return null;
  return window.stopEvent - gw + 1;
}

// ---------------------------------------------------------------------------
// Blanks and doubles
// ---------------------------------------------------------------------------

export interface FixtureCount {
  gw: number;
  /** teamId -> number of fixtures that gameweek. */
  byTeam: Map<number, number>;
}

/**
 * Count fixtures per team per gameweek. A team with zero has a blank; a team
 * with two or more has a double. Derived from the fixture list rather than
 * announced, so it stays correct as postponements are rescheduled.
 */
export function countFixturesByTeam(
  fixtures: { event: number | null; team_h: number; team_a: number }[],
  teamIds: number[],
): Map<number, FixtureCount> {
  const byGw = new Map<number, FixtureCount>();

  for (const fixture of fixtures) {
    if (fixture.event === null) continue;

    let entry = byGw.get(fixture.event);
    if (!entry) {
      entry = {
        gw: fixture.event,
        byTeam: new Map(teamIds.map((id) => [id, 0])),
      };
      byGw.set(fixture.event, entry);
    }

    for (const teamId of [fixture.team_h, fixture.team_a]) {
      entry.byTeam.set(teamId, (entry.byTeam.get(teamId) ?? 0) + 1);
    }
  }

  return byGw;
}

export type GameweekShape = "blank" | "normal" | "double";

/**
 * Classify a gameweek from the league-wide fixture spread.
 *
 * "Blank" and "double" describe the gameweek as a whole, so the test is
 * whether *any* team is affected — a single team with two fixtures makes it a
 * double gameweek for the managers who own those players.
 */
export function classifyGameweek(count: FixtureCount | undefined): GameweekShape {
  if (!count) return "blank";
  const counts = [...count.byTeam.values()];
  if (counts.some((n) => n >= 2)) return "double";
  if (counts.some((n) => n === 0)) return "blank";
  return "normal";
}
