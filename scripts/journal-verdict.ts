/**
 * The journal's verdict: is the engine beating the manager?
 *
 * Prints every recorded decision beside what the manager actually did that
 * gameweek, and the running difference. This is the number "am I getting any
 * benefit from this" was always asking for, and the one the `outcomes` table
 * could not produce — it scores against hindsight, which a perfect model also
 * loses to.
 *
 * Reads only. Nothing here writes to the journal.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { getDb } from "@/lib/db/client";
import { getEntryTransfers } from "@/lib/fpl/client";
import { resolveEntryId } from "@/lib/fpl/entry";
import {
  compareJournal,
  loadManagerActions,
} from "@/lib/db/journal-comparison";

async function main() {
  const entryId = resolveEntryId();
  if (entryId === null) {
    console.error("Set FPL_ENTRY_ID in .env.local");
    process.exit(1);
  }

  const db = getDb();
  const transfers = await getEntryTransfers(entryId).catch(() => []);
  const actions = await loadManagerActions(db, entryId, transfers);
  const verdict = await compareJournal(db, entryId, actions);

  const { data: players } = await db.from("players").select("id, web_name");
  const name = new Map((players ?? []).map((p) => [p.id, p.web_name]));
  const label = (id: number | undefined) =>
    id === undefined || id === -1 ? "—" : (name.get(id) ?? `#${id}`);

  console.log(`\nJOURNAL VERDICT — entry ${entryId}`);
  console.log("Engine advice vs what you actually did, same gameweek.\n");

  console.log("gw  kind      engine                manager               delta  note");
  for (const c of verdict.comparisons) {
    const engine = c.engineChoice
      ? `${label(c.engineChoice.playerId).padEnd(14)} ${c.engineChoice.points.toFixed(0).padStart(4)}`
      : "—".padEnd(19);
    const manager = c.managerChoice
      ? `${label(c.managerChoice.playerId).padEnd(14)} ${c.managerChoice.points.toFixed(0).padStart(4)}`
      : "—".padEnd(19);
    const delta =
      c.delta === null
        ? "   —"
        : `${c.delta > 0 ? "+" : ""}${c.delta.toFixed(0)}`.padStart(6);
    console.log(
      `${String(c.gw).padStart(2)}  ${c.kind.padEnd(9)} ${engine}  ${manager}  ${delta}  ${c.note ?? ""}`,
    );
  }

  console.log(
    `\n${verdict.scored} scoreable decision${verdict.scored === 1 ? "" : "s"}, ` +
    `${verdict.agreed} where the engine agreed with you.`,
  );

  if (verdict.scored === 0) {
    console.log("Nothing to judge yet.");
    return;
  }

  const mean = verdict.net / verdict.scored;
  console.log(
    `NET: ${verdict.net > 0 ? "+" : ""}${verdict.net} points ` +
    `(${mean > 0 ? "+" : ""}${mean.toFixed(2)} per decision)`,
  );

  /*
   * The error bar, printed every time and never optional.
   *
   * One captain call swings ten points, so a handful of decisions cannot
   * separate an edge from a run of luck. Quoting the net without this is how a
   * tool gets trusted, or abandoned, for a difference it has not shown.
   */
  if (verdict.standardError !== null) {
    const t = mean / verdict.standardError;
    console.log(
      `standard error ${verdict.standardError.toFixed(2)} per decision, t=${t.toFixed(2)} — ` +
      (Math.abs(t) < 2
        ? "INSIDE THE NOISE. Not yet evidence either way."
        : t > 0
          ? "the engine is ahead by more than its error bar."
          : "the engine is behind by more than its error bar."),
    );
    const needed = Math.ceil((2 * verdict.standardError / Math.abs(mean || 1)) ** 2 * verdict.scored);
    if (Math.abs(t) < 2 && Number.isFinite(needed)) {
      console.log(
        `At this effect size it would take roughly ${needed} scoreable decisions to settle.`,
      );
    }
  } else {
    console.log("Too few decisions for an error bar.");
  }
}

main();
