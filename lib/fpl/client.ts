import "server-only";

import type { z } from "zod";
import {
  bootstrapStaticSchema,
  elementSummarySchema,
  entryHistorySchema,
  entryTransfersSchema,
  entryPicksSchema,
  entrySchema,
  eventLiveSchema,
  fixturesSchema,
  leagueStandingsSchema,
} from "./schemas";

/**
 * Client for the official, unauthenticated FPL API.
 *
 * Two hard constraints drive the shape of this file:
 *
 *  1. The API is CORS-blocked in the browser. Every call must happen
 *     server-side. The `server-only` import above turns a mistaken client
 *     import into a build error rather than a runtime one.
 *  2. The API rejects some default fetch user-agents with a 403. We send a
 *     normal browser UA.
 */

const BASE_URL = "https://fantasy.premierleague.com/api";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 400;

export class FplApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number | null,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "FplApiError";
  }
}

export class FplSchemaError extends Error {
  constructor(
    readonly path: string,
    readonly issues: z.core.$ZodIssue[],
  ) {
    const summary = issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    super(
      `FPL API response for ${path} did not match the expected shape. ` +
        `${issues.length} issue(s): ${summary}`,
    );
    this.name = "FplSchemaError";
  }
}

export interface FetchOptions {
  /**
   * Seconds to cache the response for. Next's data cache handles this; the
   * defaults per endpoint reflect how often the upstream data actually moves.
   */
  revalidate?: number;
  signal?: AbortSignal;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch and validate one endpoint.
 *
 * Retries only on network failures and 5xx — a 404 (a team's picks before the
 * deadline, say) is a legitimate answer and is surfaced immediately so callers
 * can handle it.
 */
async function fetchAndParse<T>(
  path: string,
  schema: z.ZodType<T>,
  options: FetchOptions = {},
): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const { revalidate = 3600, signal } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;

    try {
      response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
        next: { revalidate },
        signal,
      });
    } catch (error) {
      lastError = error;
      if (attempt === MAX_ATTEMPTS) break;
      await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
      continue;
    }

    if (!response.ok) {
      // 4xx is the server telling us something true. Don't retry it.
      if (response.status < 500) {
        throw new FplApiError(
          path,
          response.status,
          `FPL API returned ${response.status} for ${path}`,
        );
      }
      lastError = new FplApiError(
        path,
        response.status,
        `FPL API returned ${response.status} for ${path}`,
      );
      if (attempt === MAX_ATTEMPTS) break;
      await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
      continue;
    }

    // Anything past this point is a shape problem, not a transport problem,
    // and retrying will not help.
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new FplApiError(
        path,
        response.status,
        `FPL API returned a non-JSON body for ${path}`,
        error,
      );
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new FplSchemaError(path, parsed.error.issues);
    }

    return parsed.data;
  }

  throw new FplApiError(
    path,
    lastError instanceof FplApiError ? lastError.status : null,
    `FPL API request to ${path} failed after ${MAX_ATTEMPTS} attempts`,
    lastError,
  );
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/**
 * Everything static: players, teams, gameweeks, chip windows.
 * This is the single source of truth for "what gameweek is it".
 */
export function getBootstrapStatic(options?: FetchOptions) {
  return fetchAndParse("/bootstrap-static/", bootstrapStaticSchema, {
    revalidate: 900,
    ...options,
  });
}

export function getFixtures(options?: FetchOptions) {
  return fetchAndParse("/fixtures/", fixturesSchema, {
    revalidate: 3600,
    ...options,
  });
}

/**
 * Every player's stats for one gameweek in a single response. This is how to
 * build history — 38 calls for a season, versus ~700 to element-summary.
 */
export function getEventLive(gw: number, options?: FetchOptions) {
  return fetchAndParse(`/event/${gw}/live/`, eventLiveSchema, {
    revalidate: 300,
    ...options,
  });
}

/** Per-player history and upcoming fixtures. Use for player detail views only. */
export function getElementSummary(playerId: number, options?: FetchOptions) {
  return fetchAndParse(
    `/element-summary/${playerId}/`,
    elementSummarySchema,
    { revalidate: 3600, ...options },
  );
}

export function getEntry(teamId: number, options?: FetchOptions) {
  return fetchAndParse(`/entry/${teamId}/`, entrySchema, {
    revalidate: 3600,
    ...options,
  });
}

/**
 * A manager's squad for a given gameweek.
 *
 * Returns 404 until that gameweek's deadline has passed — picks do not exist
 * publicly beforehand. Callers building a pre-deadline view must handle the
 * absence; see `getEntryPicksIfAvailable`.
 */
export function getEntryPicks(
  teamId: number,
  gw: number,
  options?: FetchOptions,
) {
  return fetchAndParse(
    `/entry/${teamId}/event/${gw}/picks/`,
    entryPicksSchema,
    { revalidate: 900, ...options },
  );
}

/**
 * As `getEntryPicks`, but resolves to null instead of throwing when the
 * gameweek's deadline has not passed. Before GW1 this is the expected state,
 * not an error.
 */
export async function getEntryPicksIfAvailable(
  teamId: number,
  gw: number,
  options?: FetchOptions,
) {
  try {
    return await getEntryPicks(teamId, gw, options);
  } catch (error) {
    if (error instanceof FplApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * Every transfer a manager has made this season, newest first.
 *
 * Not stored by the sync and deliberately read live: it is only ever needed to
 * score advice after the fact, and a snapshot of it would be one more thing to
 * keep in step with a source that never changes retrospectively.
 */
export function getEntryTransfers(teamId: number, options?: FetchOptions) {
  return fetchAndParse(`/entry/${teamId}/transfers/`, entryTransfersSchema, {
    revalidate: 900,
    ...options,
  });
}

export function getEntryHistory(teamId: number, options?: FetchOptions) {
  return fetchAndParse(`/entry/${teamId}/history/`, entryHistorySchema, {
    revalidate: 3600,
    ...options,
  });
}

export function getLeagueStandings(
  leagueId: number,
  page = 1,
  options?: FetchOptions,
) {
  return fetchAndParse(
    `/leagues-classic/${leagueId}/standings/?page_standings=${page}`,
    leagueStandingsSchema,
    { revalidate: 3600, ...options },
  );
}
