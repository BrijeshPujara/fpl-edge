import "server-only";

import {
  getBootstrapStatic,
  getEntryHistory,
  getEntryPicksIfAvailable,
} from "@/lib/fpl/client";
import { resolveGameweekState } from "@/lib/fpl/gameweek";
import {
  freeTransfersFor,
  freeTransfersForStorage,
} from "@/lib/engine/free-transfers";
import type { Db } from "./client";
import type { TablesInsert } from "./types.generated";
import { registerEntry } from "./entries";

/**
 * Syncing your own squad.
 *
 * The wrinkle that shapes this whole file: `entry/{id}/event/{gw}/picks/`
 * returns 404 until that gameweek's deadline has passed. Before the first
 * deadline there is genuinely no published squad for anyone, and that is a
 * state to report, not an error to throw. The job still does useful work in
 * that case — it records the manager's bank, value and derived free transfers.
 */

export type SyncSquadResult =
  | {
      status: "synced";
      gw: number;
      picks: number;
      captainId: number | null;
      viceCaptainId: number | null;
      chipPlayed: string | null;
      bank: number;
      teamValue: number;
      freeTransfers: number;
    }
  | {
      status: "no-picks-yet";
      /** The gameweek we are waiting on. */
      gw: number;
      reason: string;
    };

export async function syncSquad(
  db: Db,
  teamId: number,
): Promise<SyncSquadResult> {
  // `entry/{id}/` is deliberately not fetched: bank, value and transfer counts
  // all come from the picks payload's `entry_history`, which is authoritative
  // for the gameweek being synced. One fewer upstream call per run.
  const [bootstrap, history] = await Promise.all([
    getBootstrapStatic({ revalidate: 0 }),
    getEntryHistory(teamId, { revalidate: 0 }),
  ]);

  // The manager first, and before any early return.
  //
  // Two reasons, and the second is the one that bites. `squads.entry_id` is a
  // foreign key onto `entries`, so a squad cannot be written for a manager the
  // app has never looked up — skipping this is a constraint violation, not a
  // missing team name. And registering only alongside a successful squad sync
  // would leave every manager anonymous until the first deadline, because
  // that is when this function starts returning early.
  //
  // registerEntry has its own freshness window, so the nightly job pays for
  // the lookup once rather than daily.
  const registered = await registerEntry(db, teamId);
  if (registered === null) {
    throw new Error(
      `FPL has no entry ${teamId}. It is the number in the My Team URL, ` +
        `e.g. /entry/1234567/event/1.`,
    );
  }

  const gameweek = resolveGameweekState(bootstrap.events);

  // Picks exist only for gameweeks whose deadline has passed. The most recent
  // such gameweek is the current one if there is one, otherwise the previous.
  const settledGw = gameweek.current?.id ?? gameweek.previous?.id ?? null;

  if (settledGw === null) {
    return {
      status: "no-picks-yet",
      gw: gameweek.target.id,
      reason:
        `No gameweek deadline has passed yet, so ${gameweek.target.name} ` +
        `picks are not published. Nothing to sync until the deadline locks.`,
    };
  }

  const picks = await getEntryPicksIfAvailable(teamId, settledGw, {
    revalidate: 0,
  });

  if (picks === null) {
    return {
      status: "no-picks-yet",
      gw: settledGw,
      reason: `The FPL API has no published picks for gameweek ${settledGw}.`,
    };
  }

  const captain = picks.picks.find((p) => p.is_captain) ?? null;
  const vice = picks.picks.find((p) => p.is_vice_captain) ?? null;

  const freeTransfers = freeTransfersForStorage(
    freeTransfersFor(
      // The balance that matters is the one for the gameweek being planned,
      // not the one already played.
      gameweek.target.id,
      history.current.map((row) => ({
        event: row.event,
        eventTransfers: row.event_transfers,
        chip:
          history.chips.find((chip) => chip.event === row.event)?.name ?? null,
      })),
    ),
  );

  const squadRow: TablesInsert<"squads"> = {
    entry_id: teamId,
    gw: settledGw,
    captain_id: captain?.element ?? null,
    vice_captain_id: vice?.element ?? null,
    chip_played: picks.active_chip,
    bank: picks.entry_history.bank,
    team_value: picks.entry_history.value,
    free_transfers: freeTransfers,
  };

  const { data: squad, error: squadError } = await db
    .from("squads")
    // One squad per manager per gameweek. Conflicting on gw alone would have
    // one manager's sync overwrite another's the moment the app serves more
    // than one team.
    .upsert(squadRow, { onConflict: "entry_id,gw" })
    .select("id")
    .single();

  if (squadError || !squad) {
    throw new Error(
      `Failed to upsert squad for gameweek ${settledGw}: ${squadError?.message ?? "no row returned"}`,
    );
  }

  // Replace rather than upsert. `squad_picks` has a unique constraint on
  // (squad_id, position) as well as its primary key, so a player moving
  // between bench slots would collide on re-sync. A settled gameweek's picks
  // never change, but the job has to be safe to re-run regardless.
  const { error: deleteError } = await db
    .from("squad_picks")
    .delete()
    .eq("squad_id", squad.id);

  if (deleteError) {
    throw new Error(
      `Failed to clear picks for squad ${squad.id}: ${deleteError.message}`,
    );
  }

  const pickRows: TablesInsert<"squad_picks">[] = picks.picks.map((pick) => ({
    squad_id: squad.id,
    player_id: pick.element,
    position: pick.position,
    is_captain: pick.is_captain,
    is_vice: pick.is_vice_captain,
  }));

  const { error: insertError } = await db.from("squad_picks").insert(pickRows);
  if (insertError) {
    throw new Error(
      `Failed to insert ${pickRows.length} picks: ${insertError.message}`,
    );
  }

  return {
    status: "synced",
    gw: settledGw,
    picks: pickRows.length,
    captainId: squadRow.captain_id ?? null,
    viceCaptainId: squadRow.vice_captain_id ?? null,
    chipPlayed: squadRow.chip_played ?? null,
    bank: squadRow.bank ?? 0,
    teamValue: squadRow.team_value ?? 0,
    freeTransfers,
  };
}
