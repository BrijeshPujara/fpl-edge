import { NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { getDb, isDbConfigured } from "@/lib/db/client";
import { syncSquad } from "@/lib/db/sync-squad";

/**
 * Daily sync of your own squad: picks, captain, bank, value, free transfers.
 *
 * Runs at 06:00, well after the overnight data settles and well before any
 * deadline. Returns 200 with `status: "no-picks-yet"` when a gameweek's
 * deadline has not passed — that is the expected state before the first
 * deadline, not a failure, and a cron job that alerts on it would cry wolf
 * every day of pre-season.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const auth = authorizeCron(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status });
  }

  if (!isDbConfigured()) {
    return NextResponse.json(
      { error: "Supabase is not configured." },
      { status: 503 },
    );
  }

  const teamId = Number(process.env.FPL_TEAM_ID);
  if (!Number.isInteger(teamId) || teamId <= 0) {
    return NextResponse.json(
      {
        error:
          "FPL_TEAM_ID is not set to a valid entry id. It is the number in " +
          "your FPL team URL, e.g. /entry/1234567/event/1.",
      },
      { status: 503 },
    );
  }

  const startedAt = Date.now();

  try {
    const result = await syncSquad(getDb(), teamId);
    return NextResponse.json({
      ok: true,
      durationMs: Date.now() - startedAt,
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[cron/sync-squad] failed:", message);
    return NextResponse.json(
      { ok: false, error: message, durationMs: Date.now() - startedAt },
      { status: 500 },
    );
  }
}
