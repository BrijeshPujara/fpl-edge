/**
 * Backtest — PLAN.md section 5's calibration requirement.
 *
 * Replays the expected-points model over the 2025/26 season, gameweek by
 * gameweek, using ONLY data that existed before each gameweek, and reports mean
 * absolute error per position against a naive baseline.
 *
 * The bar PLAN.md sets: beat "the average of the last four gameweeks". If the
 * model cannot clear that, every constant in it is decoration and the honest
 * move is to say so.
 *
 * Data: the vaastav/Fantasy-Premier-League per-gameweek CSVs. Cached locally on
 * first run; delete .backtest-cache to refetch.
 *
 * Two limitations, stated up front because they flatter and penalise the model
 * in opposite directions:
 *
 *  - Availability flags are not in the dataset, so every player is treated as
 *    fit and the minutes model runs on appearance history alone. That PENALISES
 *    the model: in production it knows who is injured.
 *  - Team strength ratings come from the season-end snapshot, so early
 *    gameweeks use ratings that partly encode the future. That FLATTERS the
 *    opponent adjustment slightly. Run with `--neutral` to disable it entirely
 *    and see the model without that help.
 *  - Set-piece duty likewise comes from the season-end players_raw.csv, so a
 *    duty that changed hands in March is credited from GW1. Milder than it
 *    sounds — duty is far more stable across a season than form is — but it
 *    FLATTERS the set-piece term. Run with `--no-set-pieces` to remove it.
 */

import {
  expectedPoints,
  type FixtureContext,
  type GameweekSample,
} from "@/lib/engine/expected-points";
import { setPieceCredit } from "@/lib/engine/set-pieces";
import { gameweekDistribution } from "@/lib/engine/captain";
import { mean as pmfMean, MIN_POINTS } from "@/lib/engine/distribution";
import { POSITION, POSITION_SHORT, type PositionId } from "@/lib/rules";
import { FORM_WINDOW } from "@/lib/engine/constants";
import { NO_SET_PIECE_DUTY } from "@/lib/engine/set-pieces";
import { loadSeason, TOTAL_GWS, type Row } from "./season-data";

const mean = (a: number[]) =>
  a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

/** First gameweek projected. Needs FORM_WINDOW of history behind it. */
const START_GW = FORM_WINDOW + 1;
/** Gameweeks averaged by the naive baseline, per PLAN.md section 5. */
const BASELINE_WINDOW = 4;

const NEUTRAL = process.argv.includes("--neutral");
const NO_SET_PIECES = process.argv.includes("--no-set-pieces");

// --- Stats -----------------------------------------------------------------

interface Acc {
  /** Sum of E|X - E[X]| over the model's own distributions — the MAE floor. */
  irreducible: number;
  absModel: number; absBase: number; count: number;
  sumActual: number; sumModel: number; sumBase: number;
  playedCount: number; playedAbsModel: number; playedSumActual: number; playedSumModel: number;
  blankCount: number; blankAbsModel: number; blankSumModel: number;
}
const acc = (): Acc => ({
  irreducible: 0,
  absModel: 0, absBase: 0, count: 0,
  sumActual: 0, sumModel: 0, sumBase: 0,
  playedCount: 0, playedAbsModel: 0, playedSumActual: 0, playedSumModel: 0,
  blankCount: 0, blankAbsModel: 0, blankSumModel: 0,
});

async function main() {
  const { byGw, ratings, duties, league } = await loadSeason({
    withSetPieces: !NO_SET_PIECES,
  });
  const { meanAttack, stdAttack, meanDefence, stdDefence } = league;

  // History per player, most recent first.
  const history = new Map<number, Row[]>();
  const pushHistory = (rows: Row[]) => {
    for (const r of rows) {
      const h = history.get(r.element) ?? [];
      h.unshift(r);
      history.set(r.element, h);
    }
  };
  for (let gw = 1; gw < START_GW; gw++) pushHistory(byGw.get(gw) ?? []);

  // How far the set-piece term actually reaches. It is a prior that decays to
  // nothing once a player has a full form window behind him, and this backtest
  // starts at GW7 — by which point most regulars have exactly that. Counted so
  // a near-identical MAE reads as "the term barely fired here", which is true,
  // rather than "the term does nothing", which is not.
  let dutyRows = 0;
  let dutyCredited = 0;

  const overall = acc();
  const perPosition = new Map<PositionId, Acc>();
  for (const p of Object.values(POSITION)) perPosition.set(p, acc());

  for (let gw = START_GW; gw <= TOTAL_GWS; gw++) {
    for (const row of byGw.get(gw) ?? []) {
      const past = history.get(row.element) ?? [];
      if (past.length < BASELINE_WINDOW) continue;

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

      const opp = ratings.get(row.opponentTeam);
      const useRatings = !NEUTRAL && opp !== undefined;

      const fixture: FixtureContext = {
        gw,
        isHome: row.wasHome,
        // The player's own team defence is not in the per-gameweek rows, so the
        // league mean stands in — the opponent term is what is being tested.
        teamDefence: useRatings ? meanDefence : null,
        opponentAttack: useRatings ? (row.wasHome ? opp!.attackAway : opp!.attackHome) : null,
        leagueMeanAttack: useRatings ? meanAttack : null,
        leagueStdAttack: useRatings ? stdAttack : null,
        opponentDefence: useRatings ? (row.wasHome ? opp!.defenceAway : opp!.defenceHome) : null,
        leagueMeanDefence: useRatings ? meanDefence : null,
        leagueStdDefence: useRatings ? stdDefence : null,
      };

      const modelInput = {
          playerId: row.element,
          position: row.position,
          teamId: 0,
          minutes: {
            // The dataset carries no availability flags, so everyone is treated
            // as fit and the minutes model runs on appearances alone.
            status: "a",
            chanceOfPlayingNextRound: null,
            recentStarts: past.slice(0, FORM_WINDOW).map((s) => s.starts > 0),
            recentMinutes: past.slice(0, FORM_WINDOW).map((s) => s.minutes),
          },
          recent,
          priorSeason: null,
          setPieces: duties.get(row.element) ?? NO_SET_PIECE_DUTY,
      };

      const predicted = expectedPoints(modelInput, fixture).total;

      /*
       * The IRREDUCIBLE error, and the most important number in this file.
       *
       * MAE is usually read as "how wrong the model is", which invites the
       * conclusion that a better model would drive it toward zero. It would
       * not. Football is a handful of near-Poisson events: a striker with a
       * true xG of 0.6 scores 0, 1 or 2 goals, never 0.6, and no amount of
       * modelling removes that draw. Even a model that knew every player's
       * exact underlying rate would still post a large MAE.
       *
       * That floor is computable here rather than guessed at, because the
       * engine already produces a full distribution per player-gameweek and
       * not just its mean. E|X - E[X]| over the model's OWN pmf is the error a
       * perfectly calibrated version of this model would still make. The gap
       * between it and the measured MAE is the only part any modelling work
       * can ever recover.
       */
      const pmf = gameweekDistribution(modelInput, [fixture]);
      const mu = pmfMean(pmf);
      let expectedAbsDeviation = 0;
      for (let i = 0; i < pmf.length; i++) {
        expectedAbsDeviation += pmf[i] * Math.abs(i + MIN_POINTS - mu);
      }

      const duty = duties.get(row.element);
      if (duty && (duty.penaltiesOrder !== null || duty.cornersOrder !== null)) {
        dutyRows += 1;
        if (setPieceCredit(recent.filter((s) => s.minutes > 0).length) > 0) {
          dutyCredited += 1;
        }
      }

      const baseline = mean(past.slice(0, BASELINE_WINDOW).map((s) => s.points));

      const a = Math.abs(predicted - row.points);
      const b = Math.abs(baseline - row.points);

      for (const bucket of [overall, perPosition.get(row.position)!]) {
        bucket.irreducible += expectedAbsDeviation;
        bucket.absModel += a;
        bucket.absBase += b;
        bucket.count += 1;
        bucket.sumActual += row.points;
        bucket.sumModel += predicted;
        bucket.sumBase += baseline;
        // Split on whether the player actually featured. Most rows in this
        // dataset are players who did not play at all, and predicting those
        // correctly is most of the scoring.
        if (row.minutes > 0) {
          bucket.playedCount += 1;
          bucket.playedAbsModel += a;
          bucket.playedSumActual += row.points;
          bucket.playedSumModel += predicted;
        } else {
          bucket.blankCount += 1;
          bucket.blankAbsModel += a;
          bucket.blankSumModel += predicted;
        }
      }
    }
    pushHistory(byGw.get(gw) ?? []);
  }

  // --- Report --------------------------------------------------------------

  const pct = (m: number, b: number) => ((b - m) / b) * 100;
  const line = (label: string, x: Acc) => {
    const m = x.absModel / x.count;
    const b = x.absBase / x.count;
    const delta = pct(m, b);
    const verdict = delta > 0 ? "BEATS" : "LOSES TO";
    return (
      `  ${label.padEnd(8)} n=${String(x.count).padStart(6)}  ` +
      `mean actual=${(x.sumActual / x.count).toFixed(2).padStart(5)}  ` +
      `model MAE=${m.toFixed(3)}  baseline MAE=${b.toFixed(3)}  ` +
      `floor=${(x.irreducible / x.count).toFixed(3)}  ` +
      `${verdict} by ${Math.abs(delta).toFixed(1)}%`
    );
  };

  console.log(`\nBACKTEST — 2025/26, GW${START_GW}-${TOTAL_GWS}`);
  console.log(
    `Opponent adjustment: ${NEUTRAL ? "DISABLED (--neutral)" : "enabled (season-end ratings)"}`,
  );
  console.log(
    `Set-piece duty:      ${NO_SET_PIECES ? "DISABLED (--no-set-pieces)" : `enabled (${duties.size} players, season-end snapshot)`}`,
  );
  console.log(`Baseline: mean points over the previous ${BASELINE_WINDOW} gameweeks\n`);

  console.log(line("ALL", overall));
  console.log("");
  for (const [pos, bucket] of [...perPosition].sort((a, b) => a[0] - b[0])) {
    if (bucket.count > 0) console.log(line(POSITION_SHORT[pos], bucket));
  }

  console.log("\nHOW MUCH OF THE ERROR IS EVEN REMOVABLE");
  {
    const floor = overall.irreducible / overall.count;
    const m = overall.absModel / overall.count;
    const b = overall.absBase / overall.count;
    console.log(
      `  irreducible floor  ${floor.toFixed(3)} — the MAE a PERFECTLY calibrated`,
    );
    console.log(
      "                     version of this model would still post, because a",
    );
    console.log(
      "                     player with a true xG of 0.6 scores 0, 1 or 2, never 0.6",
    );
    console.log(`  this model         ${m.toFixed(3)}`);
    console.log(`  naive baseline     ${b.toFixed(3)}`);
    console.log(
      `  headroom           ${(m - floor).toFixed(3)} of ${m.toFixed(3)} ` +
      `(${(((m - floor) / m) * 100).toFixed(1)}% of the error is modelling; ` +
      `${((floor / m) * 100).toFixed(1)}% is football)`,
    );
    console.log(
      `  the whole race     ${(b - floor).toFixed(3)} separates a naive baseline ` +
      `from a perfect model`,
    );
    console.log(
      `  captured           ${(b - m).toFixed(3)} of that ${(b - floor).toFixed(3)} ` +
      `(${(((b - m) / (b - floor)) * 100).toFixed(0)}% of what is winnable)`,
    );
    console.log(
      "  CAVEAT: the floor is E|X-E[X]| over the model's OWN distributions, so it",
    );
    console.log(
      "          assumes they are shaped right. It is an estimate of the limit,",
    );
    console.log(
      "          not a proof of it — but the limit is real and it is not near zero.",
    );
  }

  console.log("\nDIAGNOSTICS");
  console.log(
    `  overall bias        model ${(overall.sumModel / overall.count).toFixed(3)} vs actual ` +
    `${(overall.sumActual / overall.count).toFixed(3)}  ` +
    `(${overall.sumModel > overall.sumActual ? "OVER" : "UNDER"}-predicts by ` +
    `${Math.abs((overall.sumModel - overall.sumActual) / overall.count).toFixed(3)} pts/row)`,
  );
  console.log(
    `  baseline bias       model ${(overall.sumBase / overall.count).toFixed(3)} vs actual ` +
    `${(overall.sumActual / overall.count).toFixed(3)}`,
  );
  if (!NO_SET_PIECES) {
    const reach = dutyRows === 0 ? 0 : (dutyCredited / dutyRows) * 100;
    console.log(
      `  set-piece duty      ${dutyRows} rows have a listed duty; the credit ` +
      `reached ${dutyCredited} of them (${reach.toFixed(1)}%)`,
    );
    console.log(
      "                      the term is a thin-history prior, and this " +
      "backtest starts at GW7 — it cannot see where the term earns most",
    );
  }

  const dnp = overall.blankCount / overall.count;
  console.log(
    `  did NOT play        ${overall.blankCount} rows (${(dnp * 100).toFixed(1)}% of all)  ` +
    `mean predicted=${(overall.blankSumModel / overall.blankCount).toFixed(3)}  ` +
    `MAE=${(overall.blankAbsModel / overall.blankCount).toFixed(3)}`,
  );
  console.log(
    `  DID play            ${overall.playedCount} rows  ` +
    `mean actual=${(overall.playedSumActual / overall.playedCount).toFixed(2)}  ` +
    `mean predicted=${(overall.playedSumModel / overall.playedCount).toFixed(2)}  ` +
    `MAE=${(overall.playedAbsModel / overall.playedCount).toFixed(3)}`,
  );

  const beat = pct(overall.absModel / overall.count, overall.absBase / overall.count) > 0;
  console.log(
    `\nPLAN.md section 5 done-when: ${beat ? "MET — model beats the naive baseline" : "NOT MET — model does not beat the naive baseline"}`,
  );
  process.exit(0);
}

void main();
