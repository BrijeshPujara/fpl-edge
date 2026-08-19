/**
 * Backtest — PLAN.md section 5's calibration requirement.
 *
 * Replays the expected-points model over the 2025/26 season, gameweek by
 * gameweek, using ONLY data that existed before each gameweek, and reports mean
 * absolute error per position against a naive baseline.
 *
 * The bar PLAN.md sets: beat "the average of the last four gameweeks". If the
 * model cannot clear that, every constant in it is decoration and the honest
 * move is to say so.
 *
 * Data: the vaastav/Fantasy-Premier-League per-gameweek CSVs. Cached locally on
 * first run; delete .backtest-cache to refetch.
 *
 * Two limitations, stated up front because they flatter and penalise the model
 * in opposite directions:
 *
 *  - Availability flags are not in the dataset, so every player is treated as
 *    fit and the minutes model runs on appearance history alone. That PENALISES
 *    the model: in production it knows who is injured.
 *  - Team strength ratings come from the season-end snapshot, so early
 *    gameweeks use ratings that partly encode the future. That FLATTERS the
 *    opponent adjustment slightly. Run with `--neutral` to disable it entirely
 *    and see the model without that help.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  expectedPoints,
  type FixtureContext,
  type GameweekSample,
} from "@/lib/engine/expected-points";
import { POSITION, POSITION_SHORT, type PositionId } from "@/lib/rules";
import { FORM_WINDOW } from "@/lib/engine/constants";

const BASE =
  "https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data/2025-26";
const CACHE = ".backtest-cache";
const TOTAL_GWS = 38;
/** First gameweek projected. Needs FORM_WINDOW of history behind it. */
const START_GW = FORM_WINDOW + 1;
/** Gameweeks averaged by the naive baseline, per PLAN.md section 5. */
const BASELINE_WINDOW = 4;

const NEUTRAL = process.argv.includes("--neutral");

// --- CSV -------------------------------------------------------------------

/** Minimal RFC-4180 parser — player names contain commas. */
function parseCsv(text: string): Record<string, string>[] {
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

async function cached(path: string, name: string): Promise<string> {
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, name);
  if (existsSync(file)) return readFileSync(file, "utf8");
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  const text = await res.text();
  writeFileSync(file, text);
  return text;
}

const n = (v: string | undefined) => {
  const x = Number.parseFloat(v ?? "");
  return Number.isFinite(x) ? x : 0;
};

// --- Types -----------------------------------------------------------------

interface Row {
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
}

const POS_MAP: Record<string, PositionId> = {
  GK: POSITION.GK, GKP: POSITION.GK,
  DEF: POSITION.DEF, MID: POSITION.MID, FWD: POSITION.FWD,
};

interface TeamRatings {
  attackHome: number; attackAway: number;
  defenceHome: number; defenceAway: number;
}

// --- Stats -----------------------------------------------------------------

interface Acc {
  absModel: number; absBase: number; count: number;
  sumActual: number; sumModel: number; sumBase: number;
  playedCount: number; playedAbsModel: number; playedSumActual: number; playedSumModel: number;
  blankCount: number; blankAbsModel: number; blankSumModel: number;
}
const acc = (): Acc => ({
  absModel: 0, absBase: 0, count: 0,
  sumActual: 0, sumModel: 0, sumBase: 0,
  playedCount: 0, playedAbsModel: 0, playedSumActual: 0, playedSumModel: 0,
  blankCount: 0, blankAbsModel: 0, blankSumModel: 0,
});

function mean(a: number[]) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function std(a: number[]) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
}

async function main() {
  process.stdout.write("Loading 2025/26 data");
  const teamRows = parseCsv(await cached("/teams.csv", "teams.csv"));
  const ratings = new Map<number, TeamRatings>();
  for (const t of teamRows) {
    ratings.set(n(t.id), {
      attackHome: n(t.strength_attack_home),
      attackAway: n(t.strength_attack_away),
      defenceHome: n(t.strength_defence_home),
      defenceAway: n(t.strength_defence_away),
    });
  }

  const byGw = new Map<number, Row[]>();
  for (let gw = 1; gw <= TOTAL_GWS; gw++) {
    const text = await cached(`/gws/gw${gw}.csv`, `gw${gw}.csv`);
    const rows = parseCsv(text)
      .map((r): Row | null => {
        const pos = POS_MAP[(r.position ?? "").toUpperCase()];
        if (!pos) return null;
        return {
          element: n(r.element), position: pos, gw,
          minutes: n(r.minutes), starts: n(r.starts),
          xG: n(r.expected_goals), xA: n(r.expected_assists),
          defcon: n(r.defensive_contribution), bonus: n(r.bonus),
          goalsConceded: n(r.goals_conceded),
          yellow: n(r.yellow_cards), red: n(r.red_cards),
          points: n(r.total_points),
          opponentTeam: n(r.opponent_team),
          wasHome: (r.was_home ?? "").toLowerCase().startsWith("t"),
        };
      })
      .filter((r): r is Row => r !== null);
    byGw.set(gw, rows);
    if (gw % 8 === 0) process.stdout.write(".");
  }
  process.stdout.write(" done\n");

  // League mean and spread of the strength ratings, for normalisation.
  const all = [...ratings.values()];
  const attacks = all.flatMap((t) => [t.attackHome, t.attackAway]).filter((x) => x > 0);
  const defences = all.flatMap((t) => [t.defenceHome, t.defenceAway]).filter((x) => x > 0);
  const meanAttack = attacks.length ? mean(attacks) : null;
  const stdAttack = attacks.length ? std(attacks) : null;
  const meanDefence = defences.length ? mean(defences) : null;
  const stdDefence = defences.length ? std(defences) : null;

  // History per player, most recent first.
  const history = new Map<number, Row[]>();
  const pushHistory = (rows: Row[]) => {
    for (const r of rows) {
      const h = history.get(r.element) ?? [];
      h.unshift(r);
      history.set(r.element, h);
    }
  };
  for (let gw = 1; gw < START_GW; gw++) pushHistory(byGw.get(gw) ?? []);

  const overall = acc();
  const perPosition = new Map<PositionId, Acc>();
  for (const p of Object.values(POSITION)) perPosition.set(p, acc());

  for (let gw = START_GW; gw <= TOTAL_GWS; gw++) {
    for (const row of byGw.get(gw) ?? []) {
      const past = history.get(row.element) ?? [];
      if (past.length < BASELINE_WINDOW) continue;

      const recent: GameweekSample[] = past.slice(0, FORM_WINDOW).map((s) => ({
        minutes: s.minutes,
        started: s.starts > 0,
        expectedGoals: s.xG,
        expectedAssists: s.xA,
        defensiveContribution: s.defcon,
        bonus: s.bonus,
        goalsConceded: s.goalsConceded,
        yellowCards: s.yellow,
        redCards: s.red,
      }));

      const opp = ratings.get(row.opponentTeam);
      const useRatings = !NEUTRAL && opp !== undefined;

      const fixture: FixtureContext = {
        gw,
        isHome: row.wasHome,
        // The player's own team defence is not in the per-gameweek rows, so the
        // league mean stands in — the opponent term is what is being tested.
        teamDefence: useRatings ? meanDefence : null,
        opponentAttack: useRatings ? (row.wasHome ? opp!.attackAway : opp!.attackHome) : null,
        leagueMeanAttack: useRatings ? meanAttack : null,
        leagueStdAttack: useRatings ? stdAttack : null,
        opponentDefence: useRatings ? (row.wasHome ? opp!.defenceAway : opp!.defenceHome) : null,
        leagueMeanDefence: useRatings ? meanDefence : null,
        leagueStdDefence: useRatings ? stdDefence : null,
      };

      const predicted = expectedPoints(
        {
          playerId: row.element,
          position: row.position,
          teamId: 0,
          minutes: {
            // The dataset carries no availability flags, so everyone is treated
            // as fit and the minutes model runs on appearances alone.
            status: "a",
            chanceOfPlayingNextRound: null,
            recentStarts: past.slice(0, FORM_WINDOW).map((s) => s.starts > 0),
            recentMinutes: past.slice(0, FORM_WINDOW).map((s) => s.minutes),
          },
          recent,
          priorSeason: null,
        },
        fixture,
      ).total;

      const baseline = mean(past.slice(0, BASELINE_WINDOW).map((s) => s.points));

      const a = Math.abs(predicted - row.points);
      const b = Math.abs(baseline - row.points);

      for (const bucket of [overall, perPosition.get(row.position)!]) {
        bucket.absModel += a;
        bucket.absBase += b;
        bucket.count += 1;
        bucket.sumActual += row.points;
        bucket.sumModel += predicted;
        bucket.sumBase += baseline;
        // Split on whether the player actually featured. Most rows in this
        // dataset are players who did not play at all, and predicting those
        // correctly is most of the scoring.
        if (row.minutes > 0) {
          bucket.playedCount += 1;
          bucket.playedAbsModel += a;
          bucket.playedSumActual += row.points;
          bucket.playedSumModel += predicted;
        } else {
          bucket.blankCount += 1;
          bucket.blankAbsModel += a;
          bucket.blankSumModel += predicted;
        }
      }
    }
    pushHistory(byGw.get(gw) ?? []);
  }

  // --- Report --------------------------------------------------------------

  const pct = (m: number, b: number) => ((b - m) / b) * 100;
  const line = (label: string, x: Acc) => {
    const m = x.absModel / x.count;
    const b = x.absBase / x.count;
    const delta = pct(m, b);
    const verdict = delta > 0 ? "BEATS" : "LOSES TO";
    return (
      `  ${label.padEnd(8)} n=${String(x.count).padStart(6)}  ` +
      `mean actual=${(x.sumActual / x.count).toFixed(2).padStart(5)}  ` +
      `model MAE=${m.toFixed(3)}  baseline MAE=${b.toFixed(3)}  ` +
      `${verdict} by ${Math.abs(delta).toFixed(1)}%`
    );
  };

  console.log(`\nBACKTEST — 2025/26, GW${START_GW}-${TOTAL_GWS}`);
  console.log(
    `Opponent adjustment: ${NEUTRAL ? "DISABLED (--neutral)" : "enabled (season-end ratings)"}`,
  );
  console.log(`Baseline: mean points over the previous ${BASELINE_WINDOW} gameweeks\n`);

  console.log(line("ALL", overall));
  console.log("");
  for (const [pos, bucket] of [...perPosition].sort((a, b) => a[0] - b[0])) {
    if (bucket.count > 0) console.log(line(POSITION_SHORT[pos], bucket));
  }

  console.log("\nDIAGNOSTICS");
  console.log(
    `  overall bias        model ${(overall.sumModel / overall.count).toFixed(3)} vs actual ` +
    `${(overall.sumActual / overall.count).toFixed(3)}  ` +
    `(${overall.sumModel > overall.sumActual ? "OVER" : "UNDER"}-predicts by ` +
    `${Math.abs((overall.sumModel - overall.sumActual) / overall.count).toFixed(3)} pts/row)`,
  );
  console.log(
    `  baseline bias       model ${(overall.sumBase / overall.count).toFixed(3)} vs actual ` +
    `${(overall.sumActual / overall.count).toFixed(3)}`,
  );
  const dnp = overall.blankCount / overall.count;
  console.log(
    `  did NOT play        ${overall.blankCount} rows (${(dnp * 100).toFixed(1)}% of all)  ` +
    `mean predicted=${(overall.blankSumModel / overall.blankCount).toFixed(3)}  ` +
    `MAE=${(overall.blankAbsModel / overall.blankCount).toFixed(3)}`,
  );
  console.log(
    `  DID play            ${overall.playedCount} rows  ` +
    `mean actual=${(overall.playedSumActual / overall.playedCount).toFixed(2)}  ` +
    `mean predicted=${(overall.playedSumModel / overall.playedCount).toFixed(2)}  ` +
    `MAE=${(overall.playedAbsModel / overall.playedCount).toFixed(3)}`,
  );

  const beat = pct(overall.absModel / overall.count, overall.absBase / overall.count) > 0;
  console.log(
    `\nPLAN.md section 5 done-when: ${beat ? "MET — model beats the naive baseline" : "NOT MET — model does not beat the naive baseline"}`,
  );
  process.exit(0);
}

void main();
