import "server-only";

import { getBootstrapStatic } from "./client";
import {
  resolveChipWindows,
  resolveGameweekState,
  type ChipWindow,
  type GameweekState,
} from "./gameweek";
import type { FplTeam } from "./schemas";

/**
 * Season context — the handful of facts every screen needs in its header.
 *
 * Resolved from `bootstrap-static` on the server. Deliberately degrades: if
 * the FPL API is unreachable the app still renders, with `available: false`,
 * rather than throwing a 500 on every route. A dashboard that says "upstream
 * is down" is more useful than an error page.
 */

export interface SeasonContext {
  available: true;
  gameweek: GameweekState;
  chipWindows: ChipWindow[];
  teams: FplTeam[];
  teamsById: Map<number, FplTeam>;
}

export interface SeasonUnavailable {
  available: false;
  reason: string;
}

export async function getSeasonContext(): Promise<
  SeasonContext | SeasonUnavailable
> {
  try {
    const bootstrap = await getBootstrapStatic();
    return {
      available: true,
      gameweek: resolveGameweekState(bootstrap.events),
      chipWindows: resolveChipWindows(bootstrap.chips),
      teams: bootstrap.teams,
      teamsById: new Map(bootstrap.teams.map((t) => [t.id, t])),
    };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
