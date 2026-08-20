/**
 * Which rows of a league table to actually show.
 *
 * Pure, and separated from the component because it is the only part of a
 * standings table with a decision in it. Everything else is markup.
 *
 * The decision: a mini-league can have hundreds of managers, and the single
 * question anyone opens the table to answer is "where am I". Showing the top
 * ten and leaving someone to scroll past forty strangers to find themselves is
 * a bad answer, so their own row is pinned underneath when it falls below the
 * cut.
 */

export interface StandingLike {
  entry: number;
  rank: number;
  last_rank: number;
}

export interface VisibleStandings<T extends StandingLike> {
  /** The head of the table. */
  top: T[];
  /**
   * The manager's own row, when it is not already in `top`. Null when they are
   * visible anyway, or not in this league at all.
   */
  pinned: T | null;
  /** True when a gap should be drawn between the two. */
  showGap: boolean;
}

export function visibleStandings<T extends StandingLike>(
  rows: T[],
  entryId: number,
  limit: number,
): VisibleStandings<T> {
  const top = rows.slice(0, limit);
  const alreadyVisible = top.some((row) => row.entry === entryId);
  const own = rows.find((row) => row.entry === entryId) ?? null;

  return {
    top,
    pinned: alreadyVisible ? null : own,
    // Only when there is something between the two. A manager sitting at
    // exactly limit + 1 needs no ellipsis; nothing was skipped.
    showGap: !alreadyVisible && own !== null && own.rank > limit + 1,
  };
}

/**
 * Places gained since the previous gameweek, or null when the question does
 * not apply.
 *
 * `last_rank` is 0 in the first scored gameweek: there was no previous
 * position. Subtracting from zero would report a spectacular rise for everyone
 * in the league, which is the sort of number that looks like a feature.
 */
export function rankMovement(rank: number, lastRank: number): number | null {
  if (rank <= 0 || lastRank <= 0) return null;
  return lastRank - rank;
}
