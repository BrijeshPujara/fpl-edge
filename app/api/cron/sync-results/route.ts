import { NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { getDb, isDbConfigured } from "@/lib/db/client";
import { syncResults } from "@/lib/db/sync-results";

/**
 * Writes played-gameweek results into `player_gw_stats`.
 *
 * Only syncs gameweeks the API reports as both `finished` and `data_checked` —
 * bonus points and stats stay provisional until the second flag, so syncing on
 * `finished` alone would store numbers that later change.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

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

  const startedAt = Date.now();
  try {
    const result = await syncResults(getDb());
    return NextResponse.json({
      ok: true,
      durationMs: Date.now() - startedAt,
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[cron/sync-results] failed:", message);
    return NextResponse.json(
      { ok: false, error: message, durationMs: Date.now() - startedAt },
      { status: 500 },
    );
  }
}
