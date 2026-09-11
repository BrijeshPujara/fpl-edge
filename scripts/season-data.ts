/**
 * A completed season, replayed from the vaastav CSVs.
 *
 * Shared by both backtests rather than copied into each, for the reason
 * `scripts/pool.ts` gives about the pool: these two replay the SAME season
 * under the same "only data that existed beforehand" discipline, and if each
 * loaded it separately they could drift into disagreeing about what a player
 * had done by a given gameweek. A prediction backtest and a selection backtest
 * that disagree about the input cannot be compared with each other, which is
 * the entire reason both exist.
 *
 * Cached locally on first run; delete .backtest-cache to refetch.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { POSITION, type PositionId } from "@/lib/rules";
import { NO_SET_PIECE_DUTY, type SetPieceDuty } from "@/lib/engine/set-pieces";
import {
  workloadFromSeason,
  type PriorSeasonWorkload,
} from "@/lib/engine/prior-season";

export const SEASON = "2025-26";
export const PRIOR_SEASON = "2024-25";
const ROOT =
  "https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data";
const BASE = `${ROOT}/${SEASON}`;
const CACHE = ".backtest-cache";

export const TOTAL_GWS = 38;

// --- CSV -------------------------------------------------------------------

/** Minimal RFC-4180 parser — player names contain commas. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }

  const [header, ...body] = rows;
  return body
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

export async function cached(path: string, name: string): Promise<string> {
  return cachedFrom(BASE, path, name);
}

async function cachedFrom(base: string, path: string, name: string): Promise<string> {
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, name);
  if (existsSync(file)) return readFileSync(file, "utf8");
  const res = await fetch(base + path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  const text = await res.text();
  writeFileSync(file, text);
  return text;
}

/**
 * Last season's workload for every player, keyed by THIS season's element id.
 *
 * Joined on `code`, never on name or element id. Element ids are renumbered
 * between seasons, and names differ in spelling, accents and which of them the
 * dataset picked — matching on either silently denies a prior to players who
 * have one, and the failure is invisible because a missing prior looks exactly
 * like a genuine new arrival. `code` is the stable identity, and it is what
 * `ratesByCode` joins on in production, so the backtest and the app agree
 * about who a player is.
 *
 * Season totals come from the prior season's end-of-season snapshot, which is
 * exactly the workload production reads out of `player_season_history`.
 */
export async function loadPriorWorkloads(): Promise<Map<number, PriorSeasonWorkload>> {
  const priorByCode = new Map<number, { minutes: number; starts: number }>();
  for (const r of parseCsv(
    await cachedFrom(`${ROOT}/${PRIOR_SEASON}`, "/players_raw.csv", `players_raw_${PRIOR_SEASON}.csv`),
  )) {
    priorByCode.set(num(r.code), { minutes: num(r.minutes), starts: num(r.starts) });
  }

  const out = new Map<number, PriorSeasonWorkload>();
  for (const r of parseCsv(await cached("/players_raw.csv", "players_raw.csv"))) {
    const prior = priorByCode.get(num(r.code));
    if (!prior) continue;
    const workload = workloadFromSeason({
      seasonName: PRIOR_SEASON,
      minutes: prior.minutes,
      starts: prior.starts,
      expectedGoals: null,
      expectedAssists: null,
      bonus: 0,
    });
    if (workload) out.set(num(r.id), workload);
  }
  return out;
}

export const num = (v: string | undefined) => {
  const x = Number.parseFloat(v ?? "");
  return Number.isFinite(x) ? x : 0;
};

// --- Rows ------------------------------------------------------------------

export interface Row {
  element: number;
  position: PositionId;
  gw: number;
  minutes: number;
  starts: number;
  xG: number;
  xA: number;
  defcon: number;
  bonus: number;
  goalsConceded: number;
  yellow: number;
  red: number;
  points: number;
  opponentTeam: number;
  wasHome: boolean;
  /** Price that gameweek, in tenths. The selection backtest budgets on it. */
  price: number;
  /** Club name as the CSV writes it — identity only, for the per-club cap. */
  team: string;
  name: string;
}

const POS_MAP: Record<string, PositionId> = {
  GK: POSITION.GK, GKP: POSITION.GK,
  DEF: POSITION.DEF, MID: POSITION.MID, FWD: POSITION.FWD,
};

export interface TeamRatings {
  attackHome: number; attackAway: number;
  defenceHome: number; defenceAway: number;
}

export interface SeasonData {
  byGw: Map<number, Row[]>;
  ratings: Map<number, TeamRatings>;
  duties: Map<number, SetPieceDuty>;
  league: {
    meanAttack: number | null; stdAttack: number | null;
    meanDefence: number | null; stdDefence: number | null;
  };
}

function mean(a: number[]) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function std(a: number[]) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
}

/**
 * Everything both backtests need, loaded once.
 *
 * `withSetPieces` is a parameter rather than an argv check so the caller owns
 * its own flags — the two scripts do not have to agree on spelling to agree on
 * data.
 */
export async function loadSeason(
  { withSetPieces = true }: { withSetPieces?: boolean } = {},
): Promise<SeasonData> {
  process.stdout.write(`Loading ${SEASON} data`);

  const ratings = new Map<number, TeamRatings>();
  for (const t of parseCsv(await cached("/teams.csv", "teams.csv"))) {
    ratings.set(num(t.id), {
      attackHome: num(t.strength_attack_home),
      attackAway: num(t.strength_attack_away),
      defenceHome: num(t.strength_defence_home),
      defenceAway: num(t.strength_defence_away),
    });
  }

  // Set-piece duty, from the season-end player snapshot. A duty that changed
  // hands in March is therefore credited from GW1, which FLATTERS the term.
  const duties = new Map<number, SetPieceDuty>();
  if (withSetPieces) {
    const order = (v: string | undefined) => {
      const x = Number.parseInt(v ?? "", 10);
      return Number.isFinite(x) && x > 0 ? x : null;
    };
    for (const r of parseCsv(await cached("/players_raw.csv", "players_raw.csv"))) {
      duties.set(num(r.id), {
        penaltiesOrder: order(r.penalties_order),
        cornersOrder: order(r.corners_and_indirect_freekicks_order),
        directFreekicksOrder: order(r.direct_freekicks_order),
      });
    }
  }

  const byGw = new Map<number, Row[]>();
  for (let gw = 1; gw <= TOTAL_GWS; gw++) {
    const rows = parseCsv(await cached(`/gws/gw${gw}.csv`, `gw${gw}.csv`))
      .map((r): Row | null => {
        const pos = POS_MAP[(r.position ?? "").toUpperCase()];
        if (!pos) return null;
        return {
          element: num(r.element), position: pos, gw,
          minutes: num(r.minutes), starts: num(r.starts),
          xG: num(r.expected_goals), xA: num(r.expected_assists),
          defcon: num(r.defensive_contribution), bonus: num(r.bonus),
          goalsConceded: num(r.goals_conceded),
          yellow: num(r.yellow_cards), red: num(r.red_cards),
          points: num(r.total_points),
          opponentTeam: num(r.opponent_team),
          wasHome: (r.was_home ?? "").toLowerCase().startsWith("t"),
          price: num(r.value),
          team: r.team ?? "",
          name: r.name ?? "",
        };
      })
      .filter((r): r is Row => r !== null);
    byGw.set(gw, rows);
    if (gw % 8 === 0) process.stdout.write(".");
  }
  process.stdout.write(" done\n");

  const all = [...ratings.values()];
  const attacks = all.flatMap((t) => [t.attackHome, t.attackAway]).filter((x) => x > 0);
  const defences = all.flatMap((t) => [t.defenceHome, t.defenceAway]).filter((x) => x > 0);

  return {
    byGw,
    ratings,
    duties,
    league: {
      meanAttack: attacks.length ? mean(attacks) : null,
      stdAttack: attacks.length ? std(attacks) : null,
      meanDefence: defences.length ? mean(defences) : null,
      stdDefence: defences.length ? std(defences) : null,
    },
  };
}

export { NO_SET_PIECE_DUTY };
