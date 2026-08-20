# Next steps

Working document. Two halves: **known gaps** (things that are incomplete or
quietly wrong today) and **the optimisation roadmap** (making the engine
genuinely better rather than merely finished).

Ordered by payoff per unit of effort within each half, not by phase number.

---

## Known gaps

These are real defects or unfinished work, not enhancements. Each one is
already referenced from the code or docs that it affects.

### 1. `transfers_balance` is always zero → the price model is inert

`lib/db/sync-results.ts` writes `transfers_balance: 0` because
`event/{gw}/live/` does not carry it. That column is the primary input to
`lib/engine/price-model.ts`, so price momentum currently returns
`confidence: "none"` for every player and the second objective term in the
optimiser contributes nothing.

**Fix:** capture net transfers daily in `sync-static` from the bootstrap
`elements[]` fields `transfers_in_event` and `transfers_out_event`, which are
current-gameweek running totals. They must be sampled *before* the gameweek
rolls over, which is why this belongs in the daily job rather than the
post-gameweek one. Store per player per gameweek and have `sync-results`
reconcile the final value.

### 2. `suggestTransfers` cannot pin a transfer count

`lib/engine/transfers.ts` solves each scenario and then *filters* results by the
transfer count that happened to come out, because `OptimiserOptions` cannot
express "exactly N of the current squad must be retained". Some counts may never
be surfaced.

**Fix:** add a cardinality constraint to `buildProblem` — sum of `x_i` over the
current squad `>= 15 - n` — and expose it through `OptimiserOptions`. The
optimiser underneath is sound; only the wrapper is wrong.

### 3. Forwards lose to the naive baseline

The backtest has forwards at MAE 1.154 against the baseline's 1.110 — the only
position the model loses. Their scoring is the most goal-dependent and therefore
most skewed, and MAE rewards conservative predictions on skewed distributions.

**Do not tune this against 2025/26 alone.** Fitting a 4% gap on one season is
how you overfit. Revisit once there are ten or more gameweeks of 2026/27 data,
and consider whether MAE is even the right loss for a captaincy decision, where
the ceiling matters more than the mean.

### 4. Mini-leagues have no schema

`getLeagueStandings` exists in the FPL client and is unused. PLAN.md §4 never
specified tables for it, so `/leagues` cannot be built. Needs a migration
(`leagues`, `league_standings`) before the §9 sync job is worth writing.

### 5. No authentication on the deployed app

The production deployment is public. Today it exposes only public gameweek data,
but `/squad` now renders your squad and `/history` will render your decision
journal. Nothing in PLAN.md addresses this. Options: Vercel Deployment
Protection, or a minimal auth gate.

---

## Optimisation roadmap

### 1. ~~Set-piece and penalty duties~~ — **done**, 2026-08-20

`lib/engine/set-pieces.ts`, migration `0002_set_piece_duty.sql`. All three
orders are synced (`penalties_order`, `corners_order`,
`direct_freekicks_order`); penalties and corners are modelled, direct free kicks
stored but not — the term would be smaller than the noise in the other two.

The design problem was not the arithmetic, it was **double counting**: Opta xG
includes penalties, so a naive additive term charges a regular taker twice.
Solved with a credit that decays to zero as the form window fills, which the
backtest vindicates — a floor under the decay makes MAE monotonically worse,
and worse specifically for midfielders and forwards.

Live effect at GW1, where nobody has history and the credit is at full: a
first-choice penalty-taking midfielder gains 0.17 EP, and one who also takes
corners 0.31. Both roughly double once a nailed starter's minutes replace the
0.5 no-history prior.

**What is still open here.** The backtest starts at GW7 and therefore cannot
measure a thin-history term at all; it confirms no harm, not the gain. The real
test is the first six gameweeks of 2026/27. `PENALTIES_PER_TEAM_PER_MATCH` and
the two share tables are league-average estimates, not per-club — a side that
attacks more wins more penalties, and that is derivable from `player_gw_stats`
once there is a season of it.

### 2. Plan the transfer *path*, not the transfer

Today `suggestTransfers` answers "what is the best move this week?". The right
question is "what **sequence** of moves over the next five gameweeks maximises
points?" — because banking a free transfer this week to make a double move next
week is frequently correct, and the current formulation structurally cannot see
it.

Formulation: squad-membership variables per player **per gameweek**
(`x_{i,g}`), with:

- transfers in gameweek `g` = players in `g` not in `g-1`
- free transfers accumulating, capped at 5, per `lib/engine/free-transfers.ts`
- hits deducted at 4 points per transfer beyond the allowance
- budget carried forward, adjusted by price movement

Bigger MILP, same solver. This is the difference between a tool that reacts and
one that plans, and it subsumes the "roll it" recommendation as a natural
consequence rather than a special case.

Do this **after** a few gameweeks of real data, so the projections it plans on
are worth planning on.

### 3. Chip timing as an assignment problem

PLAN.md §7 specifies rules-based triggers with thresholds — "fire Triple Captain
above 8.5 EP". That is a guess dressed as a rule. Chip timing is exactly
solvable with the solver already in the repo.

For each chip and each eligible gameweek, the marginal gain is computable:

| Chip | Gain in gameweek *g* |
|---|---|
| Bench Boost | bench EP in *g* |
| Triple Captain | captain EP in *g* |
| Free Hit | optimal one-week squad EP − current squad EP |
| Wildcard | optimal rebuild EP over the remaining horizon − current |

Then maximise total gain subject to: one chip per gameweek, each chip inside its
API-reported window (`resolveChipWindows`), each chip used at most once per set.

This answers the question a threshold cannot — *"is this week good enough, or is
a better one coming before the window closes?"* — and it is where the existing
blank/double detection finally earns out.

### 4. Better form modelling

Two directions the backtest points at directly.

**Regression to the mean.** A player massively overperforming their xG will
revert. Shrinking finishing toward the player's own baseline should help most
where the model is currently worst, which is forwards.

**Replace the opponent adjustment.** Disabling it entirely costs only 0.4pp
(2.6% → 2.2%), so it is barely earning its place. Either the FPL strength
ratings carry little signal or §5's formulation underuses them. Deriving team
strength from **observed xG for and against** rather than FPL's published
ratings is the likely fix, and it is directly testable against the backtest.

---

## Suggested order

1. ~~**Set-piece duties**~~ — done 2026-08-20.
2. **`transfers_balance` capture** — unblocks a whole objective term that is
   currently dead weight. **Next up.**
3. **Chip assignment** — turns the vaguest part of the spec into something
   exact, reuses the existing solver.
4. **`suggestTransfers` cardinality** — small, and needed before `/transfers`
   can be trusted.
5. **Transfer-path MILP** — biggest win, biggest job, wants real data first.
6. **Form modelling and forwards** — needs ten-plus gameweeks of 2026/27 before
   tuning is anything other than overfitting.

Auth (gap 5) is not on this list because its urgency is set by when the app
becomes publicly discoverable, not by the engine's progress.
