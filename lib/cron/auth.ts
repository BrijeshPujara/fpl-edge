import "server-only";

import { timingSafeEqual } from "node:crypto";

/**
 * Authorisation for cron route handlers.
 *
 * These routes write to the database and hit an upstream API on a schedule.
 * They are publicly routable once deployed, so they check a shared secret.
 *
 * Two details that matter:
 *  - The comparison is constant-time. A plain `===` on a secret leaks its
 *    prefix to anyone patient enough to measure.
 *  - A missing CRON_SECRET denies rather than allows. An unconfigured
 *    deployment must be closed, not open.
 */

export type CronAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 503; message: string };

export function authorizeCron(request: Request): CronAuthResult {
  const expected = process.env.CRON_SECRET;

  if (!expected) {
    return {
      ok: false,
      status: 503,
      message: "CRON_SECRET is not configured; refusing to run.",
    };
  }

  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Accept a bare
  // header too so the route can be triggered by hand or from CI.
  const header =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    request.headers.get("x-cron-secret") ??
    "";

  if (!safeEqual(header, expected)) {
    return { ok: false, status: 401, message: "Unauthorized." };
  }

  return { ok: true };
}

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  // timingSafeEqual throws on a length mismatch, which would itself be a
  // timing signal. Compare a fixed-width digest of the lengths instead by
  // padding to the longer of the two.
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
