import "server-only";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, isDbConfigured } from "@/lib/db/client";
import {
  getAllPlayers,
  getFixturesFrom,
  getTeams,
  type PlayerRow,
} from "@/lib/db/queries";
import { buildCandidatePool, type Candidate } from "@/lib/squad/candidates";
import type { ReadyDecisionContext } from "@/lib/db/decision-context";
import type { StatLike } from "@/lib/squad/view";
import { bestXi } from "@/lib/engine/best-xi";
import { FORM_WINDOW } from "@/lib/engine/constants";
import {
  MAX_PLAYERS_PER_CLUB,
  POSITION,
  SQUAD_BUDGET,
  SQUAD_COMPOSITION,
  SQUAD_SIZE,
  type PositionId,
} from "@/lib/rules";
import { resolveChipWindows } from "@/lib/fpl/gameweek";
import { getBootstrapStatic } from "@/lib/fpl/client";

/**
 * A dev-only preview of the decision screens, populated with real football.
 *
 * The screens gate on `projectable` and refuse to rank anything until a
 * gameweek has been played — correct, and also means nobody can see them work
 * until the season is under way. This fills that gap for development without
 * weakening the rule, and it is fenced three ways:
 *
 *   1. `isPreviewEnabled` is false in production, and `app/preview/layout.tsx`
 *      returns a 404 rather than rendering. The real routes never consult this
 *      module at all, so there is no flag to leave switched on by accident.
 *   2. Nothing here writes to the database. The synthetic history exists for
 *      the duration of one render and is never persisted.
 *   3. Every preview page carries a banner saying what it is.
 *
 * The data is not invented. Appearance and expected-goal history come from the
 * real 2025/26 season, via the CSVs the backtest already caches, matched onto
 * this season's players by name. Roughly three quarters match; the rest are new
 * signings and promoted-club players who genuinely have no Premier League
 * history, so the model rating them low is correct behaviour rather than a gap.
 */

/**
 * The gameweek the preview pretends it is.
 *
 * Late enough to have a full form window behind it, early enough that plenty of
 * fixtures remain ahead for the chip planner to scan.
 */
export const PREVIEW_GW = 8;

const CACHE = ".backtest-cache";

export function isPreviewEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}

export type PreviewContext =
  | { state: "disabled" }
  | { state: "no-db" }
  | { state: "no-cache" }
  | {
      state: "ready";
      context: ReadyDecisionContext;
      /** How many of this season's players got real history. Shown in the banner. */
      matched: number;
      /**
       * The synthetic history itself. `buildSquadView` takes rows rather than a
       * context, so the pitch preview needs the same stats the projections were
       * built from — handing them back is what stops the two disagreeing.
       */
      stats: StatLike[];
    };

// ---------------------------------------------------------------------------
// Name matching
// ---------------------------------------------------------------------------

/** Case, accents and hyphens removed — "Dúbravka" and "Dubravka" are one man. */
function normaliseName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Minimal CSV split. The only quoted field that matters here is the name. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(field); field = ""; }
    else field += c;
  }
  out.push(field);
  return out;
}

interface SeasonRow {
  name: string;
  minutes: number;
  starts: number;
  expectedGoals: number;
  expectedAssists: number;
  defensiveContribution: number;
  bonus: number;
  goalsConceded: number;
  yellowCards: number;
  redCards: number;
  totalPoints: number;
}

function readGameweek(gw: number): SeasonRow[] | null {
  const file = join(CACHE, `gw${gw}.csv`);
  if (!existsSync(file)) return null;

  const [header, ...body] = readFileSync(file, "utf8").split("\n");
  const cols = parseCsvLine(header);
  const at = (row: string[], key: string) => row[cols.indexOf(key)] ?? "";
  const num = (row: string[], key: string) => {
    const v = Number.parseFloat(at(row, key));
    return Number.isFinite(v) ? v : 0;
  };

  return body
    .filter((line) => line.trim().length > 0)
    .map((line) => parseCsvLine(line))
    .map((row) => ({
      name: at(row, "name"),
      minutes: num(row, "minutes"),
      starts: num(row, "starts"),
      expectedGoals: num(row, "expected_goals"),
      expectedAssists: num(row, "expected_assists"),
      defensiveContribution: num(row, "defensive_contribution"),
      bonus: num(row, "bonus"),
      goalsConceded: num(row, "goals_conceded"),
      yellowCards: num(row, "yellow_cards"),
      redCards: num(row, "red_cards"),
      totalPoints: num(row, "total_points"),
    }));
}

/**
 * Last season's history, keyed by this season's player ids.
 *
 * Matched on full name first, then on surname alone — which picks up the
 * players the API writes differently between seasons. Surname matching is
 * deliberately last and never overrides a full-name match.
 */
function historyByPlayerId(
  players: PlayerRow[],
  gameweeks: number[],
): { stats: StatLike[]; seasonPoints: Map<number, number>; matched: number } {
  const rowsByGw = new Map<number, SeasonRow[]>();
  for (const gw of gameweeks) {
    const rows = readGameweek(gw);
    if (rows) rowsByGw.set(gw, rows);
  }
  if (rowsByGw.size === 0) {
    return { stats: [], seasonPoints: new Map(), matched: 0 };
  }

  const byFullName = new Map<string, number>();
  const bySurname = new Map<string, number>();
  for (const player of players) {
    const full = normaliseName(`${player.first_name} ${player.second_name}`);
    byFullName.set(full, player.id);
    const surname = normaliseName(player.second_name).split(" ").at(-1);
    if (surname && !bySurname.has(surname)) bySurname.set(surname, player.id);
  }

  const stats: StatLike[] = [];
  const seasonPoints = new Map<number, number>();
  const matchedIds = new Set<number>();

  for (const [gw, rows] of rowsByGw) {
    for (const row of rows) {
      const name = normaliseName(row.name);
      const id =
        byFullName.get(name) ?? bySurname.get(name.split(" ").at(-1) ?? "");
      if (id === undefined) continue;

      matchedIds.add(id);
      seasonPoints.set(id, (seasonPoints.get(id) ?? 0) + row.totalPoints);
      stats.push({
        player_id: id,
        gw,
        minutes: row.minutes,
        starts: row.starts,
        goals: 0,
        assists: 0,
        expected_goals: row.expectedGoals,
        expected_assists: row.expectedAssists,
        defensive_contribution: row.defensiveContribution,
        bonus: row.bonus,
        goals_conceded: row.goalsConceded,
        yellow_cards: row.yellowCards,
        red_cards: row.redCards,
      });
    }
  }

  return { stats, seasonPoints, matched: matchedIds.size };
}

// ---------------------------------------------------------------------------
// A plausible squad
// ---------------------------------------------------------------------------

/**
 * Fifteen players chosen the way a human would: by LAST SEASON'S POINTS.
 *
 * Deliberately not by the model's own expected points. A squad built on the
 * same signal the optimiser uses is already optimal by construction, so
 * `/transfers` would correctly report that nothing helps — a truthful screen
 * and a useless demonstration. Picking on last season's points is both what
 * people actually do and a different enough signal that the model finds real
 * disagreements to show.
 */
export function pickSquad(
  candidates: Candidate[],
  seasonPoints: Map<number, number>,
): Candidate[] {
  const selectable = candidates.filter((c) => !c.unavailable);

  // Ranked by last season's points; everyone else stays available as filler.
  const ranked = [...selectable].sort(
    (a, b) =>
      (seasonPoints.get(b.id) ?? 0) - (seasonPoints.get(a.id) ?? 0) ||
      a.price - b.price,
  );

  const squad: Candidate[] = [];
  const taken = new Set<number>();
  const perClub = new Map<number, number>();
  const perPosition = new Map<PositionId, number>();
  let spend = 0;

  const needed = (position: PositionId) =>
    SQUAD_COMPOSITION[position] - (perPosition.get(position) ?? 0);

  const legal = (c: Candidate) =>
    !taken.has(c.id) &&
    needed(c.position) > 0 &&
    (perClub.get(c.teamId) ?? 0) < MAX_PLAYERS_PER_CLUB;

  /**
   * The cheapest legal way to fill every remaining slot, so the greedy pass
   * cannot spend money it will need later.
   *
   * Computed over EVERY available player, not just the ranked ones. Restricting
   * it to players with last-season points overstates the reserve badly — cheap
   * enablers are precisely the players who have no history — and the squad ends
   * up a forward short, which is how this was found.
   */
  const reserve = (excluding: PositionId) => {
    let total = 0;
    for (const position of Object.values(POSITION)) {
      const count =
        position === excluding ? needed(position) - 1 : needed(position);
      if (count <= 0) continue;
      total += selectable
        .filter((c) => c.position === position && !taken.has(c.id))
        .map((c) => c.price)
        .sort((a, b) => a - b)
        .slice(0, count)
        .reduce((sum, price) => sum + price, 0);
    }
    return total;
  };

  const add = (c: Candidate) => {
    squad.push(c);
    taken.add(c.id);
    spend += c.price;
    perClub.set(c.teamId, (perClub.get(c.teamId) ?? 0) + 1);
    perPosition.set(c.position, (perPosition.get(c.position) ?? 0) + 1);
  };

  for (const candidate of ranked) {
    if (squad.length === SQUAD_SIZE) break;
    if (!legal(candidate)) continue;
    if (spend + candidate.price + reserve(candidate.position) > SQUAD_BUDGET) {
      continue;
    }
    add(candidate);
  }

  // Fill anything still open with the cheapest legal player available. A squad
  // of fourteen is not a squad, and every screen downstream assumes fifteen.
  if (squad.length < SQUAD_SIZE) {
    const cheapest = [...selectable].sort((a, b) => a.price - b.price);
    for (const candidate of cheapest) {
      if (squad.length === SQUAD_SIZE) break;
      if (!legal(candidate)) continue;
      if (spend + candidate.price > SQUAD_BUDGET) continue;
      add(candidate);
    }
  }

  return squad;
}

// ---------------------------------------------------------------------------

export async function loadPreviewContext(
  horizon: number,
): Promise<PreviewContext> {
  if (!isPreviewEnabled()) return { state: "disabled" };
  if (!isDbConfigured()) return { state: "no-db" };

  const db = getDb();
  const [players, teams, fixtures] = await Promise.all([
    getAllPlayers(db),
    getTeams(db),
    getFixturesFrom(db, PREVIEW_GW, PREVIEW_GW + horizon),
  ]);

  const window = Array.from(
    { length: FORM_WINDOW },
    (_, i) => PREVIEW_GW - FORM_WINDOW + i,
  ).filter((gw) => gw >= 1);

  const { stats, seasonPoints, matched } = historyByPlayerId(players, window);
  if (stats.length === 0) return { state: "no-cache" };

  const pool = buildCandidatePool({
    gw: PREVIEW_GW,
    horizon,
    players,
    teams,
    fixtures,
    stats,
  });

  const squad = pickSquad(pool.candidates, seasonPoints);
  const teamValue = squad.reduce((sum, c) => sum + c.price, 0);

  // Chip windows come from the live API when it is reachable; the preview is
  // about the screens, not about the API, so a failure here falls back to the
  // shape the game has used for the last several seasons rather than aborting.
  const chipWindows = await getBootstrapStatic()
    .then((b) => resolveChipWindows(b.chips))
    .catch(() => FALLBACK_CHIP_WINDOWS);

  return {
    state: "ready",
    context: {
      state: "ready",
      gw: PREVIEW_GW,
      gwName: `Gameweek ${PREVIEW_GW}`,
      gameweeks: pool.gameweeks,
      chipWindows,
      squad,
      pool: pool.candidates,
      bank: SQUAD_BUDGET - teamValue,
      teamValue,
      freeTransfers: 1,
      chipPlayed: null,
      // The price model needs a run of daily snapshots that does not exist yet.
      // Empty rather than fabricated: a made-up price move would change which
      // transfer the optimiser recommends, which is the one thing a preview
      // must not quietly do.
      priceDeltas: new Map(),
      projectable: pool.projectable,
    },
    matched,
    stats,
  };
}

const FALLBACK_CHIP_WINDOWS = resolveChipWindows([
  { id: 1, name: "wildcard", number: 1, start_event: 2, stop_event: 19, chip_type: "transfer" },
  { id: 2, name: "wildcard", number: 2, start_event: 20, stop_event: 38, chip_type: "transfer" },
  { id: 3, name: "freehit", number: 1, start_event: 2, stop_event: 19, chip_type: "transfer" },
  { id: 4, name: "freehit", number: 2, start_event: 20, stop_event: 38, chip_type: "transfer" },
  { id: 5, name: "3xc", number: 1, start_event: 1, stop_event: 19, chip_type: "team" },
  { id: 6, name: "3xc", number: 2, start_event: 20, stop_event: 38, chip_type: "team" },
  { id: 7, name: "bboost", number: 1, start_event: 1, stop_event: 19, chip_type: "team" },
  { id: 8, name: "bboost", number: 2, start_event: 20, stop_event: 38, chip_type: "team" },
]);

/** Synthesised picks, so the pitch view can render a preview squad. */
export function previewPicks(squad: Candidate[]) {
  const xi = bestXi(squad.map((c) => ({ id: c.id, position: c.position, ep: c.ep })));
  const startingIds = xi.starting.map((p) => p.id);
  const benchIds = xi.bench.map((p) => p.id);
  const captainId = xi.captain?.id ?? startingIds[0];
  const viceId = [...xi.starting].sort((a, b) => b.ep - a.ep)[1]?.id;

  return [...startingIds, ...benchIds].map((playerId, index) => ({
    player_id: playerId,
    position: index + 1,
    is_captain: playerId === captainId,
    is_vice: playerId === viceId,
  }));
}
