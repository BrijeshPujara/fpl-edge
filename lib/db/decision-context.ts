import "server-only";

import { getDb, isDbConfigured } from "./client";
import { cache } from "react";
import { getLatestSquad } from "./queries";
import {
  cachedFixtures,
  cachedPlayers,
  cachedPriceMomentum,
  cachedRecentStats,
  cachedSeasonHistory,
  cachedTeams,
} from "./cached";
import { projectPriceChanges } from "@/lib/engine/price-model";
import { FORM_WINDOW } from "@/lib/engine/constants";
import { buildCandidatePool, type Candidate } from "@/lib/squad/candidates";
import { getSeasonContext } from "@/lib/fpl/season";
import { applyAvailability, getAvailability } from "@/lib/fpl/availability";
import {
  mostRecentRates,
  mostRecentWorkload,
  type PriorSeasonWorkload,
} from "@/lib/engine/prior-season";
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
   * False only when the model has nothing to separate players with at all —
   * neither a played gameweek nor a prior season. See `CandidatePool`.
   */
  projectable: boolean;
  /** What the projections rest on, so the UI can say so. */
  basis: "none" | "prior-season" | "this-season";
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
async function loadDecisionContextUncached(
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

  /*
   * Every league-wide read at once, and all of them cached.
   *
   * These used to run in three waves — players, then stats, then history, then
   * momentum — because each looked like it needed the player list first. It
   * does, but the cached readers fetch that themselves, so the dependency no
   * longer forces the wait. Six round trips over a second became one cache
   * read after the first request.
   */
  const [storedPlayers, teams, fixtures, stats, historyRows, momentum, availability] =
    await Promise.all([
      cachedPlayers(),
      cachedTeams(),
      // One extra gameweek beyond the horizon so the final entry is a real
      // projection rather than a truncated one.
      cachedFixtures(target.id, target.id + horizon),
      cachedRecentStats(Math.max(1, target.id - FORM_WINDOW)),
      cachedSeasonHistory(),
      cachedPriceMomentum(),
      getAvailability(),
    ]);

  /*
   * Fitness flags come from the API, not from our cached rows.
   *
   * Everything else here can be a few minutes old without harm. Availability
   * cannot: it changes through the day and the cached copy can be from the
   * overnight sync, which is how an injured Pedro Porro stayed projected as a
   * starter for twenty-one hours. See `getAvailability`.
   */
  const players = applyAvailability(storedPlayers, availability);

  const priorSeasons = ratesByCode(historyRows);
  const priorWorkloads = workloadsByCode(historyRows);

  const pool = buildCandidatePool({
    gw: target.id,
    horizon,
    players,
    teams,
    fixtures,
    stats,
    priorSeasons,
    priorWorkloads,
  });

  // Price movement, attached to the candidates the optimiser will weigh. Before
  // roughly GW4 this is all zeros with confidence "none", which the optimiser
  // handles as "no price signal" rather than "no price movement".
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
    basis: pool.basis,
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
 *
 * Pure over rows rather than fetching them, so the fetch can be cached.
 */
function ratesByCode(
  rows: { player_code: number; season_name: string; minutes: number; starts: number; expected_goals: number | null; expected_assists: number | null; bonus: number }[],
): Map<number, PriorSeasonRates> {
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


/**
 * The loader every screen uses, deduplicated within a request.
 *
 * The entry layout needs a projection for its readout and the page below it
 * needs the same context, so without this a single navigation assembles the
 * pool twice. React's `cache` is per-request, so this is deduplication rather
 * than caching — the cross-request part is handled inside, by the cached row
 * readers.
 */
export const loadDecisionContext = cache(loadDecisionContextUncached);

/**
 * How much each player started last season, by CODE.
 *
 * Ungated, unlike `ratesByCode`: a start rate from few appearances is not
 * noise, it is the answer. See `workloadFromSeason`.
 */
function workloadsByCode(
  rows: { player_code: number; season_name: string; minutes: number; starts: number; expected_goals: number | null; expected_assists: number | null; bonus: number }[],
): Map<number, PriorSeasonWorkload> {
  const byCode = new Map<number, typeof rows>();
  for (const row of rows) {
    byCode.set(row.player_code, [...(byCode.get(row.player_code) ?? []), row]);
  }

  const workloads = new Map<number, PriorSeasonWorkload>();
  for (const [code, seasons] of byCode) {
    const resolved = mostRecentWorkload(
      seasons.map((season) => ({
        seasonName: season.season_name,
        minutes: season.minutes,
        starts: season.starts,
        expectedGoals: season.expected_goals,
        expectedAssists: season.expected_assists,
        bonus: season.bonus,
      })),
    );
    if (resolved !== null) workloads.set(code, resolved);
  }
  return workloads;
}
