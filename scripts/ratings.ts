/**
 * Team attack and defence ratings, fitted from last season's matches.
 *
 * A staging post. The finished feature fits nightly on accumulated match xG
 * and stores the result in the database; this recovers the same thing from
 * `.backtest-cache/`, which is the only place match results currently live —
 * the `fixtures` table holds this season only, and nothing has been played.
 *
 * The FIT itself is not here — it lives in `lib/engine/team-ratings.ts`, where
 * it is tested and where the app can reach it. This file is only the part that
 * is genuinely script-shaped: reading a directory of CSVs.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fitRatings, type MatchResult, type RatingFit } from "@/lib/engine/team-ratings";

const CACHE = ".backtest-cache";

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
export function loadMatches(): MatchResult[] {
  const byFixture = new Map<string, Record<string, string>[]>();

  for (const file of readdirSync(CACHE)) {
    if (!/^gw\d+\.csv$/.test(file)) continue;
    for (const row of readCsv(`${CACHE}/${file}`)) {
      const key = `${row.round}:${row.fixture}`;
      byFixture.set(key, [...(byFixture.get(key) ?? []), row]);
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


/** Last season's ratings, fitted from the cache. */
export function fitFromCache(): RatingFit<string> {
  return fitRatings(loadMatches());
}
