/**
 * Selection backtest — does the engine PICK well?
 *
 * `backtest.ts` answers a different question: how close are the projections to
 * what happened, per player, as a mean absolute error. That is prediction
 * accuracy, and a model can be excellent at it while still assembling a poor
 * squad — MAE is dominated by the 62% of rows that are non-appearances, and
 * nobody picks those. Nothing in this repo measured the decision itself, which
 * is why "am I getting any benefit from this" had no answer.
 *
 * This does. Each gameweek it buys the best legal fifteen it can under the real
 * budget using ONLY data that existed beforehand, picks an XI and a captain,
 * applies FPL's auto-substitutions against what actually happened, and scores
 * it. Then it does the same for baselines that need no model at all.
 *
 * WHAT THIS DELIBERATELY DOES NOT MODEL. Transfers, price changes, and chips.
 * A fresh squad every gameweek is not a season — it is the question "given what
 * was knowable, was this a good fifteen", isolated from transfer planning so
 * that a change to the OBJECTIVE can be read without a season's worth of
 * path-dependence on top of it. A full season simulation is a different and
 * much noisier instrument, and it cannot tell you which half moved.
 *
 * Two limitations inherited from the dataset, both stated in `backtest.ts` and
 * both sharper here:
 *
 *  - No availability flags, so every player is treated as fit. In production
 *    the engine knows who is injured and will not buy them. Here it buys them
 *    and they score nothing. This PENALISES every policy, and penalises the
 *    riskier ones slightly more.
 *  - Season-end team ratings, so the opponent adjustment partly encodes the
 *    future. This FLATTERS the model against the baselines. Run `--neutral`.
 */
import {
  expectedPoints,
  type FixtureContext,
  type GameweekSample,
  type PlayerModelInput,
} from "@/lib/engine/expected-points";
import { gameweekDistribution } from "@/lib/engine/captain";
import { mean as pmfMean, variance as pmfVariance } from "@/lib/engine/distribution";
import { optimiseSquad, type PlayerCandidate } from "@/lib/engine/optimiser";
import { createGlpkSolver } from "@/lib/solver/glpk";
import { projectMinutes } from "@/lib/engine/minutes";
import {
  POSITION,
  POSITION_SHORT,
  FORMATION_BOUNDS,
  SQUAD_BUDGET,
  STARTING_XI_SIZE,
  type PositionId,
} from "@/lib/rules";
import { FORM_WINDOW } from "@/lib/engine/constants";
import { NO_SET_PIECE_DUTY } from "@/lib/engine/set-pieces";
import {
  loadPriorWorkloads,
  loadSeason,
  TOTAL_GWS,
  type Row,
  type SeasonData,
} from "./season-data";

/**
 * First gameweek selected from. GW7 by default, which is where the naive form
 * baseline first has a full window to compare against.
 *
 * `--from 2` runs the early season instead, and that is not a cosmetic option:
 * the minutes model's thin-history behaviour — a player inheriting last
 * season's start rate on one cameo this season — exists ONLY here. From GW7
 * everyone the optimiser would consider has a full window, which is why a
 * backtest anchored at GW7 reports nothing whatever is done to that code path.
 * The form baseline is meaningless this early and will mostly be skipped.
 */
const START_GW = process.argv.includes("--from")
  ? Number(process.argv[process.argv.indexOf("--from") + 1])
  : FORM_WINDOW + 1;
const BASELINE_WINDOW = 4;
const NEUTRAL = process.argv.includes("--neutral");

/**
 * How many past gameweeks a player needs before he is eligible to be bought.
 *
 * Four by default, which is what the form baseline needs to exist. Lowering it
 * admits the thin-history players — a January signing, a promoted club's
 * reserve, anyone the game registered late — and those are exactly the players
 * the minutes model is least sure about and most likely to overrate. Raising
 * and lowering this is how you measure whether that overrating actually costs
 * anything, rather than arguing about it.
 */
const MIN_HISTORY = process.argv.includes("--min-history")
  ? Number(process.argv[process.argv.indexOf("--min-history") + 1])
  : BASELINE_WINDOW;

/**
 * Whether the minutes model gets last season's workload, as production does.
 *
 * On by default, because off is not a neutral choice — it is a DIFFERENT model
 * from the one that ships, and the difference bites hardest on exactly the
 * thin-history players this script was extended to examine. Without a prior,
 * a player with one cameo falls back to the flat no-history rate and the
 * optimiser passes over him; with one, he inherits last season's start rate
 * and can be bought on almost no current evidence. `--no-prior-workload`
 * measures what that inheritance is worth.
 */
const NO_PRIOR_WORKLOAD = process.argv.includes("--no-prior-workload");

/** Risk weights swept unless --gamma is given. Zero is today's behaviour. */
const GAMMA_SWEEP = [-0.10, -0.05, -0.02, 0, 0.02, 0.05, 0.10, 0.20];

// ---------------------------------------------------------------------------
// A player's gameweek: one entry per player, however many fixtures he had
// ---------------------------------------------------------------------------

interface PlayerGameweek {
  element: number;
  position: PositionId;
  team: string;
  price: number;
  /** Every fixture in this gameweek. Two for a double, none for a blank. */
  rows: Row[];
  actual: number;
  played: boolean;
}

function groupByPlayer(rows: Row[]): Map<number, PlayerGameweek> {
  const out = new Map<number, PlayerGameweek>();
  for (const r of rows) {
    const existing = out.get(r.element);
    if (existing) {
      existing.rows.push(r);
      existing.actual += r.points;
      existing.played ||= r.minutes > 0;
      continue;
    }
    out.set(r.element, {
      element: r.element, position: r.position, team: r.team,
      price: r.price, rows: [r], actual: r.points, played: r.minutes > 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Auto-substitutions
// ---------------------------------------------------------------------------

/**
 * FPL's real rule, not an optimisation.
 *
 * Bench players replace non-playing starters in BENCH ORDER, and only where the
 * formation stays legal; the reserve keeper only ever covers the keeper. This
 * is modelled properly rather than approximated because it is the mechanism
 * that pays for risk — a policy that buys volatile starters is protected by its
 * bench, and scoring without auto-subs would punish exactly the behaviour this
 * script exists to measure.
 */
function applyAutoSubs(
  starting: PlayerGameweek[],
  bench: PlayerGameweek[],
): PlayerGameweek[] {
  const xi = [...starting];
  const available = [...bench];

  const countsOf = (team: PlayerGameweek[]) => {
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

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

interface Scored {
  player: PlayerGameweek;
  /** What the policy maximises. */
  score: number;
  /** Projected mean, for choosing the captain and ordering the bench. */
  ep: number;
  pMinutes: number;
}

type Policy = {
  name: string;
  score: (context: {
    player: PlayerGameweek;
    input: PlayerModelInput;
    fixtures: FixtureContext[];
    past: Row[];
  }) => { score: number; ep: number } | null;
};

function modelPolicy(gamma: number): Policy {
  return {
    name: gamma === 0 ? "model" : `model γ=${gamma > 0 ? "+" : ""}${gamma}`,
    score: ({ input, fixtures }) => {
      if (fixtures.length === 0) return { score: 0, ep: 0 };
      const pmf = gameweekDistribution(input, fixtures);
      const mu = pmfMean(pmf);
      return { score: mu - gamma * pmfVariance(pmf), ep: mu };
    },
  };
}

/** The same naive baseline `backtest.ts` uses: last four gameweeks of points. */
const FORM_POLICY: Policy = {
  name: "form (last 4)",
  score: ({ past }) => {
    const window = past.slice(0, BASELINE_WINDOW);
    if (window.length === 0) return null;
    const ep = window.reduce((s, r) => s + r.points, 0) / window.length;
    return { score: ep, ep };
  },
};

/** Cheapest legal fifteen by price. The "did the model do anything" floor. */
const CHEAP_POLICY: Policy = {
  name: "cheapest legal",
  score: ({ player }) => ({ score: -player.price, ep: -player.price }),
};

/** What was actually scored. Not achievable — the ceiling, for scale. */
const HINDSIGHT_POLICY: Policy = {
  name: "hindsight",
  score: ({ player }) => ({ score: player.actual, ep: player.actual }),
};

// ---------------------------------------------------------------------------

interface Result {
  points: number;
  gameweeks: number;
  captainPoints: number;
  autoSubs: number;
  blanks: number;
  /** Squad places given to players with less than a full form window behind them. */
  thinHistoryPicks: number;
  /** Points those players actually returned, to say whether it was a mistake. */
  thinHistoryPoints: number;
  /** Keyed by gameweek so policies can be compared PAIRED — see the report. */
  perGw: Map<number, number>;
}

async function main() {
  const season: SeasonData = await loadSeason();
  const priorWorkloads = NO_PRIOR_WORKLOAD
    ? new Map()
    : await loadPriorWorkloads();
  const solver = await createGlpkSolver();

  const teamIds = new Map<string, number>();
  const teamIdOf = (name: string) => {
    if (!teamIds.has(name)) teamIds.set(name, teamIds.size + 1);
    return teamIds.get(name)!;
  };

  const policies: Policy[] = [
    CHEAP_POLICY,
    FORM_POLICY,
    ...(process.argv.includes("--gamma")
      ? [modelPolicy(Number(process.argv[process.argv.indexOf("--gamma") + 1]))]
      : GAMMA_SWEEP.map(modelPolicy)),
    HINDSIGHT_POLICY,
  ];

  const results = new Map<string, Result>();
  for (const p of policies) {
    results.set(p.name, {
      points: 0, gameweeks: 0, captainPoints: 0,
      autoSubs: 0, blanks: 0, thinHistoryPicks: 0, thinHistoryPoints: 0,
      perGw: new Map(),
    });
  }

  // History per player, most recent first. Built forward so each gameweek only
  // ever sees what preceded it.
  const history = new Map<number, Row[]>();
  const pushHistory = (rows: Row[]) => {
    for (const r of rows) {
      const h = history.get(r.element) ?? [];
      h.unshift(r);
      history.set(r.element, h);
    }
  };
  for (let gw = 1; gw < START_GW; gw++) pushHistory(season.byGw.get(gw) ?? []);

  process.stdout.write("Selecting");
  for (let gw = START_GW; gw <= TOTAL_GWS; gw++) {
    const players = groupByPlayer(season.byGw.get(gw) ?? []);

    // Build the model input once per player, shared by every policy so they
    // are compared on identical information.
    const prepared: {
      player: PlayerGameweek;
      input: PlayerModelInput;
      fixtures: FixtureContext[];
      past: Row[];
    }[] = [];

    for (const player of players.values()) {
      const past = history.get(player.element) ?? [];
      if (past.length < MIN_HISTORY) continue;
      if (player.price <= 0) continue;

      const recent: GameweekSample[] = past.slice(0, FORM_WINDOW).map((s) => ({
        minutes: s.minutes,
        started: s.starts > 0,
        expectedGoals: s.xG,
        expectedAssists: s.xA,
        defensiveContribution: s.defcon,
        bonus: s.bonus,
        goalsConceded: s.goalsConceded,
        yellowCards: s.yellow,
        redCards: s.red,
      }));

      const fixtures: FixtureContext[] = player.rows.map((row) => {
        const opp = season.ratings.get(row.opponentTeam);
        const use = !NEUTRAL && opp !== undefined;
        return {
          gw,
          isHome: row.wasHome,
          teamDefence: use ? season.league.meanDefence : null,
          opponentAttack: use
            ? (row.wasHome ? opp!.attackAway : opp!.attackHome) : null,
          leagueMeanAttack: use ? season.league.meanAttack : null,
          leagueStdAttack: use ? season.league.stdAttack : null,
          opponentDefence: use
            ? (row.wasHome ? opp!.defenceAway : opp!.defenceHome) : null,
          leagueMeanDefence: use ? season.league.meanDefence : null,
          leagueStdDefence: use ? season.league.stdDefence : null,
        };
      });

      prepared.push({
        player,
        past,
        fixtures,
        input: {
          playerId: player.element,
          position: player.position,
          teamId: teamIdOf(player.team),
          minutes: {
            status: "a",
            chanceOfPlayingNextRound: null,
            recentStarts: past.slice(0, FORM_WINDOW).map((s) => s.starts > 0),
            recentMinutes: past.slice(0, FORM_WINDOW).map((s) => s.minutes),
            priorSeason: priorWorkloads.get(player.element) ?? null,
          },
          recent,
          priorSeason: null,
          setPieces: season.duties.get(player.element) ?? NO_SET_PIECE_DUTY,
        },
      });
    }

    for (const policy of policies) {
      const scored: Scored[] = [];
      for (const context of prepared) {
        const out = policy.score(context);
        if (out === null) continue;
        scored.push({
          player: context.player,
          score: out.score,
          ep: out.ep,
          pMinutes: projectMinutes(context.input.minutes).pAppears,
        });
      }
      if (scored.length < 40) continue;

      const byId = new Map(scored.map((s) => [s.player.element, s]));
      const candidates: PlayerCandidate[] = scored.map((s) => ({
        id: s.player.element,
        position: s.player.position,
        teamId: teamIdOf(s.player.team),
        price: s.player.price,
        ep: s.score,
        pMinutes: s.pMinutes,
      }));

      const squad = optimiseSquad(candidates, solver, {
        budget: SQUAD_BUDGET,
        shadowPrice: false,
      });
      if (squad.starting.length !== STARTING_XI_SIZE) continue;

      const lift = (c: PlayerCandidate) => byId.get(c.id)!.player;
      // The bench is ordered by projected MEAN, not by the policy score: FPL
      // substitutes in the order you set, and you would set it by who you most
      // expect to return.
      const benchOrder = [...squad.bench].sort(
        (a, b) => byId.get(b.id)!.ep - byId.get(a.id)!.ep,
      );
      const starting = squad.starting.map(lift);
      const bench = benchOrder.map(lift);

      const finalXi = applyAutoSubs(starting, bench);
      const subsUsed = finalXi.filter((p, i) => p !== starting[i]).length;

      // Captain: the highest projected MEAN in the XI. The armband is a
      // separate decision from squad construction and `captain.ts` already
      // owns the risk half of it — this keeps the two from confounding.
      const captain = [...starting].sort(
        (a, b) => byId.get(b.element)!.ep - byId.get(a.element)!.ep,
      )[0];
      // A captain who is auto-subbed out still scores nothing; the armband does
      // not move to the substitute. That is the real rule.
      const captainPoints = finalXi.includes(captain) ? captain.actual : 0;

      const total = finalXi.reduce((s, p) => s + p.actual, 0) + captainPoints;

      const result = results.get(policy.name)!;
      result.points += total;
      result.gameweeks += 1;
      result.captainPoints += captainPoints;
      result.autoSubs += subsUsed;
      result.blanks += finalXi.filter((p) => !p.played).length;
      for (const p of [...starting, ...bench]) {
        const rows = (history.get(p.element) ?? []).length;
        if (rows < FORM_WINDOW) {
          result.thinHistoryPicks += 1;
          result.thinHistoryPoints += p.actual;
        }
      }
      result.perGw.set(gw, total);
    }

    pushHistory(season.byGw.get(gw) ?? []);
    if (gw % 4 === 0) process.stdout.write(".");
  }
  process.stdout.write(" done\n");

  // --- Report --------------------------------------------------------------

  console.log(`\nSELECTION BACKTEST — 2025/26, GW${START_GW}-${TOTAL_GWS}`);
  console.log(
    `Opponent adjustment: ${NEUTRAL ? "DISABLED (--neutral)" : "enabled (season-end ratings)"}`,
  );
  console.log(
    "A fresh squad every gameweek under the real budget. No transfers, no chips.",
  );
  console.log(
    `Auto-substitutions applied. Captain = highest projected mean. ` +
    `Min history: ${MIN_HISTORY} gw. ` +
    `Prior workload: ${NO_PRIOR_WORKLOAD ? "OFF" : "on"}.\n`,
  );

  const rows = [...results.entries()].filter(([, r]) => r.gameweeks > 0);
  const reference = results.get("model");

  const sdOf = (xs: number[]) => {
    if (xs.length < 2) return 0;
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
  };

  console.log(
    "policy              pts/gw   total   captain  autosubs  blanks/gw   sd   thin/gw  thin pts",
  );
  for (const [name, r] of rows) {
    const perGw = r.points / r.gameweeks;
    console.log(
      `${name.padEnd(18)} ${perGw.toFixed(1).padStart(6)} ${String(r.points).padStart(7)} ` +
      `${(r.captainPoints / r.gameweeks).toFixed(1).padStart(8)} ` +
      `${(r.autoSubs / r.gameweeks).toFixed(2).padStart(9)} ` +
      `${(r.blanks / r.gameweeks).toFixed(2).padStart(10)} ` +
      `${sdOf([...r.perGw.values()]).toFixed(1).padStart(5)} ` +
      `${(r.thinHistoryPicks / r.gameweeks).toFixed(2).padStart(8)} ` +
      `${(r.thinHistoryPicks > 0 ? (r.thinHistoryPoints / r.thinHistoryPicks).toFixed(2) : "—").padStart(9)}`,
    );
  }

  /*
   * PAIRED against gamma=0, and this is the only column worth reading.
   *
   * The unpaired sd above is ~15 points a gameweek, almost all of which is
   * "some gameweeks are high-scoring for everybody". Against that, a two-point
   * difference between policies is invisible: with 32 gameweeks the standard
   * error of a mean is 15/sqrt(32), about 2.7, so the ENTIRE sweep fits inside
   * one of them and a naive reading picks whichever arm got luckiest.
   *
   * Every policy faces the same gameweeks, so the common difficulty cancels
   * when they are differenced week by week. What is left is the effect. The
   * t column is that mean difference over its own standard error; below about
   * 2 there is nothing here, whatever the pts/gw column seems to say.
   */
  if (reference && reference.gameweeks > 0) {
    console.log("\nPAIRED vs gamma=0, per gameweek");
    console.log("policy               diff/gw   sd(diff)   t     verdict");
    for (const [name, r] of rows) {
      if (name === "model") continue;
      const diffs: number[] = [];
      for (const [gw, points] of r.perGw) {
        const other = reference.perGw.get(gw);
        if (other !== undefined) diffs.push(points - other);
      }
      if (diffs.length < 2) continue;
      const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      const sd = sdOf(diffs);
      const se = sd / Math.sqrt(diffs.length);
      const t = se > 0 ? mean / se : 0;
      const verdict =
        Math.abs(t) < 2 ? "noise" : t > 0 ? "BETTER" : "WORSE";
      console.log(
        `${name.padEnd(18)} ${(mean >= 0 ? "+" : "") + mean.toFixed(2).padStart(7)} ` +
        `${sd.toFixed(2).padStart(10)} ${t.toFixed(2).padStart(6)}     ${verdict}`,
      );
    }
  }

  if (reference && reference.gameweeks > 0) {
    const form = results.get(FORM_POLICY.name);
    const base = reference.points / reference.gameweeks;
    console.log("\nDONE-WHEN");
    if (form && form.gameweeks > 0) {
      const f = form.points / form.gameweeks;
      const diffs: number[] = [];
      for (const [gw, points] of form.perGw) {
        const other = reference.perGw.get(gw);
        if (other !== undefined) diffs.push(other - points);
      }
      const m = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      const t = m / (sdOf(diffs) / Math.sqrt(diffs.length));
      /*
       * The margin AND whether it survives its own error bar, because the two
       * disagree here and the second is the one that matters. Reporting "beats
       * the baseline by 7%" from 32 gameweeks, against a paired sd of 16, is
       * how a model gets believed for a difference it has not demonstrated.
       */
      console.log(
        `  model vs form baseline: ${base.toFixed(1)} vs ${f.toFixed(1)} pts/gw ` +
        `(${base > f ? "+" : ""}${(((base - f) / f) * 100).toFixed(1)}%), t=${t.toFixed(2)}`,
      );
      console.log(
        Math.abs(t) >= 2
          ? `    MET — the margin survives its error bar`
          : `    NOT SHOWN — the margin is inside the noise at n=${diffs.length}. ` +
            `More gameweeks, not a better number, is what would settle it.`,
      );
    }
    const anySignal = rows
      .filter(([name]) => name.startsWith("model γ"))
      .some(([, r]) => {
        const diffs: number[] = [];
        for (const [gw, points] of r.perGw) {
          const other = reference.perGw.get(gw);
          if (other !== undefined) diffs.push(points - other);
        }
        if (diffs.length < 2) return false;
        const m = diffs.reduce((a, b) => a + b, 0) / diffs.length;
        return Math.abs(m / (sdOf(diffs) / Math.sqrt(diffs.length))) >= 2;
      });
    console.log(
      anySignal
        ? "  risk weight: at least one gamma clears its error bar — see the table"
        : "  risk weight: NO gamma clears its error bar. Leave RISK_AVERSION at 0.",
    );
  }

  console.log(
    "\nNOTE: no availability flags in this dataset, so every policy buys " +
    "injured players.\n      Absolute scores are therefore pessimistic; the " +
    "comparison between policies is the point.",
  );
}

main();
