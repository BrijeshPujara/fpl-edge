/**
 * Whose squad the app is looking at.
 *
 * Pure, and deliberately a single function rather than two inline reads of
 * `process.env.FPL_TEAM_ID`. This is the seam: today the answer comes from the
 * environment because the app serves one manager, and when it serves many the
 * answer comes from the route instead. One place changes, and every caller
 * already asks the question the right way round.
 *
 * An FPL entry id is the number in the My Team URL. It is **public data, not a
 * credential** — `entry/{id}/` is an unauthenticated endpoint that the FPL site
 * itself reads for every mini-league table. Nothing here needs protecting; it
 * needs validating, which is a different job.
 */

/** The largest plausible entry id, well above the ~11m registered each season. */
const MAX_ENTRY_ID = 100_000_000;

/**
 * Validate an entry id from any source — an environment variable today, a URL
 * segment tomorrow.
 *
 * Returns null rather than throwing or coercing. `Number("")` is 0 and
 * `Number("12abc")` is NaN, and both would otherwise reach the FPL API as a
 * request for entry 0 or entry NaN. A caller that gets null can say "that is
 * not a team id" instead of asking someone else's server the question.
 */
export function parseEntryId(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;

  const text = String(value).trim();
  // Digits only. Rejects "12abc", "1e5", "-4", " 12 34" and the empty string,
  // all of which Number() would otherwise accept or silently mangle.
  if (!/^\d+$/.test(text)) return null;

  const id = Number(text);
  if (!Number.isSafeInteger(id) || id <= 0 || id > MAX_ENTRY_ID) return null;

  return id;
}

/**
 * The entry id this deployment serves, from the environment.
 *
 * Null when unset or malformed, which is a normal state — the app renders
 * league-wide data perfectly well without knowing whose team it is, and every
 * squad-dependent screen already handles having no squad.
 */
export function resolveEntryId(): number | null {
  return parseEntryId(process.env.FPL_TEAM_ID);
}
