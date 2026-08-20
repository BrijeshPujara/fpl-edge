import { CAPTAIN_MULTIPLIER, type ChipName } from "@/lib/rules";

/**
 * The week's decisions, ranked by what is actually at stake.
 *
 * Pure. The dashboard asks one question — *what should I do before this
 * deadline* — and the answer is at most four things: move someone, pick the
 * armband, play a chip, or do nothing. This orders them.
 *
 * The ordering key is deliberately not "how big is this number". It is HOW MUCH
 * THE DECISION IS WORTH, which is a different quantity and the one that
 * matters:
 *
 *   A captain projected at 9.0 looks like the biggest number on the screen. If
 *   the second choice is 8.8, the decision is worth 0.2 and deserves no
 *   attention at all. If the second choice is 4.0, it is worth 5.0 and is
 *   probably the most important thing you will do this week.
 *
 * Ranking on the raw projection would put the armband at the top every single
 * week, which is both useless and actively misleading.
 */

export interface TransferInput {
  transfers: number;
  playersIn: number[];
  playersOut: number[];
  epGain: number;
  hitCost: number;
  netGain: number;
}

export interface CaptainCandidate {
  playerId: number;
  /** Expected points for THIS gameweek. Captaincy is a one-week decision. */
  ep: number;
}

export interface ChipInput {
  chip: ChipName;
  set: number;
  gain: number;
  /** Margin over the best week this chip could move to instead. */
  margin: number | null;
}

export interface ActionInput {
  /** The optimiser's recommendation, or null when there is nothing to move. */
  transfer: TransferInput | null;
  /** The fifteen, scored for the gameweek being decided. */
  squadThisWeek: CaptainCandidate[];
  /** A chip the planner wants played THIS week. Null otherwise. */
  chipThisWeek: ChipInput | null;
}

export type Action =
  | ({ kind: "transfer"; impact: number } & TransferInput)
  | {
      kind: "captain";
      impact: number;
      playerId: number;
      ep: number;
      /** The armband's runner-up, and what choosing wrongly would cost. */
      runnerUpId: number | null;
      margin: number;
    }
  | ({ kind: "chip"; impact: number } & ChipInput)
  | { kind: "hold"; impact: 0 };

/**
 * The armband, and what the choice is worth.
 *
 * Worth is the gap to the second choice multiplied by the captain multiplier,
 * because picking the runner-up does not cost you the captain's whole score —
 * it costs you the difference, doubled.
 */
export function captainAction(
  squadThisWeek: CaptainCandidate[],
): Extract<Action, { kind: "captain" }> | null {
  if (squadThisWeek.length === 0) return null;

  const ranked = [...squadThisWeek].sort((a, b) => b.ep - a.ep);
  const [best, runnerUp] = ranked;
  const margin = (best.ep - (runnerUp?.ep ?? best.ep)) * CAPTAIN_MULTIPLIER;

  return {
    kind: "captain",
    impact: margin,
    playerId: best.playerId,
    ep: best.ep,
    runnerUpId: runnerUp?.playerId ?? null,
    margin,
  };
}

export function rankActions(input: ActionInput): Action[] {
  const actions: Action[] = [];

  // A transfer earns its place only if it survives its own hit. A move that
  // nets zero or less is not a recommendation, it is a temptation.
  if (input.transfer && input.transfer.transfers > 0 && input.transfer.netGain > 0) {
    actions.push({
      kind: "transfer",
      impact: input.transfer.netGain,
      ...input.transfer,
    });
  }

  const captain = captainAction(input.squadThisWeek);
  if (captain) actions.push(captain);

  if (input.chipThisWeek && input.chipThisWeek.gain > 0) {
    actions.push({
      kind: "chip",
      impact: input.chipThisWeek.gain,
      ...input.chipThisWeek,
    });
  }

  // Never return nothing. An empty panel reads as a failure to compute;
  // "hold" is a real answer and usually the right one.
  if (actions.length === 0) return [{ kind: "hold", impact: 0 }];

  return actions.sort((a, b) => b.impact - a.impact);
}
