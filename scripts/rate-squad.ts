/**
 * Rate a squad someone actually picked.
 *
 * The optimiser says what it would have bought. This says what a real fifteen
 * is worth on the same numbers, which is the only way to compare the two
 * honestly — and the more useful direction, since the squad is already picked
 * and the question is what to do with it.
 *
 * Names are matched on FPL's short name, with `Name@CLUB` to disambiguate the
 * duplicates (there are two Hughes and two Thomases this season).
 *
 * Reads only. Writes nothing.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { loadPool } from "./pool";
import { fitFromCache } from "./ratings";
import { PROMOTED_PRIOR, unratedIn } from "@/lib/engine/team-ratings";
import { toPlayerCandidate, type Candidate } from "@/lib/squad/candidates";
import { optimiseSquad } from "@/lib/engine/optimiser";
import { rankCaptains } from "@/lib/engine/captain";
import { bestXi } from "@/lib/engine/best-xi";
import { createGlpkSolver } from "@/lib/solver/glpk";
import { DEFAULT_HORIZON } from "@/lib/engine/constants";
import {
  cleanSheetProbabilities,
  outcomeProbabilities,
  scoreline,
  type TeamStrength,
} from "@/lib/engine/scoreline";
import { POSITION_SHORT, SQUAD_BUDGET, type PositionId } from "@/lib/rules";
import { money, ep as fmtEp } from "@/lib/format";

async function main() {
  const horizon = Number(
    process.argv.find((a) => a.startsWith("--horizon="))?.split("=")[1] ??
      DEFAULT_HORIZON,
  );
  const wanted = (
    process.argv.find((a) => a.startsWith("--squad="))?.split("=")[1] ?? ""
  )
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);

  if (wanted.length === 0) {
    console.error('Pass --squad="Name,Name@CLUB,..." with fifteen players.');
    process.exit(1);
  }

  const pool = await loadPool({ horizon, useFdr: process.argv.includes("--fdr") });
  const teamName = new Map(pool.teams.map((t) => [t.id, t]));

  const squad: Candidate[] = wanted.map((entry) => {
    const [name, club] = entry.split("@");
    const matches = pool.candidates.filter(
      (c) => c.name === name && (!club || c.club === club),
    );
    if (matches.length === 0) throw new Error(`No player named "${entry}"`);
    if (matches.length > 1) {
      throw new Error(
        `"${entry}" is ambiguous: ${matches.map((m) => `${m.name}@${m.club}`).join(", ")}`,
      );
    }
    return matches[0];
  });

  // --- Fixtures, from the fitted ratings ---------------------------------
  const fit = fitFromCache();
  const names = pool.teams.map((t) => t.name);
  const prior: TeamStrength = PROMOTED_PRIOR;
  const relegated = unratedIn(fit, names, true);
  const strengthOf = (id: number) =>
    fit.strength.get(teamName.get(id)?.name ?? "") ?? prior;
  const unrated = new Set(
    pool.teams.filter((t) => !fit.strength.has(t.name)).map((t) => t.id),
  );

  /** Clean sheet and win probability for each club this gameweek. */
  const matchOf = new Map<
    number,
    { opponent: string; isHome: boolean; cleanSheet: number; win: number }
  >();
  for (const f of pool.fixtures.filter((f) => f.gw === pool.gw)) {
    const s = scoreline(strengthOf(f.home_team), strengthOf(f.away_team), {
      leagueMean: fit.leagueMean,
      homeAdvantage: fit.homeAdvantage,
    });
    const cs = cleanSheetProbabilities(s);
    const o = outcomeProbabilities(s);
    matchOf.set(f.home_team, {
      opponent: teamName.get(f.away_team)?.short_name ?? "?",
      isHome: true,
      cleanSheet: cs.home,
      win: o.home,
    });
    matchOf.set(f.away_team, {
      opponent: teamName.get(f.home_team)?.short_name ?? "?",
      isHome: false,
      cleanSheet: cs.away,
      win: o.away,
    });
  }

  // --- The eleven the model would start ----------------------------------
  const epFor = (c: Candidate) =>
    c.perGameweek.find((g) => g.gw === pool.gw)?.ep ?? 0;
  const xi = bestXi(
    squad.map((c) => ({ id: c.id, position: c.position, ep: epFor(c) })),
  );
  const starting = new Set(xi.starting.map((p) => p.id));

  const cost = squad.reduce((sum, c) => sum + c.price, 0);
  const clubs = new Map<string, number>();
  for (const c of squad) clubs.set(c.club, (clubs.get(c.club) ?? 0) + 1);

  console.log(
    `\nGW${pool.gw} · ${squad.length} players · basis ${pool.basis}` +
      (process.argv.includes("--fdr") ? " · FDR live" : " · FDR inert"),
  );
  console.log(
    `ratings fitted on 2025/26; ${[...unrated].length} promoted sides ` +
      `use the average of ${relegated.join(", ")}\n`,
  );

  const pc = (x: number) => `${(x * 100).toFixed(0)}%`.padStart(4);
  console.log(
    "    POS NAME             CLUB   PRICE  EP(GW) EP(H)  FIXTURE   WIN   CS   25/26",
  );
  console.log("-".repeat(92));

  const order = (a: Candidate, b: Candidate) =>
    a.position - b.position || epFor(b) - epFor(a);

  for (const c of [...squad].sort(order)) {
    const m = matchOf.get(c.teamId);
    const ev = pool.evidenceFor(c.id);
    // Lowercase means away, and "?" marks a fixture whose opponent rating is
    // the promoted prior rather than a measurement.
    const opponentId = pool.fixtures.find(
      (f) =>
        f.gw === pool.gw &&
        (f.home_team === c.teamId || f.away_team === c.teamId),
    );
    const otherId =
      opponentId === undefined
        ? null
        : opponentId.home_team === c.teamId
          ? opponentId.away_team
          : opponentId.home_team;
    const fixture = m
      ? `${m.isHome ? m.opponent : m.opponent.toLowerCase()}${otherId !== null && unrated.has(otherId) ? "?" : ""}`
      : "—";
    console.log(
      `  ${starting.has(c.id) ? " " : "B"} ${POSITION_SHORT[c.position as PositionId].padEnd(3)} ` +
        `${c.name.padEnd(16)} ${c.club.padEnd(4)} ${money(c.price).padStart(6)}  ` +
        `${fmtEp(epFor(c)).padStart(5)} ${fmtEp(c.ep).padStart(5)}  ` +
        `${fixture.padEnd(6)} ${m ? pc(m.win) : "   —"} ${m ? pc(m.cleanSheet) : "   —"}  ` +
        `${String(ev?.lastMinutes ?? 0).padStart(4)}min ${String(ev?.lastStarts ?? 0).padStart(2)}st` +
        (c.flag ? `  [${c.flag.note.slice(0, 30)}]` : ""),
    );
  }

  const startingEp = xi.starting.reduce(
    (sum, p) => sum + (squad.find((c) => c.id === p.id)?.ep ?? 0),
    0,
  );

  console.log(`\nTOTALS`);
  console.log(
    `  cost                 ${money(cost)} of ${money(SQUAD_BUDGET)}  ` +
      `(bank ${money(SQUAD_BUDGET - cost)})`,
  );
  console.log(`  formation            ${xi.formation ?? "—"}`);
  console.log(`  starting XI ep       ${fmtEp(startingEp)} over ${horizon} gameweeks`);
  console.log(
    `  clubs                ${[...clubs].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(" ")}`,
  );

  // --- What the optimiser would have done, on identical numbers ----------
  const solver = await createGlpkSolver();

  /*
   * The comparison is gated by default, and that matters. Left ungated the
   * optimiser buys players with no evidence they play — a backup keeper whose
   * rates come from three seasons ago looks identical to an ever-present,
   * because the model shrinks toward a RATE and pre-season every available
   * player carries the same flat start probability. Measuring a real squad
   * against a phantom one overstates the gap by several points.
   */
  const minMinutes = Number(
    process.argv.find((a) => a.startsWith("--min-minutes="))?.split("=")[1] ??
      1200,
  );
  const selectable = pool.candidates.filter(
    (c) =>
      !c.unavailable &&
      (pool.evidenceFor(c.id)?.lastMinutes ?? 0) >= minMinutes,
  );
  const best = optimiseSquad(
    selectable.map((c) => toPlayerCandidate(c)),
    solver,
    { budget: SQUAD_BUDGET, horizon, shadowPrice: false },
  );
  const gap = best.startingEp - startingEp;

  console.log(
    `\n  vs the optimiser     ${fmtEp(best.startingEp)} ` +
      `(from players with ${minMinutes}+ minutes last season) — this squad is ` +
      `${gap >= 0 ? `${fmtEp(gap)} behind` : `${fmtEp(-gap)} ahead`} ` +
      `(${((startingEp / best.startingEp) * 100).toFixed(1)}% of it)`,
  );
  console.log(
    "  The optimum is not a target. It is free to buy players with no evidence\n" +
      "  they play, and it knows nothing you know.",
  );

  // --- The armband --------------------------------------------------------
  const captains = rankCaptains(
    squad
      .filter((c) => starting.has(c.id))
      .map((c) => ({
        playerId: c.id,
        input: c.modelInput,
        fixtures: c.thisGameweek,
      })),
  );
  const nameOf = new Map(squad.map((c) => [c.id, c.name]));

  console.log(`\nARMBAND (GW${pool.gw})`);
  for (const c of captains.slice(0, 5)) {
    console.log(
      `  ${(nameOf.get(c.playerId) ?? "").padEnd(16)} ep=${fmtEp(c.ep).padStart(5)}  ` +
        `haul(10+)=${(c.pHaul * 100).toFixed(0).padStart(2)}%  ` +
        `blank(<=2)=${(c.pBlank * 100).toFixed(0).padStart(2)}%`,
    );
  }

  console.log(
    `\nEP(GW) is this gameweek, EP(H) the whole ${horizon}-week horizon. ` +
      `CS = clean sheet.\n25/26 = last season's workload, which is the only ` +
      `evidence that a player starts.\n`,
  );
  process.exit(0);
}

void main();
