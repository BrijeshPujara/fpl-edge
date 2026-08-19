import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types.generated";

/**
 * The Supabase client.
 *
 * There is deliberately only ONE, and it is server-side.
 *
 * Every table in this schema has RLS enabled with no policies — a deliberate
 * deny-all. Nothing can read or write through the anon key, which means all
 * access goes through the service role key, which means all access happens on
 * the server. The `server-only` import turns a mistaken client import into a
 * build error rather than a leaked credential.
 *
 * If a browser ever needs to query Supabase directly, that is a decision to
 * make explicitly: add a narrow RLS policy for the specific table, and add a
 * separate browser client alongside this one. Do not widen this one.
 */

export type Db = SupabaseClient<Database>;

let cached: Db | null = null;

export class SupabaseConfigError extends Error {
  constructor(missing: string[]) {
    super(
      `Supabase is not configured. Missing: ${missing.join(", ")}. ` +
        `Copy .env.example to .env.local and fill these in.`,
    );
    this.name = "SupabaseConfigError";
  }
}

/**
 * Whether the database is configured at all.
 *
 * Screens call this before `getDb()` so an unconfigured checkout renders an
 * honest "not connected" state rather than a stack trace. The app is supposed
 * to degrade, not crash.
 */
export function isDbConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
}

export function getDb(): Db {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const missing: string[] = [];
  if (!url) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!serviceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length > 0) throw new SupabaseConfigError(missing);

  cached = createClient<Database>(url!, serviceRoleKey!, {
    auth: {
      // This client is a batch worker, not a user session. Persisting or
      // refreshing tokens for a service role key is meaningless and, in a
      // serverless runtime, actively harmful.
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return cached;
}
