/**
 * Solve for the best opening fifteen from £100.0m.
 *
 * The optimiser normally answers "what should I change?" against a squad that
 * already exists. Before the first deadline there is no squad, so the same
 * MILP is run with nothing locked in and the full budget free — which is the
 * initial-team problem stated exactly.
 *
 * Reads only. Writes nothing.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { getDb } from "@/lib/db/client";
import {
  getAllPlayers,
  getFixturesFrom,
  getRecentStats,
  getSeasonHistory,
  getTeams,
} from "@/lib/db/queries";
import { getSeasonContext } from "@/lib/fpl/season";
import { buildCandidatePool, toPlayerCandidate, type Candidate } from "@/lib/squad/candidates";
import { mostRecentRates, ratesFromSeason } from "@/lib/engine/prior-season";
import type { PriorSeasonRates } from "@/lib/engine/expected-points";
import { optimiseSquad } from "@/lib/engine/optimiser";
import { rankCaptains } from "@/lib/engine/captain";
import { createGlpkSolver } from "@/lib/solver/glpk";
import { DEFAULT_HORIZON } from "@/lib/engine/constants";
import { FORM_WINDOW } from "@/lib/engine/constants";
import { POSITION_SHORT, SQUAD_BUDGET, type PositionId } from "@/lib/rules";
import { money, ep as fmtEp } from "@/lib/format";

/** The season that just finished — the one whose workload proves a player plays. */
const LAST_SEASON = "2025/26";

async function main() {
  const horizon = Number(process.argv[2] ?? DEFAULT_HORIZON);
  const season = await getSeasonContext();
  if (!season.available) throw new Error("FPL API unavailable");
  const { target } = season.gameweek;

  const db = getDb();
  const [players, teams, fixtures] = await Promise.all([
    getAllPlayers(db),
    getTeams(db),
    getFixturesFrom(db, target.id, target.id + horizon),
  ]);
  const stats = await getRecentStats(
    db,
    players.map((p) => p.id),
    Math.max(1, target.id - FORM_WINDOW),
  );

  const history = await getSeasonHistory(db, players.map((p) => p.code));
  const byCode = new Map<number, typeof history>();
  for (const row of history) {
    byCode.set(row.player_code, [...(byCode.get(row.player_code) ?? []), row]);
  }
  const priorSeasons = new Map<number, PriorSeasonRates>();
  /** Which season each player's rates actually came from, and last season's workload. */
  const evidence = new Map<number, { from: string; lastMinutes: number; lastStarts: number }>();
  for (const [code, seasons] of byCode) {
    const totals = seasons.map((s) => ({
      seasonName: s.season_name,
      minutes: s.minutes,
      starts: s.starts,
      expectedGoals: s.expected_goals,
      expectedAssists: s.expected_assists,
      bonus: s.bonus,
    }));
    const rates = mostRecentRates(totals);
    if (rates !== null) priorSeasons.set(code, rates);

    // The season the rates came from is the most recent one `ratesFromSeason`
    // accepts — recomputed here rather than returned, so the engine keeps its
    // narrow interface.
    const usable = [...totals]
      .sort((a, b) => b.seasonName.localeCompare(a.seasonName))
      .find((t) => ratesFromSeason(t) !== null);
    const last = totals.filter((t) => t.seasonName === LAST_SEASON);
    evidence.set(code, {
      from: usable?.seasonName ?? "—",
      lastMinutes: last.reduce((a, t) => a + t.minutes, 0),
      lastStarts: last.reduce((a, t) => a + t.starts, 0),
    });
  }

  /*
   * Pre-season, FPL publishes `strength_overall_*` but leaves the attack and
   * defence splits at zero — so `ratingStats` finds nothing usable and every
   * opponent is scored as league-average. That is the engine behaving as
   * documented, and it means fixture difficulty contributes NOTHING to the
   * ranking right now.
   *
   * `--fdr` substitutes the overall rating for both splits so the same solve
   * can be run with fixture difficulty live, and the two answers compared. It
   * is an approximation — a team strong overall is assumed strong at both ends
   * — but it is a far better one than "every opponent is identical".
   */
  const useFdr = process.argv.includes("--fdr");
  const ratedTeams = useFdr
    ? teams.map((t) => ({
        ...t,
        strength_attack_home: t.strength_attack_home || t.strength_overall_home,
        strength_attack_away: t.strength_attack_away || t.strength_overall_away,
        strength_defence_home: t.strength_defence_home || t.strength_overall_home,
        strength_defence_away: t.strength_defence_away || t.strength_overall_away,
      }))
    : teams;

  const pool = buildCandidatePool({
    gw: target.id,
    horizon,
    players,
    teams: ratedTeams,
    fixtures,
    stats,
    priorSeasons,
  });

  // Anyone the API says cannot be selected at all is not a candidate. Flagged
  // but selectable players stay in, carrying the reduced minutes that flag
  // implies.
  const minMinutes = Number(
    process.argv.find((a) => a.startsWith("--min-minutes="))?.split("=")[1] ?? 0,
  );
  const codeOf = new Map(players.map((p) => [p.id, p.code]));
  const evidenceFor = (id: number) => evidence.get(codeOf.get(id) ?? -1);

  const selectable = pool.candidates.filter((c) => {
    if (c.unavailable) return false;
    if (minMinutes <= 0) return true;
    // The model shrinks toward a RATE and knows nothing about workload, so a
    // backup who last played three seasons ago looks identical to a nailed
    // starter. This gate is the missing half: proof he plays.
    return (evidenceFor(c.id)?.lastMinutes ?? 0) >= minMinutes;
  });
  const byId = new Map(selectable.map((c) => [c.id, c]));

  console.log(
    `\nGW${target.id} · ${target.name} · horizon ${horizon} · basis ${pool.basis} · ` +
      `${selectable.length} selectable of ${pool.candidates.length}` +
      (minMinutes > 0 ? ` · gate ${minMinutes}min in ${LAST_SEASON}` : "") +
      (useFdr ? " · FDR live" : " · FDR inert") +
      `\n`,
  );

  // Names to force into the fifteen, so the cost of a conviction pick can be
  // measured rather than argued about.
  const lockNames = (process.argv.find((a) => a.startsWith("--lock="))?.split("=")[1] ?? "")
    .split(",")
    .filter(Boolean);
  const lockedIn = lockNames.map((name) => {
    const match = selectable.find((c) => c.name === name);
    if (!match) throw new Error(`--lock: no selectable player named "${name}"`);
    return match.id;
  });
  if (lockedIn.length > 0) {
    console.log(`LOCKED: ${lockNames.join(", ")}\n`);
  }

  const solver = await createGlpkSolver();
  const t0 = Date.now();
  const result = optimiseSquad(
    selectable.map((c) => toPlayerCandidate(c)),
    solver,
    { budget: SQUAD_BUDGET, horizon, lockedIn },
  );
  const ms = Date.now() - t0;

  // GW1 opponent per club, so the opening week is legible next to the picks.
  const shortOf = new Map(teams.map((t) => [t.id, t.short_name]));
  const gw1Opponent = new Map<number, string>();
  for (const f of fixtures.filter((f) => f.gw === target.id)) {
    gw1Opponent.set(f.home_team, (shortOf.get(f.away_team) ?? "?").toUpperCase());
    gw1Opponent.set(f.away_team, (shortOf.get(f.home_team) ?? "?").toLowerCase());
  }

  const line = (id: number, starting: boolean) => {
    const c = byId.get(id)!;
    const gw1 = c.perGameweek.find((g) => g.gw === target.id);
    return (
      `  ${starting ? " " : "B"} ${POSITION_SHORT[c.position as PositionId].padEnd(3)} ` +
      `${c.name.padEnd(16)} ${c.club.padEnd(4)} ${money(c.price).padStart(6)}  ` +
      `ep(${horizon})=${fmtEp(c.ep).padStart(5)}  gw=${fmtEp(gw1?.ep ?? 0).padStart(4)}  ` +
      `v ${(gw1Opponent.get(c.teamId) ?? "—").padEnd(4)} ` +
      `rates=${(evidenceFor(c.id)?.from ?? "—").padEnd(7)} ` +
      `25/26: ${String(evidenceFor(c.id)?.lastMinutes ?? 0).padStart(4)}min ` +
      `${String(evidenceFor(c.id)?.lastStarts ?? 0).padStart(2)}st` +
      (c.flag ? `  [${c.flag.note.slice(0, 40)}]` : "")
    );
  };

  const order = (a: { position: number }, b: { position: number }) => a.position - b.position;
  console.log("STARTING XI");
  for (const p of [...result.starting].sort(order)) console.log(line(p.id, true));
  console.log("\nBENCH");
  for (const p of [...result.bench].sort(order)) console.log(line(p.id, false));

  const counts = new Map<string, number>();
  for (const p of [...result.starting, ...result.bench]) {
    const c = byId.get(p.id)!;
    counts.set(c.club, (counts.get(c.club) ?? 0) + 1);
  }

  console.log(`\nTOTALS`);
  console.log(`  cost                 ${money(result.totalCost)} of ${money(SQUAD_BUDGET)}  (bank ${money(SQUAD_BUDGET - result.totalCost)})`);
  console.log(`  starting XI ep       ${fmtEp(result.startingEp)} over ${horizon} gameweeks`);
  console.log(`  bench ep             ${fmtEp(result.benchEp)}`);
  console.log(`  marginal ep per £0.1m ${result.marginalEpPerTenth.toFixed(3)} (measured=${result.shadowPriceMeasured})`);
  console.log(`  clubs                ${[...counts].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(" ")}`);
  console.log(`  solve                ${ms}ms`);

  const squad: Candidate[] = [...result.starting, ...result.bench].map((p) => byId.get(p.id)!);
  const captains = rankCaptains(
    squad.map((c) => ({ playerId: c.id, input: c.modelInput, fixtures: c.thisGameweek })),
  );
  console.log(`\nARMBAND (GW${target.id})`);
  for (const c of captains.slice(0, 5)) {
    const name = byId.get(c.playerId)!.name;
    console.log(
      `  ${name.padEnd(16)} ep=${fmtEp(c.ep).padStart(5)}  ` +
        `haul(10+)=${(c.pHaul * 100).toFixed(0).padStart(2)}%  ` +
        `blank(<=2)=${(c.pBlank * 100).toFixed(0).padStart(2)}%`,
    );
  }
  if (process.argv.includes("--board")) {
    console.log(`\nBEST AVAILABLE BY POSITION (gate applied)`);
    for (const pos of [1, 2, 3, 4] as PositionId[]) {
      const top = selectable
        .filter((c) => c.position === pos)
        .sort((a, b) => b.ep - a.ep)
        .slice(0, 12);
      console.log(`\n  ${POSITION_SHORT[pos]}`);
      for (const c of top) {
        const owned = squad.some((x) => x.id === c.id) ? "*" : " ";
        console.log(
          `  ${owned} ${c.name.padEnd(16)} ${c.club.padEnd(4)} ${money(c.price).padStart(6)}  ` +
            `ep=${fmtEp(c.ep).padStart(5)}  per£m=${((c.ep / c.price) * 10).toFixed(2)}  ` +
            `25/26: ${String(evidenceFor(c.id)?.lastMinutes ?? 0).padStart(4)}min`,
        );
      }
    }
  }

  console.log();
  process.exit(0);
}

void main();
