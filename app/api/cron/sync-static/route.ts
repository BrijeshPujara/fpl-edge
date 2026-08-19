import { NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { getDb, isDbConfigured } from "@/lib/db/client";
import { syncStatic } from "@/lib/db/sync";

/**
 * Daily sync of FPL reference data: teams, players, fixtures, price snapshots.
 *
 * Scheduled at 00:15 UK, after the overnight price changes have settled.
 * Idempotent — running it twice is harmless, which matters because retries
 * and manual triggers both happen.
 */

// This route writes to the database and must never be cached or prerendered.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const auth = authorizeCron(request);
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.message },
      { status: auth.status },
    );
  }

  if (!isDbConfigured()) {
    return NextResponse.json(
      { error: "Supabase is not configured." },
      { status: 503 },
    );
  }

  const startedAt = Date.now();

  try {
    const result = await syncStatic(getDb());
    return NextResponse.json({
      ok: true,
      durationMs: Date.now() - startedAt,
      ...result,
    });
  } catch (error) {
    // Fail loudly and visibly. A sync that silently half-succeeds corrupts the
    // history quietly, and the history is the whole asset.
    const message = error instanceof Error ? error.message : String(error);
    console.error("[cron/sync-static] failed:", message);
    return NextResponse.json(
      { ok: false, error: message, durationMs: Date.now() - startedAt },
      { status: 500 },
    );
  }
}
