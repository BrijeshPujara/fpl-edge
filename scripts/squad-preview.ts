/**
 * Renders the squad view from REAL database rows using a synthetic pick list.
 *
 * Picks do not exist publicly until a deadline passes, so this is the only way
 * to exercise the full read path — queries, view assembly, fixture strips, EP —
 * before Friday. Nothing is written to the database.
 */
import { config } from "dotenv";
import { getDb } from "@/lib/db/client";
import { getFixturesFrom, getTeams } from "@/lib/db/queries";
import { buildSquadView, type PlayerLike } from "@/lib/squad/view";
import { POSITION, POSITION_SHORT, type PositionId } from "@/lib/rules";
import { money, ep as fmtEp } from "@/lib/format";

config({ path: ".env.local", quiet: true });

async function main() {
  const db = getDb();
  const [teams, fixtures] = await Promise.all([getTeams(db), getFixturesFrom(db, 1, 7)]);

  const { data: rows } = await db
    .from("players")
    .select("id, web_name, team_id, position, now_cost, status, chance_of_playing_next_round, news")
    .eq("status", "a")
    .order("now_cost", { ascending: false });
  if (!rows) throw new Error("no players");

  // A legal 4-4-2 plus bench: most expensive available per position, capped at
  // three per club so the shape is realistic.
  // Select one at a time. Filtering with a side effect would consume the club
  // quota on every candidate scanned, not just the ones actually taken.
  const perClub = new Map<number, number>();
  const chosen = new Set<number>();
  const take = (pos: PositionId, count: number) => {
    const out: typeof rows = [];
    for (const r of rows) {
      if (out.length >= count) break;
      if (r.position !== pos || chosen.has(r.id)) continue;
      const used = perClub.get(r.team_id) ?? 0;
      if (used >= 3) continue;
      perClub.set(r.team_id, used + 1);
      chosen.add(r.id);
      out.push(r);
    }
    return out;
  };

  const starters = [
    ...take(POSITION.GK, 1),
    ...take(POSITION.DEF, 4),
    ...take(POSITION.MID, 4),
    ...take(POSITION.FWD, 2),
  ];
  const bench = [
    ...take(POSITION.GK, 1),
    ...take(POSITION.DEF, 1),
    ...take(POSITION.MID, 1),
    ...take(POSITION.FWD, 1),
  ];
  const squad = [...starters, ...bench];

  const picks = squad.map((p, i) => ({
    player_id: p.id,
    position: i + 1,
    is_captain: i === 9,
    is_vice: i === 10,
  }));

  const view = buildSquadView({
    gw: 1,
    picks,
    players: squad as PlayerLike[],
    teams,
    fixtures,
    stats: [],
  });

  console.log(`\nSQUAD · ${view.formation} · GW${view.gw}   (synthetic picks, real data)`);
  console.log(`preSeason=${view.preSeason}\n`);

  for (const row of view.rows) {
    console.log(`${row.label}`);
    for (const p of row.players) {
      const strip = p.fixtures
        .map((f) => `${f.isHome ? f.opponent : f.opponent.toLowerCase()}(${f.difficulty})`)
        .join(" ");
      console.log(
        `  ${p.name.padEnd(15)} ${p.club.padEnd(4)} ${money(p.price).padStart(6)} ` +
        `ep=${p.epIsProjectable ? fmtEp(p.ep).padStart(4) : "   —"} ` +
        `${p.isCaptain ? "(C) " : p.isVice ? "(V) " : "    "}${strip}`,
      );
    }
  }
  console.log(`\nBENCH`);
  for (const p of view.bench) {
    console.log(`  ${p.name.padEnd(15)} ${p.club.padEnd(4)} ${money(p.price).padStart(6)} ${POSITION_SHORT[p.position]}`);
  }

  const t = view.totals;
  console.log(`\nTOTALS`);
  console.log(`  squad value            ${money(t.squadValue)}`);
  console.log(`  mean fixture difficulty ${t.meanDifficulty?.toFixed(2) ?? "—"}`);
  console.log(`  flagged                ${t.flaggedCount}`);
  console.log(`  strips populated       ${view.rows.flatMap(r=>r.players).filter(p=>p.fixtures.length===5).length}/11 with a full 5`);
  process.exit(0);
}

void main();
