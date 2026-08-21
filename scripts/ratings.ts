/**
 * Team attack and defence ratings, fitted from last season's matches.
 *
 * A staging post. The finished feature fits nightly on accumulated match xG
 * and stores the result in the database; this recovers the same thing from
 * `.backtest-cache/`, which is the only place historical results live — the
 * `fixtures` table holds the current season only.
 *
 * THREE seasons, not one. Sweeping the number of prior seasons against 2025/26
 * (mean RPS, lower better):
 *
 *     prior            all      GW1-6    GW7-19
 *     1 season         0.2106   0.2141   0.2104
 *     2 seasons        0.2098   0.2129   0.2086
 *     3 seasons        0.2090   0.2097   0.2076
 *
 * Decay was swept alongside — weighting older seasons at 0.4 to 0.8 of the one
 * after them — and never beat weighting them equally, so there is no decay
 * parameter here to be tuned or to overfit. More matches simply produce a
 * better-conditioned fit, and three seasons of a twenty-club league is still
 * only 1140 matches against 40 parameters.
 *
 * The honest caveat: FPL published no expected goals before 2022/23, so a
 * fourth season cannot be added without dropping to goals alone, and the
 * three-season result could only be verified on one held-out season. It is
 * better in every measurement available and significant in none of them
 * (t = -1.61). Adopted because more data is the right default when the
 * measurements agree on the sign, not because the evidence is conclusive.
 *
 * The FIT itself is not here — it lives in `lib/engine/team-ratings.ts`, where
 * it is tested and where the app can reach it. This file is only the part that
 * is genuinely script-shaped: reading a directory of CSVs.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fitRatings, type MatchResult, type RatingFit } from "@/lib/engine/team-ratings";

const CACHE = ".backtest-cache";

/**
 * Seasons the prior is fitted on, most recent first.
 *
 * 2022/23 is the earliest possible: FPL published no expected goals before it
 * and reports 0.00 for every player in older seasons, which is missing data
 * wearing the costume of a measurement.
 */
export const PRIOR_SEASONS = ["2025-26", "2024-25", "2023-24"] as const;

const SOURCE =
  "https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data";

/**
 * Where a season's gameweek CSVs live.
 *
 * The most recent season sits at the root of the cache for compatibility with
 * `backtest.ts`, which put it there first and still reads it from there.
 */
function seasonDir(season: string): string {
  return season === PRIOR_SEASONS[0] ? CACHE : `${CACHE}/${season}`;
}

/** Fetch a season's gameweeks if they are not already cached. */
export async function ensureSeason(season: string): Promise<number> {
  const dir = seasonDir(season);
  mkdirSync(dir, { recursive: true });

  let fetched = 0;
  for (let gw = 1; gw <= 38; gw++) {
    const file = `${dir}/gw${gw}.csv`;
    if (existsSync(file)) continue;

    const response = await fetch(`${SOURCE}/${season}/gws/gw${gw}.csv`);
    // A season in progress simply has fewer gameweeks; that is not an error.
    if (!response.ok) break;
    writeFileSync(file, await response.text());
    fetched += 1;
  }
  return fetched;
}

/** Minimal CSV reader — the cache is machine-written and well formed. */
function readCsv(path: string): Record<string, string>[] {
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  const header = splitRow(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitRow(line);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
  });
}

function splitRow(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.push(cell);
      cell = "";
    } else cell += ch;
  }
  out.push(cell);
  return out.map((c) => c.trim());
}

/**
 * Player-gameweek rows collapsed into matches.
 *
 * Each fixture appears once per player who featured in it, so grouping by
 * fixture id and reading the score off any row recovers the result, and
 * summing `expected_goals` over each side recovers team xG.
 */
export function loadMatches(seasons: readonly string[] = PRIOR_SEASONS): MatchResult[] {
  const byFixture = new Map<string, Record<string, string>[]>();

  for (const season of seasons) {
    const dir = seasonDir(season);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!/^gw\d+\.csv$/.test(file)) continue;
      for (const row of readCsv(`${dir}/${file}`)) {
        // Namespaced by season: fixture ids restart every year, and without
        // this every season would collapse onto the same 380 keys and the fit
        // would silently see one season's worth of matches.
        const key = `${season}:${row.round}:${row.fixture}`;
        byFixture.set(key, [...(byFixture.get(key) ?? []), row]);
      }
    }
  }

  const matches: MatchResult[] = [];
  for (const rows of byFixture.values()) {
    const home = new Set<string>();
    const away = new Set<string>();
    let homeXg = 0;
    let awayXg = 0;

    for (const row of rows) {
      const isHome = row.was_home.toLowerCase() === "true";
      (isHome ? home : away).add(row.team);
      const xg = Number(row.expected_goals) || 0;
      if (isHome) homeXg += xg;
      else awayXg += xg;
    }
    // A fixture with players attributed to more than one club a side is
    // corrupt; skip rather than fit on it.
    if (home.size !== 1 || away.size !== 1) continue;

    matches.push({
      home: [...home][0],
      away: [...away][0],
      homeGoals: Number(rows[0].team_h_score),
      awayGoals: Number(rows[0].team_a_score),
      homeXg,
      awayXg,
    });
  }
  return matches;
}


/** Ratings fitted from every cached prior season. */
export function fitFromCache(seasons: readonly string[] = PRIOR_SEASONS): RatingFit<string> {
  return fitRatings(loadMatches(seasons));
}
