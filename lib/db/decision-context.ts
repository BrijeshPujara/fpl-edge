import "server-only";

import { getDb, isDbConfigured } from "./client";
import {
  getAllPlayers,
  getFixturesFrom,
  getLatestSquad,
  getRecentStats,
  getTeams,
} from "./queries";
import { loadPriceMomentumInputs } from "./price-momentum";
import { projectPriceChanges } from "@/lib/engine/price-model";
import { FORM_WINDOW } from "@/lib/engine/constants";
import { buildCandidatePool, type Candidate } from "@/lib/squad/candidates";
import { getSeasonContext } from "@/lib/fpl/season";
import type { ChipWindow } from "@/lib/fpl/gameweek";

/**
 * Everything the two decision screens need, loaded once.
 *
 * `/transfers` and `/chips` ask the same questions of the database — what do I
 * own, what could I buy, what is each worth — and differ only in horizon. This
 * is that load, expressed as a discriminated union so a page cannot forget to
 * handle a state: the API being down, the database being unconfigured, and no
 * squad existing yet are all normal conditions before the first deadline, not
 * errors.
 */

export type DecisionContext =
  | { state: "no-api"; reason: string }
  | { state: "no-db" }
  | { state: "no-squad"; gw: number; gwName: string }
  | {
      state: "ready";
      gw: number;
      gwName: string;
      gameweeks: number[];
      chipWindows: ChipWindow[];
      /** The fifteen currently owned, with projections. */
      squad: Candidate[];
      /** Everyone buyable, including the fifteen above. */
      pool: Candidate[];
      /** Tenths. */
      bank: number;
      teamValue: number;
      freeTransfers: number;
      chipPlayed: string | null;
      /**
       * Realisable price movement per player over the horizon, in tenths,
       * already net of the sell-on fee. Zero for players the price model has
       * no confidence about, which is all of them before roughly GW4.
       */
      priceDeltas: Map<number, number>;
      /**
       * False when no gameweek has been played. Every projection is then the
       * same positional prior and nothing may be ranked — see `CandidatePool`.
       */
      projectable: boolean;
    };

export async function loadDecisionContext(
  horizon: number,
): Promise<DecisionContext> {
  const season = await getSeasonContext();
  if (!season.available) {
    return { state: "no-api", reason: season.reason };
  }
  if (!isDbConfigured()) return { state: "no-db" };

  const { target } = season.gameweek;
  const db = getDb();
  const stored = await getLatestSquad(db, target.id);
  if (!stored) {
    return { state: "no-squad", gw: target.id, gwName: target.name };
  }

  const [players, teams, fixtures] = await Promise.all([
    getAllPlayers(db),
    getTeams(db),
    // One extra gameweek beyond the horizon so the final entry is a real
    // projection rather than a truncated one.
    getFixturesFrom(db, target.id, target.id + horizon),
  ]);

  const stats = await getRecentStats(
    db,
    players.map((p) => p.id),
    Math.max(1, target.id - FORM_WINDOW),
  );

  const pool = buildCandidatePool({
    gw: target.id,
    horizon,
    players,
    teams,
    fixtures,
    stats,
  });

  // Price movement, attached to the candidates the optimiser will weigh. Before
  // roughly GW4 this is all zeros with confidence "none", which the optimiser
  // handles as "no price signal" rather than "no price movement".
  const momentum = await loadPriceMomentumInputs(
    db,
    players.map((p) => p.id),
  );
  const projections = projectPriceChanges(momentum, horizon);

  const byId = new Map(pool.candidates.map((c) => [c.id, c]));
  const squad = stored.picks
    .map((pick) => byId.get(pick.player_id))
    .filter((c): c is Candidate => c !== undefined);

  return {
    state: "ready",
    gw: target.id,
    gwName: target.name,
    gameweeks: pool.gameweeks,
    chipWindows: season.chipWindows,
    squad,
    pool: pool.candidates,
    bank: stored.squad.bank,
    teamValue: stored.squad.team_value,
    freeTransfers: stored.squad.free_transfers,
    chipPlayed: stored.squad.chip_played,
    priceDeltas: new Map(
      [...projections].map(([id, p]) => [id, p.realisableDelta]),
    ),
    projectable: pool.projectable,
  };
}
