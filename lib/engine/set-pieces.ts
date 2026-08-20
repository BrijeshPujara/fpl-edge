import {
  ASSIST_POINTS,
  GOAL_POINTS,
  PENALTY_MISS_POINTS,
  type PositionId,
} from "@/lib/rules";
import {
  PENALTIES_PER_TEAM_PER_MATCH,
  PENALTY_CONVERSION,
  PENALTY_TAKER_SHARE,
  SET_PIECE_CREDIT_APPEARANCES,
  SET_PIECE_DELIVERIES_PER_TEAM_PER_MATCH,
  SET_PIECE_DELIVERY_ASSIST_RATE,
  SET_PIECE_TAKER_SHARE,
} from "./constants";

/**
 * Set-piece and penalty duty.
 *
 * `bootstrap-static.elements[]` reports who takes what, as an ordering per club:
 * `penalties_order` 1 is the designated taker, 2 the deputy, and null means no
 * listed duty. This is a hard, immediate signal — a penalty taker at a mid-table
 * club outscores a better forward who does not take them — and unlike form it
 * needs no history to warm up.
 *
 * The whole difficulty is DOUBLE COUNTING. Opta xG includes penalties, and
 * expected assists include set-piece deliveries, so both are already inside the
 * observed rates for any player with a reasonable appearance history. See
 * SET_PIECE_CREDIT_APPEARANCES: the duty term is a prior that fills the gap
 * where observation is thin, and decays to nothing once it is not.
 */

export interface SetPieceDuty {
  /** 1 = designated penalty taker for the club. Null = no listed duty. */
  penaltiesOrder: number | null;
  /** Corners and indirect free kicks are one duty, reported as one order. */
  cornersOrder: number | null;
  /**
   * Stored from the API and deliberately not modelled. Direct free kicks are
   * scored by the taker rather than assisted, at a rate low enough (~5% of
   * shootable positions, a handful of which arise per match) that the term
   * would be smaller than the noise in the other two. Synced so it is there
   * when there is data to calibrate it against.
   */
  directFreekicksOrder: number | null;
}

/** No duty at all — the answer for the ~85% of players with no listed order. */
export const NO_SET_PIECE_DUTY: SetPieceDuty = {
  penaltiesOrder: null,
  cornersOrder: null,
  directFreekicksOrder: null,
};

/**
 * Share of a club's set pieces taken by the nth name, given he is on the pitch.
 *
 * Orders beyond the table's length contribute nothing: a fourth-choice penalty
 * taker takes penalties in the sense that a third-choice goalkeeper keeps goal.
 */
export function takerShare(
  order: number | null,
  shares: readonly number[],
): number {
  if (order === null || order < 1) return 0;
  return shares[order - 1] ?? 0;
}

/**
 * Weight on the duty prior, from the number of appearances behind the player.
 *
 * Decays linearly from 1 with no history to 0 at SET_PIECE_CREDIT_APPEARANCES.
 * This is not a confidence measure — it is the correction that stops duty being
 * counted twice, once through the flag and once through the observed xG that
 * already contains it.
 */
export function setPieceCredit(appearances: number): number {
  if (appearances <= 0) return 1;
  if (appearances >= SET_PIECE_CREDIT_APPEARANCES) return 0;
  return 1 - appearances / SET_PIECE_CREDIT_APPEARANCES;
}

/**
 * Expected points per 90 from penalty duty, before minutes and credit scaling.
 *
 * A converted penalty pays the position's goal points; a missed one costs two.
 * Both are counted, which is why an out-and-out taker is worth less than
 * conversion x goal points would suggest.
 */
export function penaltyPointsPer90(
  duty: SetPieceDuty,
  position: PositionId,
): number {
  const share = takerShare(duty.penaltiesOrder, PENALTY_TAKER_SHARE);
  if (share === 0) return 0;

  const perPenalty =
    PENALTY_CONVERSION * GOAL_POINTS[position] +
    (1 - PENALTY_CONVERSION) * PENALTY_MISS_POINTS;

  return PENALTIES_PER_TEAM_PER_MATCH * share * perPenalty;
}

/** Expected assists per 90 from corner and indirect free-kick duty. */
export function setPieceAssistsPer90(duty: SetPieceDuty): number {
  const share = takerShare(duty.cornersOrder, SET_PIECE_TAKER_SHARE);
  if (share === 0) return 0;
  return (
    SET_PIECE_DELIVERIES_PER_TEAM_PER_MATCH *
    share *
    SET_PIECE_DELIVERY_ASSIST_RATE
  );
}

/** Total per-90 points from both modelled duties. */
export function setPiecePointsPer90(
  duty: SetPieceDuty,
  position: PositionId,
): number {
  return (
    penaltyPointsPer90(duty, position) +
    setPieceAssistsPer90(duty) * ASSIST_POINTS
  );
}
