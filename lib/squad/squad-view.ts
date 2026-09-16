import "server-only";

import type { SeasonContext } from "@/lib/fpl/season";
import { gameweekInPlay } from "@/lib/fpl/gameweek";
import { applyAvailability, getAvailability } from "@/lib/fpl/availability";
import { getLiveGameweek } from "@/lib/fpl/live-context";
import { loadDecisionContext } from "@/lib/db/decision-context";
import { getDb, isDbConfigured } from "@/lib/db/client";
import {
  getFixturesFrom,
  getLatestSquad,
  getPlayersByIds,
  getRecentStats,
  getTeams,
} from "@/lib/db/queries";
import { getTeamRatingRows } from "@/lib/db/ratings";
import { DEFAULT_HORIZON, FORM_WINDOW } from "@/lib/engine/constants";
import { liveSquad, type LivePlayer } from "@/lib/squad/live";
import { buildSquadView, type SquadView } from "@/lib/squad/view";

export type LoadedSquadView =
  | { state: "no-db" }
  | { state: "no-squad" }
  | {
      state: "ready";
      view: SquadView;
      /** Live scores by player, when the gameweek is being played. */
      live: Map<number, LivePlayer> | undefined;
    };

/**
 * Everything a pitch needs, loaded once: the squad, its projections, fitness
 * from the API, club shirts, and live scores when a gameweek is on.
 *
 * Shared by My Team and the dashboard. The dashboard's pitch used to be the
 * reason to copy this load into a second page, and two copies of "which
 * fitness flags, which projections" is how two screens come to show the same
 * player differently.
 */
export async function loadSquadView(
  entryId: number,
  season: SeasonContext,
): Promise<LoadedSquadView> {
  if (!isDbConfigured()) return { state: "no-db" };

  const { target } = season.gameweek;
  const db = getDb();
  const stored = await getLatestSquad(db, entryId, target.id);
  if (!stored) return { state: "no-squad" };

  const playerIds = stored.picks.map((p) => p.player_id);
  const [storedPlayers, teams, teamRatings, fixtures, stats, availability] =
    await Promise.all([
      getPlayersByIds(db, playerIds),
      getTeams(db),
      getTeamRatingRows(db),
      getFixturesFrom(db, target.id, target.id + 6),
      getRecentStats(db, playerIds, Math.max(1, target.id - FORM_WINDOW)),
      getAvailability(),
    ]);

  // Fitness from the API, not from the overnight sync — see getAvailability.
  const players = applyAvailability(storedPlayers, availability);

  /*
   * Projections from the same loader every other screen uses, so a player
   * cannot read one number here and another elsewhere. Deduplicated per
   * request, so this is not a second load.
   */
  const context = await loadDecisionContext(entryId, DEFAULT_HORIZON).catch(
    () => null,
  );
  const epByPlayer =
    context?.state === "ready"
      ? new Map(
          context.squad.map((c) => [
            c.id,
            c.perGameweek.find((g) => g.gw === context.gw)?.ep ?? 0,
          ]),
        )
      : undefined;

  const view = buildSquadView({
    gw: target.id,
    picks: stored.picks,
    players,
    teams,
    fixtures,
    stats,
    teamRatings,
    epByPlayer,
    picksGw: stored.squad.gw,
    teamCodes: new Map(season.teams.map((t) => [t.id, t.code])),
  });

  /*
   * Live scores, when the gameweek is being played.
   *
   * Keyed on the gameweek IN PLAY rather than the target: the moment a
   * deadline passes the target becomes next week, and asking the live feed
   * about a gameweek nobody has kicked off in returns nothing.
   *
   * Uncached, and allowed to fail quietly — the pitch is worth rendering with
   * projections alone if the live feed is unreachable.
   */
  const inPlay = gameweekInPlay(season.gameweek);
  const liveFeed = await getLiveGameweek(inPlay.id);
  const live = liveFeed
    ? new Map<number, LivePlayer>(
        liveSquad({
          picks: stored.picks.map((p) => ({
            playerId: p.player_id,
            position: p.position,
            isCaptain: p.is_captain,
            isVice: p.is_vice,
          })),
          elements: liveFeed.elements,
          startedFixtures: liveFeed.startedFixtures,
          chip: stored.squad.chip_played,
        }).players.map((p) => [p.playerId, p]),
      )
    : undefined;

  return { state: "ready", view, live };
}
