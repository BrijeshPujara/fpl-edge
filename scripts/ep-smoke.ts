/**
 * Sanity check: run the EP model over every player currently in the database
 * and print the ranking. Not a backtest — that needs played gameweeks — but it
 * catches the class of bug where the model compiles, passes unit tests, and
 * then ranks a fourth-choice goalkeeper above Haaland.
 */
import { config } from "dotenv";
import { getDb } from "@/lib/db/client";
import { expectedPoints, type FixtureContext } from "@/lib/engine/expected-points";
import { POSITION_SHORT, type PositionId } from "@/lib/rules";

config({ path: ".env.local", quiet: true });

async function main() {
const db = getDb();

const { data: players } = await db
  .from("players")
  // One literal, not a concatenation: supabase-js infers the row type from the
  // string itself, and a `+` defeats that and lands you in GenericStringError.
  .select("id, web_name, position, now_cost, status, chance_of_playing_next_round, team_id, penalties_order, corners_order, direct_freekicks_order");
const { data: teams } = await db.from("teams").select("id, short_name");

if (!players || !teams) throw new Error("no data");
const teamName = new Map(teams.map((t) => [t.id, t.short_name]));

// Pre-season: no history, no usable strength ratings. Everything neutral.
const neutral: FixtureContext = {
  gw: 1, isHome: true,
  teamDefence: null, opponentAttack: null,
  leagueMeanAttack: null, leagueStdAttack: null,
  opponentDefence: null, leagueMeanDefence: null, leagueStdDefence: null,
};

const scored = players.map((p) => {
  const ep = expectedPoints(
    {
      playerId: p.id,
      position: p.position as PositionId,
      teamId: p.team_id,
      minutes: {
        status: p.status,
        chanceOfPlayingNextRound: p.chance_of_playing_next_round,
        recentStarts: [],
        recentMinutes: [],
      },
      recent: [],
      priorSeason: null,
      setPieces: {
        penaltiesOrder: p.penalties_order,
        cornersOrder: p.corners_order,
        directFreekicksOrder: p.direct_freekicks_order,
      },
    },
    neutral,
  );
  return { ...p, ep: ep.total, pMin: ep.pMinutes, sp: ep.setPieces };
});

scored.sort((a, b) => b.ep - a.ep);

console.log("TOP 10 BY EP (no history, no ratings — appearance, defcon and set-piece duty only)");
for (const p of scored.slice(0, 10)) {
  console.log(
    `  ${p.web_name.padEnd(16)} ${POSITION_SHORT[p.position as PositionId]} ` +
    `${(teamName.get(p.team_id) ?? "").padEnd(4)} ` +
    `ep=${p.ep.toFixed(2)} pMin=${p.pMin.toFixed(2)} setPieces=${p.sp.toFixed(2)}`,
  );
}

const zero = scored.filter((p) => p.ep === 0);
console.log(`\nZERO EP: ${zero.length} of ${scored.length} (unavailable players)`);
console.log("STATUS BREAKDOWN OF ZEROES:",
  JSON.stringify(zero.reduce<Record<string, number>>((acc, p) => {
    acc[p.status] = (acc[p.status] ?? 0) + 1; return acc;
  }, {})));

const byPos = new Map<number, number[]>();
for (const p of scored) {
  const arr = byPos.get(p.position) ?? [];
  arr.push(p.ep);
  byPos.set(p.position, arr);
}
console.log("\nMEAN EP BY POSITION");
for (const [pos, eps] of [...byPos].sort((a, b) => a[0] - b[0])) {
  const mean = eps.reduce((a, b) => a + b, 0) / eps.length;
  console.log(`  ${POSITION_SHORT[pos as PositionId]}  n=${String(eps.length).padStart(3)}  mean=${mean.toFixed(2)}  max=${Math.max(...eps).toFixed(2)}`);
}
process.exit(0);
}

void main();
