import type { Move } from "@/lib/db/decisions";
import type { ChipWindow } from "@/lib/fpl/gameweek";
import { toPlayerCandidate, type Candidate } from "@/lib/squad/candidates";
import { bestXi } from "@/lib/engine/best-xi";
import { rankCaptains } from "@/lib/engine/captain";
import { computeChipGains } from "@/lib/engine/chip-gains";
import { planChips } from "@/lib/engine/chips";
import type { LpSolver } from "@/lib/engine/lp";
import { optimiseSquad } from "@/lib/engine/optimiser";
import { sellingPrice } from "@/lib/engine/selling-price";
import { suggestTransfers } from "@/lib/engine/transfers";
import {
  CAPTAIN_MULTIPLIER,
  CHIP,
  POSITION,
  STARTING_XI_SIZE,
  TRIPLE_CAPTAIN_MULTIPLIER,
  type ChipName,
  type PositionId,
} from "@/lib/rules";

/**
 * One gameweek of the shadow manager.
 *
 * The shadow does what the engine advises and nothing else, under the rules a
 * real manager plays by. Every decision here is delegated to the engine piece
 * that already makes it for the screens — the chip planner, the transfer
 * suggester, the best eleven, the captain ranking — so the shadow cannot
 * quietly become a better or worse manager than the advice it is meant to
 * measure. What this file adds is only the bookkeeping a real squad carries
 * and the screens never needed: purchase prices, selling prices, and a bank
 * that moves.
 *
 * No I/O. The solver is passed in.
 */

export interface ShadowHolding {
  playerId: number;
  /** What was paid, in tenths. Selling price is derived from it. */
  purchasePrice: number;
}

export interface ShadowPick extends ShadowHolding {
  /** 1-11 start, 12-15 bench in substitution order. */
  slot: number;
  isCaptain: boolean;
  isVice: boolean;
}

export interface PlannedWeek {
  gw: number;
  chip: ChipName | null;
  picks: ShadowPick[];
  moves: Move[];
  hitCost: number;
  /** Tenths, after this week's moves. */
  bank: number;
  /** This gameweek's projected points for the eleven, armband and chip applied. */
  projectedEp: number;
}

/**
 * The week a gameweek is planned FROM: the latest earlier week that was not a
 * Free Hit.
 *
 * A Free Hit squad lasts one gameweek and then reverts, bank included. Planning
 * the following week from the Free Hit squad would keep a fifteen the rules
 * take away, which is the single most flattering mistake available here.
 */
export function baseWeekFor<T extends { gw: number; chip: string | null }>(
  weeks: T[],
  gw: number,
): T | null {
  return (
    [...weeks]
      .filter((w) => w.gw < gw && w.chip !== CHIP.freeHit)
      .sort((a, b) => b.gw - a.gw)[0] ?? null
  );
}

/**
 * Apply a new fifteen to the holdings: who was sold, who was bought, and what
 * the bank is left with.
 *
 * Sales realise the SELLING price; purchases cost the current price and become
 * the new purchase price. Throws on overspend — the optimiser is budgeted from
 * the same numbers, so a negative bank means the two disagree, and a squad the
 * rules forbid must never be recorded as if it were legal.
 */
export function settleSquad(input: {
  holdings: ShadowHolding[];
  bank: number;
  fifteen: number[];
  currentPrice: (playerId: number) => number;
}): { holdings: ShadowHolding[]; moves: Move[]; bank: number } {
  const owned = new Map(input.holdings.map((h) => [h.playerId, h]));
  const keep = new Set(input.fifteen);

  const sold = input.holdings.filter((h) => !keep.has(h.playerId));
  const bought = input.fifteen.filter((id) => !owned.has(id));
  if (sold.length !== bought.length) {
    throw new Error(
      `Shadow squad would sell ${sold.length} and buy ${bought.length}; a squad is always fifteen`,
    );
  }

  const proceeds = sold.reduce(
    (sum, h) => sum + sellingPrice(h.purchasePrice, input.currentPrice(h.playerId)),
    0,
  );
  const cost = bought.reduce((sum, id) => sum + input.currentPrice(id), 0);
  const bank = input.bank + proceeds - cost;
  if (bank < 0) {
    throw new Error(`Shadow squad overspends by ${-bank} tenths`);
  }

  return {
    holdings: input.fifteen.map(
      (id) => owned.get(id) ?? { playerId: id, purchasePrice: input.currentPrice(id) },
    ),
    // Paired by index, which is arbitrary for several moves — every score is a
    // sum over the pairs, so the pairing never changes a number.
    moves: bought.map((id, i) => ({ in: id, out: sold[i].playerId })),
    bank,
  };
}

/**
 * Order a fifteen into slots: eleven starters, then the bench.
 *
 * FPL fixes the reserve keeper to the first bench slot; the outfielders follow
 * in the order you would want them to come on, highest projection first.
 */
export function lineUp<T extends { id: number; position: PositionId; ep: number }>(
  squad: T[],
): { starting: T[]; bench: T[] } {
  const xi = bestXi(squad);
  const bench = [...xi.bench].sort((a, b) => {
    if (a.position === POSITION.GK) return -1;
    if (b.position === POSITION.GK) return 1;
    return b.ep - a.ep;
  });
  return { starting: xi.starting, bench };
}

/** The chip the engine's plan assigns to this gameweek, if any. */
export function chooseShadowChip(input: {
  gw: number;
  holdings: ShadowHolding[];
  bank: number;
  /** Candidates scanned over the chip horizon. */
  pool: Candidate[];
  gameweeks: number[];
  windows: ChipWindow[];
  played: { chip: ChipName; set: number }[];
  priceDeltas: Map<number, number>;
  solver: LpSolver;
}): ChipName | null {
  const byId = new Map(input.pool.map((c) => [c.id, c]));
  const priceOf = (id: number) => input.priceDeltas.get(id) ?? 0;
  const withGameweeks = (c: Candidate, price = c.price) => ({
    ...toPlayerCandidate(c, priceOf(c.id)),
    price,
    epByGameweek: new Map(c.perGameweek.map((g) => [g.gw, g.ep])),
  });

  const squad = input.holdings.map((h) => {
    const c = holdingCandidate(byId, h);
    return withGameweeks(c, sellingPrice(h.purchasePrice, c.price));
  });

  // Built exactly as the chips screen builds it (components/chips/advisories),
  // with the shadow's own squad and its selling value in place of the
  // manager's. The advice the shadow follows is the advice that screen gives.
  const gains = computeChipGains({
    squad,
    pool: input.pool.map((c) => withGameweeks(c)),
    gameweeks: input.gameweeks,
    budget: squad.reduce((sum, p) => sum + p.price, 0) + input.bank,
    windows: input.windows,
    currentGw: input.gw,
    solver: input.solver,
  });

  const plan = planChips({
    windows: input.windows,
    gains,
    alreadyPlayed: input.played,
    currentGw: input.gw,
    solver: input.solver,
  });

  return plan.assignments.find((a) => a.gw === input.gw)?.chip ?? null;
}

/**
 * Plan one gameweek: chip, transfers, eleven, bench, armband.
 *
 * `pool` is the horizon-projected pool the transfer screen uses, so a normal
 * week makes exactly the move the journal records for a squad like this one.
 */
export function planShadowWeek(input: {
  gw: number;
  holdings: ShadowHolding[];
  bank: number;
  freeTransfers: number;
  chip: ChipName | null;
  pool: Candidate[];
  priceDeltas: Map<number, number>;
  minutesKnown: boolean;
  solver: LpSolver;
}): PlannedWeek {
  const { gw, chip, solver } = input;
  const byId = new Map(input.pool.map((c) => [c.id, c]));
  const priceOf = (id: number) => input.priceDeltas.get(id) ?? 0;
  const thisWeek = (c: Candidate) =>
    c.perGameweek.find((g) => g.gw === gw)?.ep ?? 0;

  const owned = input.holdings.map((h) => holdingCandidate(byId, h));
  const ownedIds = new Set(owned.map((c) => c.id));
  const purchaseOf = new Map(input.holdings.map((h) => [h.playerId, h.purchasePrice]));
  const sellOf = (c: Candidate) => sellingPrice(purchaseOf.get(c.id)!, c.price);
  const others = input.pool.filter((c) => !ownedIds.has(c.id));

  // Owned players are offered at what selling them would realise, so the
  // budget every solve sees is the one FPL would actually allow.
  const asOwned = (c: Candidate, ep = c.ep) => ({
    ...toPlayerCandidate(c, priceOf(c.id)),
    price: sellOf(c),
    ep,
  });
  const asBuyable = (c: Candidate, ep = c.ep) => ({
    ...toPlayerCandidate(c, priceOf(c.id)),
    ep,
  });

  let fifteen: number[];
  let hitCost = 0;

  if (chip === CHIP.wildcard || chip === CHIP.freeHit) {
    // A Free Hit squad is gone next week, so it is chosen on THIS week's
    // projection and price movement is irrelevant to it. A Wildcard squad is
    // kept, so it is chosen on the horizon like any transfer.
    const oneWeek = chip === CHIP.freeHit;
    const solved = optimiseSquad(
      [
        ...owned.map((c) => asOwned(c, oneWeek ? thisWeek(c) : c.ep)),
        ...others.map((c) => asBuyable(c, oneWeek ? thisWeek(c) : c.ep)),
      ],
      solver,
      {
        budget: owned.reduce((sum, c) => sum + sellOf(c), 0) + input.bank,
        priceWeight: oneWeek ? 0 : "auto",
      },
    );
    fifteen = [...solved.starting, ...solved.bench].map((p) => p.id);
  } else {
    const suggestion = suggestTransfers(
      {
        currentSquad: owned.map((c) => asOwned(c)),
        candidates: others.map((c) => asBuyable(c)),
        freeTransfers: input.freeTransfers,
        minutesKnown: input.minutesKnown,
        bank: input.bank,
      },
      solver,
      { priceWeight: "auto" },
    );
    const move = suggestion.recommended;
    // The journal's bar, exactly: a move that does not clear its cost is not
    // made. See sync-journal.
    const act = move.transfers > 0 && move.netGain > 0;
    const out = new Set(act ? move.playersOut.map((p) => p.id) : []);
    fifteen = [
      ...owned.map((c) => c.id).filter((id) => !out.has(id)),
      ...(act ? move.playersIn.map((p) => p.id) : []),
    ];
    hitCost = act ? move.hitCost : 0;
  }

  const settled = settleSquad({
    holdings: input.holdings,
    bank: input.bank,
    fifteen,
    currentPrice: (id) => byId.get(id)!.price,
  });

  const lined = lineUp(
    settled.holdings.map((h) => {
      const c = byId.get(h.playerId)!;
      return { id: c.id, position: c.position, ep: thisWeek(c), candidate: c, holding: h };
    }),
  );

  // Ranked over the STARTERS. A captain on the bench scores nothing, so the
  // armband is an eleven-player question.
  const ranked = rankCaptains(
    lined.starting.map((p) => ({
      playerId: p.id,
      input: p.candidate.modelInput,
      fixtures: p.candidate.thisGameweek,
    })),
  );
  const captainId = ranked[0]?.playerId ?? null;
  const viceId = ranked[1]?.playerId ?? null;

  const picks: ShadowPick[] = [...lined.starting, ...lined.bench].map((p, i) => ({
    ...p.holding,
    slot: i + 1,
    isCaptain: p.id === captainId,
    isVice: p.id === viceId,
  }));

  const multiplier =
    chip === CHIP.tripleCaptain ? TRIPLE_CAPTAIN_MULTIPLIER : CAPTAIN_MULTIPLIER;
  const startingEp = lined.starting.reduce((sum, p) => sum + p.ep, 0);
  const captainEp = lined.starting.find((p) => p.id === captainId)?.ep ?? 0;
  const benchEp =
    chip === CHIP.benchBoost
      ? lined.bench.reduce((sum, p) => sum + p.ep, 0)
      : 0;

  if (picks.filter((p) => p.slot <= STARTING_XI_SIZE).length !== STARTING_XI_SIZE) {
    throw new Error(`Shadow squad for GW${gw} cannot field a legal eleven`);
  }

  return {
    gw,
    chip,
    picks,
    moves: settled.moves,
    hitCost,
    bank: settled.bank,
    projectedEp: startingEp + captainEp * (multiplier - 1) + benchEp,
  };
}

/**
 * The pool's candidate for a held player — loudly.
 *
 * A held player missing from the pool cannot be valued. Treating him as worth
 * nothing would hand a rebuild free money or none, and either would be recorded
 * as the engine's decision.
 */
function holdingCandidate(byId: Map<number, Candidate>, holding: ShadowHolding): Candidate {
  const candidate = byId.get(holding.playerId);
  if (!candidate) {
    throw new Error(
      `Shadow squad holds player #${holding.playerId}, who is not in the candidate pool`,
    );
  }
  return candidate;
}
