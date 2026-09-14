import {
  CAPTAIN_MULTIPLIER,
  CHIP,
  FORMATION_BOUNDS,
  POSITION,
  STARTING_XI_SIZE,
  TRIPLE_CAPTAIN_MULTIPLIER,
  type PositionId,
} from "@/lib/rules";

/**
 * How a finished gameweek actually scores a squad.
 *
 * Pure. `lib/squad/live.ts` answers "what is it scoring right now" and
 * deliberately skips substitutions, because they resolve only once every match
 * is over. This is the other half: the final number, after they have.
 */

export interface SubPlayer {
  position: PositionId;
  /** Appeared in at least one fixture this gameweek. A blank counts as no. */
  played: boolean;
}

/**
 * FPL's real rule, not an optimisation.
 *
 * Bench players replace non-playing starters in BENCH ORDER, and only where the
 * formation stays legal; the reserve keeper only ever covers the keeper. This
 * is modelled properly rather than approximated because it is the mechanism
 * that pays for risk — a policy that buys volatile starters is protected by its
 * bench, and scoring without auto-subs would punish exactly that behaviour.
 */
export function applyAutoSubs<T extends SubPlayer>(starting: T[], bench: T[]): T[] {
  const xi = [...starting];
  const available = [...bench];

  const countsOf = (team: T[]) => {
    const counts = new Map<PositionId, number>();
    for (const p of team) counts.set(p.position, (counts.get(p.position) ?? 0) + 1);
    return counts;
  };

  for (let i = 0; i < xi.length; i++) {
    if (xi[i].played) continue;

    const out = xi[i];
    for (let b = 0; b < available.length; b++) {
      const sub = available[b];
      if (!sub.played) continue;

      // A keeper can only be replaced by a keeper, and vice versa.
      const keeperInvolved =
        out.position === POSITION.GK || sub.position === POSITION.GK;
      if (keeperInvolved && out.position !== sub.position) continue;

      const trial = [...xi];
      trial[i] = sub;
      const counts = countsOf(trial);
      const legal = ([...Object.values(POSITION)] as PositionId[]).every((pos) => {
        const n = counts.get(pos) ?? 0;
        return n >= FORMATION_BOUNDS[pos].min && n <= FORMATION_BOUNDS[pos].max;
      });
      if (!legal) continue;

      xi[i] = sub;
      available.splice(b, 1);
      break;
    }
  }
  return xi;
}

export interface FinalPick extends SubPlayer {
  playerId: number;
  /** 1-11 start, 12-15 bench in substitution order. */
  slot: number;
  isCaptain: boolean;
  isVice: boolean;
  /** Points for the gameweek before any multiplier. */
  points: number;
}

export interface FinalScore {
  /** Points as FPL counts them, before any transfer hit. */
  total: number;
  /** Who ended up wearing the armband, or null if neither captain played. */
  armband: number | null;
  /** Bench players who came on. */
  autoSubs: number;
}

/**
 * The final score of a squad for a finished gameweek.
 *
 * Three rules beyond the substitutions, each a place a plausible total goes
 * wrong:
 *
 *   * The armband passes to the vice-captain only if the captain did not play,
 *     and to nobody if the vice did not play either. It never moves to a
 *     substitute. (The squad backtest ignores the vice; it has no picks to
 *     honour, only a policy.)
 *   * Bench Boost counts all fifteen, so there is nobody to substitute.
 *   * Triple Captain triples rather than doubles, and still follows the vice
 *     rule.
 */
export function scoreFinalGameweek(
  picks: FinalPick[],
  chip: string | null,
): FinalScore {
  const ordered = [...picks].sort((a, b) => a.slot - b.slot);
  const starting = ordered.filter((p) => p.slot <= STARTING_XI_SIZE);
  const bench = ordered.filter((p) => p.slot > STARTING_XI_SIZE);

  const benchBoost = chip === CHIP.benchBoost;
  const counted = benchBoost ? ordered : applyAutoSubs(starting, bench);
  const autoSubs = benchBoost
    ? 0
    : counted.filter((p, i) => p !== starting[i]).length;

  const inCount = (p: FinalPick | undefined) =>
    p !== undefined && p.played && counted.includes(p);
  const captain = ordered.find((p) => p.isCaptain);
  const vice = ordered.find((p) => p.isVice);
  const armband = inCount(captain) ? captain! : inCount(vice) ? vice! : null;

  const multiplier =
    chip === CHIP.tripleCaptain ? TRIPLE_CAPTAIN_MULTIPLIER : CAPTAIN_MULTIPLIER;
  const base = counted.reduce((sum, p) => sum + p.points, 0);
  const total = base + (armband ? armband.points * (multiplier - 1) : 0);

  return { total, armband: armband?.playerId ?? null, autoSubs };
}
