"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb, isDbConfigured } from "@/lib/db/client";
import { registerEntry } from "@/lib/db/entries";
import { syncSquad } from "@/lib/db/sync-squad";
import { parseEntryId } from "@/lib/fpl/entry";
import {
  ENTRY_COOKIE,
  ENTRY_COOKIE_MAX_AGE,
  type UseTeamState,
} from "@/lib/entry-cookie";

/**
 * Server actions, which exist because a Server Component cannot set a cookie.
 *
 * Registering a team is also the only place the app writes on a user's behalf,
 * and it is deliberately user-initiated: doing it lazily during a render would
 * mean every stray crawler hitting `/t/12345` triggers a write and a call to
 * someone else's API.
 */

/**
 * Take a team id from the landing form, look it up, and go to its dashboard.
 *
 * Every failure is reported as a sentence a person can act on. "Invalid input"
 * is not a useful thing to tell someone who has just mistyped a seven-digit
 * number.
 */
export async function useTeam(
  _previous: UseTeamState,
  formData: FormData,
): Promise<UseTeamState> {
  const raw = String(formData.get("entryId") ?? "");
  const entryId = parseEntryId(raw);

  if (entryId === null) {
    return {
      error:
        raw.trim().length === 0
          ? "Enter your team id to continue."
          : `"${raw.trim()}" is not a team id. It is the number in your My Team URL — digits only.`,
    };
  }

  if (!isDbConfigured()) {
    return { error: "The database is not configured, so teams cannot be saved." };
  }

  const db = getDb();
  const registered = await registerEntry(db, entryId).catch(() => null);

  if (registered === null) {
    return {
      error: `FPL has no team with id ${entryId}. Check the number in your My Team URL.`,
    };
  }

  // Pull the squad now rather than on first render. It is one call, it is the
  // moment the user is expecting to wait, and it means the dashboard they land
  // on has something on it. A failure here is not fatal — the screens all
  // handle an unsynced squad, and before the first deadline there is genuinely
  // nothing to fetch.
  await syncSquad(db, entryId).catch(() => null);

  const store = await cookies();
  store.set(ENTRY_COOKIE, String(entryId), {
    maxAge: ENTRY_COOKIE_MAX_AGE,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
  });

  redirect(`/t/${entryId}`);
}

/** Forget the remembered team, so the landing page asks again. */
export async function forgetTeam(): Promise<void> {
  const store = await cookies();
  store.delete(ENTRY_COOKIE);
  redirect("/");
}

/**
 * Re-pull a manager's squad on request.
 *
 * Two reasons this is a button rather than only a cron.
 *
 * The nightly job syncs the deployment's own FPL_TEAM_ID; every other manager
 * is only ever refreshed here, when someone is actually looking at them.
 *
 * And the cron cannot be timed to a deadline. Picks appear the moment a
 * deadline passes — 18:30 on a Friday — while the squad job runs at 06:00 UTC,
 * so a squad locked on Friday evening does not arrive until Saturday morning.
 * That gap is most of a matchday, and this closes it.
 *
 * Takes FormData rather than a number so it can be a form action directly.
 */
export async function refreshSquad(formData: FormData): Promise<void> {
  const entryId = parseEntryId(String(formData.get("entryId") ?? ""));
  if (entryId === null || !isDbConfigured()) return;

  await syncSquad(getDb(), entryId).catch(() => null);
  // Revalidate rather than redirect: the user is already on the page they want
  // and a redirect would scroll them back to the top of it.
  revalidatePath(`/t/${entryId}`, "layout");
}
