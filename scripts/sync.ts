/**
 * Standalone sync runner.
 *
 * WHY THIS EXISTS. The cron route handlers in `app/api/cron/**` are the right
 * interface once the app is deployed, but nothing is deployed yet — and the
 * per-gameweek and price history this project is built on cannot be
 * backfilled. Waiting for a deployment means permanently losing every day of
 * data in between.
 *
 * So this runs the exact same `syncStatic` and `syncSquad` functions the routes
 * call, directly against Supabase, with no web server in the loop. GitHub
 * Actions runs it on a schedule (see .github/workflows/sync.yml).
 *
 * Once the app is deployed, either keep this or point the workflow at the
 * routes instead — both paths call the same code, so they cannot drift.
 *
 * Usage:
 *   npm run sync           both jobs
 *   npm run sync -- static only the reference data
 *   npm run sync -- squad  only the squad
 */

import { config } from "dotenv";
import { getDb, isDbConfigured } from "@/lib/db/client";
import { syncStatic } from "@/lib/db/sync";
import { syncSquad } from "@/lib/db/sync-squad";

config({ path: ".env.local", quiet: true });
config({ quiet: true });

function log(message: string, data?: unknown) {
  const stamp = new Date().toISOString();
  if (data === undefined) console.log(`[${stamp}] ${message}`);
  else console.log(`[${stamp}] ${message}`, JSON.stringify(data));
}

async function main() {
  const which = process.argv[2] ?? "all";

  if (!isDbConfigured()) {
    console.error(
      "Supabase is not configured. Needs NEXT_PUBLIC_SUPABASE_URL and " +
        "SUPABASE_SERVICE_ROLE_KEY in the environment or .env.local.",
    );
    process.exit(1);
  }

  const db = getDb();
  let failed = false;

  if (which === "all" || which === "static") {
    try {
      const started = Date.now();
      const result = await syncStatic(db);
      log(`sync-static ok in ${Date.now() - started}ms`, result);
    } catch (error) {
      failed = true;
      log(`sync-static FAILED: ${(error as Error).message}`);
    }
  }

  if (which === "all" || which === "squad") {
    const teamId = Number(process.env.FPL_TEAM_ID);
    if (!Number.isInteger(teamId) || teamId <= 0) {
      log("sync-squad skipped: FPL_TEAM_ID is not set");
    } else {
      try {
        const started = Date.now();
        const result = await syncSquad(db, teamId);
        log(`sync-squad ${result.status} in ${Date.now() - started}ms`, result);
      } catch (error) {
        failed = true;
        log(`sync-squad FAILED: ${(error as Error).message}`);
      }
    }
  }

  // A non-zero exit is what makes GitHub email you about a broken sync.
  // `no-picks-yet` is NOT a failure — it is the expected pre-season state, and
  // failing on it would cry wolf every morning until the first deadline.
  process.exit(failed ? 1 : 0);
}

void main();
