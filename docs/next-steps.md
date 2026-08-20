# Next steps

Working document. Two halves: **known gaps** (things that are incomplete or
quietly wrong today) and **the optimisation roadmap** (making the engine
genuinely better rather than merely finished).

Ordered by payoff per unit of effort within each half, not by phase number.

---

## Known gaps

These are real defects or unfinished work, not enhancements. Each one is
already referenced from the code or docs that it affects.

### 1. ~~`transfers_balance` is always zero~~ — **done**, 2026-08-20

Migration `0003_transfer_snapshots.sql`, `lib/engine/transfer-momentum.ts`,
`lib/db/price-momentum.ts`. `sync-static` now records cumulative
`transfers_in`/`transfers_out` for every player daily, plus `total_players` in
a new `game_state` table.

**Two deviations from what this document originally proposed**, both for
correctness:

- *Cumulative counters, not `transfers_in_event`.* The per-event fields reset
  at every deadline, so the proposed "sample before rollover" loses a whole
  gameweek to a single missed or late cron run. Cumulative counters differenced
  day-on-day are self-healing (a missed day merges into the next delta),
  idempotent on retry, and daily rather than weekly — which matters, because
  FPL moves prices daily.
- *`player_gw_stats.transfers_balance` was dropped, not filled.* That table is
  keyed per fixture so doubles are representable; net transfers are per
  gameweek. In a double there is no honest value to write — the true figure
  double counts on aggregation, and splitting it invents a per-fixture number
  that does not exist. The column was unrepresentable where it sat.

Also fixed while in there: the daily sync ran at 00:15 UTC on the belief that
it followed the 01:30 UK price change. It did not — 15 minutes early under BST,
75 under GMT — so every price snapshot was a day stale. Now 02:00 UTC, which is
late enough in both.

**Now wired.** `/transfers` feeds `realisableDelta` into the optimiser per
candidate via `loadDecisionContext`. Confidence reads `"none"` until roughly
GW4, which is correct rather than broken — the price term simply contributes
nothing until there is momentum to measure.

### 2. ~~`suggestTransfers` cannot pin a transfer count~~ — **done**, 2026-08-20

`retentionPool` and `minRetained` on `OptimiserOptions`, a `retention`
constraint in `buildProblem`, and `suggestTransfers` rewritten to use them.

**It was worse than described here.** The claim was that "some counts may never
be surfaced". In fact, with every scenario solving the identical unconstrained
problem, the function returned exactly **one** option — an eleven-transfer
wholesale rebuild — and no roll option at all. The regression test pins that:
with the constraint removed it asserts `[11]` where `[0, 1, 2, 3]` is wanted.

The floor is "at least 15 − n retained", not an equality. The optimiser will
never make a transfer that does not help, so the floor binds from below and a
scenario may return fewer changes than asked. That is the correct reading of
"at most n" and stops the model burning a transfer it does not want.

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

### 3. ~~Chip timing as an assignment problem~~ — **done**, 2026-08-20

`lib/engine/chips.ts`. PLAN.md §7 rewritten: the threshold triggers are gone,
replaced by a bipartite assignment over chips and gameweeks solved with the
existing solver. `planChips` returns, per assignment, the next-best gameweek
for that same chip and the margin over it — the answer a threshold structurally
cannot give. Unplayed chips report why rather than vanishing.

`benchBoostGain` and `tripleCaptainGain` are here too. The second is the one
worth knowing about: Triple Captain's gain is **one** further multiple of
captain EP, not three, because the armband is already paying double.

**Now complete and wired.** All four gains are computed in
`lib/engine/chip-gains.ts` and rendered on `/chips`. Free Hit and Wildcard each
take a solve per gameweek, which is why `OptimiserOptions.shadowPrice` exists —
the dual costs a whole second solve and the chip planner needs none of them.

One flaw found and fixed while building the screen: `marginOverNextBest`
originally compared against the best *unconstrained* alternative gameweek, which
goes negative whenever another chip won that week. "3.6 points worse than a
gameweek you cannot have" answers no question anyone is asking. It now compares
only against gameweeks no other chip is using, which makes it non-negative by
optimality.

Still open: gains are treated as independent across chips, which they are not —
a Wildcard changes what a Bench Boost is worth the week after. That is the
transfer-path MILP's problem, below.

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
2. ~~**`transfers_balance` capture**~~ — done 2026-08-20.
3. ~~**Chip assignment**~~ — done 2026-08-20.
4. ~~**`suggestTransfers` cardinality**~~ — done 2026-08-20.
5. **Transfer-path MILP** — biggest win, biggest job, wants real data first.
   **Next up**, once a few gameweeks have been played.

The screens are built, so the remaining work is all model quality rather than
plumbing. Both `/transfers` and `/chips` will render an explanation instead of a
table until a gameweek has been played — see `projectable` on the candidate
pool. That is the intended behaviour, not an outage.
6. **Form modelling and forwards** — needs ten-plus gameweeks of 2026/27 before
   tuning is anything other than overfitting.

Auth (gap 5) is not on this list because its urgency is set by when the app
becomes publicly discoverable, not by the engine's progress.
