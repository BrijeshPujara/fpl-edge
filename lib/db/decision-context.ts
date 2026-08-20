import "server-only";

import { getDb, isDbConfigured, type Db } from "./client";
import {
  getAllPlayers,
  getFixturesFrom,
  getLatestSquad,
  getRecentStats,
  getSeasonHistory,
  getTeams,
  type PlayerRow,
} from "./queries";
import { loadPriceMomentumInputs } from "./price-momentum";
import { projectPriceChanges } from "@/lib/engine/price-model";
import { FORM_WINDOW } from "@/lib/engine/constants";
import { buildCandidatePool, type Candidate } from "@/lib/squad/candidates";
import { getSeasonContext } from "@/lib/fpl/season";
import { mostRecentRates } from "@/lib/engine/prior-season";
import type { PriorSeasonRates } from "@/lib/engine/expected-points";
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

/** The loaded, usable state. Named so the preview harness can construct one. */
export interface ReadyDecisionContext {
  state: "ready";
  /** Whose squad this is. See `lib/fpl/entry.ts`. */
  entryId: number;
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
   * Realisable price movement per player over the horizon, in tenths, already
   * net of the sell-on fee. Zero for players the price model has no confidence
   * about, which is all of them before roughly GW4.
   */
  priceDeltas: Map<number, number>;
  /**
   * False when no gameweek has been played. Every projection is then the same
   * positional prior and nothing may be ranked — see `CandidatePool`.
   */
  projectable: boolean;
}

export type DecisionContext =
  | { state: "no-api"; reason: string }
  | { state: "no-db" }
  /**
   * No entry id configured. Distinct from `no-squad` on purpose: that one is
   * "the deadline has not passed", this one is "nobody has said whose team this
   * is", and telling a user the wrong one sends them looking in the wrong place.
   */
  | { state: "no-entry" }
  | { state: "no-squad"; gw: number; gwName: string }
  | ReadyDecisionContext;

/**
 * `entryId` is a parameter rather than something this function resolves.
 *
 * It used to read the environment. That worked while the app served one
 * manager and would have been exactly the wrong shape the moment it served
 * two — the answer belongs to the request, not to the deployment.
 */
export async function loadDecisionContext(
  entryId: number,
  horizon: number,
): Promise<DecisionContext> {
  const season = await getSeasonContext();
  if (!season.available) {
    return { state: "no-api", reason: season.reason };
  }
  if (!isDbConfigured()) return { state: "no-db" };

  const { target } = season.gameweek;
  const db = getDb();
  const stored = await getLatestSquad(db, entryId, target.id);
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

  const priorSeasons = await loadPriorSeasons(db, players);

  const pool = buildCandidatePool({
    gw: target.id,
    horizon,
    players,
    teams,
    fixtures,
    stats,
    priorSeasons,
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
    entryId,
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

/**
 * Last season's rates for every player, keyed by CODE.
 *
 * Keyed on code and not id, because FPL renumbers ids between seasons and the
 * whole point of this table is to reach across that boundary.
 *
 * A player with no usable season simply has no entry, and the model falls back
 * to its own priors — which is what every player did before this existed.
 */
async function loadPriorSeasons(
  db: Db,
  players: PlayerRow[],
): Promise<Map<number, PriorSeasonRates>> {
  const rows = await getSeasonHistory(
    db,
    players.map((p) => p.code),
  );

  const byCode = new Map<number, typeof rows>();
  for (const row of rows) {
    byCode.set(row.player_code, [...(byCode.get(row.player_code) ?? []), row]);
  }

  const rates = new Map<number, PriorSeasonRates>();
  for (const [code, seasons] of byCode) {
    const resolved = mostRecentRates(
      seasons.map((season) => ({
        seasonName: season.season_name,
        minutes: season.minutes,
        starts: season.starts,
        expectedGoals: season.expected_goals,
        expectedAssists: season.expected_assists,
        bonus: season.bonus,
      })),
    );
    if (resolved !== null) rates.set(code, resolved);
  }
  return rates;
}
