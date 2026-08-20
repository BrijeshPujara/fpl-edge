/**
 * Where the remembered team id lives.
 *
 * Its own module because a `"use server"` file may only export async functions,
 * so a constant cannot sit alongside the actions that use it.
 *
 * `httpOnly` even though the value is public. It is not protecting a secret —
 * an FPL entry id is readable by anyone — it is keeping the only piece of state
 * the app owns out of reach of any script that ends up on the page.
 */
export const ENTRY_COOKIE = "fpl_entry";

/** A year. The cookie is a convenience, not a session. */
export const ENTRY_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export interface UseTeamState {
  error: string | null;
}
