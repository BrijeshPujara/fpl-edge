# What data goes in, and what is calculated from it

Written 2026-08-20, in answer to three questions: what data is actually used,
what the key calculations are, and whether the FPL API is enough.

The short version: **the FPL API is enough, and the app is not yet using all of
it.** The single biggest gap is not a missing external source — it is four
seasons of history sitting in an FPL endpoint the app does not call.

---

## 1. The data

Everything below comes from `fantasy.premierleague.com/api/`. No scraping, no
paid feed, no key.

### `bootstrap-static/` — pulled daily

| Field | Used for |
|---|---|
| `expected_goals`, `expected_assists` | The attacking half of expected points. Opta data. |
| `minutes`, `starts` | The minutes model — the highest-leverage input in the engine. |
| `status`, `chance_of_playing_next_round` | Availability. |
| `news` | Injury *category*, which the percentage does not carry. |
| `penalties_order`, `corners_and_indirect_freekicks_order` | Set-piece duty. |
| `defensive_contribution` | Defensive-contribution points. |
| `bonus`, `bps` | Bonus projection. |
| `now_cost`, `selected_by_percent` | Budget constraint, and the ownership base a price change scales against. |
| `transfers_in`, `transfers_out` | Price momentum, by differencing daily snapshots. |
| `teams[].strength_*` | Opponent adjustment. **The weakest input in the model.** |
| `chips[]` | Chip windows — read, never hardcoded. |
| `events[]` | Deadlines, and which gameweek is live. |

### `fixtures/` — daily

Fixture list and difficulty. Blanks and doubles are **counted** from it rather
than trusted from a rating, which is what lets the chip planner find a double
gameweek fifteen weeks out.

### `event/{gw}/live/` — after each gameweek

Every player's actual returns for a gameweek in one request: 38 calls a season
against roughly 700 to `element-summary/`. This is what fills
`player_gw_stats`, which is the history everything else is projected from.

### `entry/{id}/`, `entry/{id}/event/{gw}/picks/`, `entry/{id}/history/`

Your squad, bank, chips played and transfer counts. Also every league you are
in, which is why leagues need no configuration.

### Not used, and why

- `ict_index`, `influence`, `creativity`, `threat` — composite indices built
  from the same underlying events as xG and xA. Using both would double-count.
- `ep_this`, `ep_next` — FPL's own projection. The whole point is to compute a
  better one, and blending them in would make the backtest meaningless.
- `form` — a four-gameweek mean of *points*, which is the thing being predicted,
  not an input to predicting it.

---

## 2. The calculations

### Expected points — `lib/engine/expected-points.ts`

```
EP = P(60+) × 2  +  P(1–59) × 1
   + xG90_adj × minutesScale × goalPoints(position)
   + xA90_adj × minutesScale × 3
   + P(clean sheet) × cleanSheetPoints(position)
   + setPieceDuty × minutesScale × credit(appearances)
   + E(defensive contributions) + E(bonus)
   − E(goals conceded)        // GK and DEF only
   − E(cards)
```

Four things in there are easy to get wrong and are worth knowing:

**Minutes scale everything.** 62% of all player-gameweek rows are
non-appearances. An early version assumed a flat cameo chance for every
non-starter and finished **16.2% worse than a naive baseline**; deriving the
cameo rate from observed appearances moved it to **+2.6%**. Nothing else in the
model is close to that sensitive.

**Clean sheets are Poisson, and the concession penalty is not.** A clean sheet
is `exp(−λ)` and needs 60 minutes to pay. The concession penalty is
`E[floor(X/2)]` — one point per *two* goals — and has no 60-minute
qualification, so it scales with expected minutes instead. Approximating it as
`λ/2` overstates it by about a quarter of a point.

**Set-piece duty is not additive.** Opta xG already contains penalties, so
adding a penalty term on top charges a regular taker twice. The duty enters as a
prior whose credit decays to zero as the form window fills. Measured: putting a
floor under that decay makes the backtest monotonically worse.

**Triple Captain is worth 1×, not 3×.** The armband already pays double, so the
chip buys the step from doubling to tripling.

### The squad solve — `lib/engine/optimiser.ts`

A mixed-integer programme: 15 players, £100m, max three per club, exact
positional composition, and a legal XI inside the fifteen. It returns the
**provably optimal** squad, not a good one. About 76ms over 595 players.

It then solves the *same* programme again with integrality dropped, purely to
read the dual on the budget row — the marginal expected points per £0.1m. A
mixed-integer programme has no usable duals, which is why it takes two solves.

### Transfers — `lib/engine/transfers.ts`

Each transfer count is a separate scenario, pinned by a retention floor ("keep
at least 15 − n of the current squad"), and compared *after* the four-point hit.
Gain is measured on the **starting XI**, not the fifteen — only the eleven
score, and the hit is charged in real points.

Rolling needs no solve at all and is always available.

### Chip timing — `lib/engine/chips.ts`

A bipartite assignment over chips and gameweeks. Thresholds cannot answer *"is
this week good enough, or is a better one coming before the window shuts"*; an
assignment can. Each recommendation reports the margin over the best week that
chip could actually move to instead.

### Price momentum — `lib/engine/price-model.ts`

Net transfers as a fraction of the owner base, because FPL's change threshold
scales with ownership. Gains are halved on the way out — the 50% sell-on fee
means a £0.4m rise is £0.2m in your pocket, while a fall is borne in full.

---

## 3. Is the FPL API enough?

**Yes — and the more useful finding is that it is not being fully used.**

### The gap that matters: four seasons already sitting there

`element-summary/{id}` returns `history_past`: per-season `minutes`, `starts`,
`expected_goals`, `expected_assists`, `defensive_contribution`, `bonus` and the
rest, going back four seasons.

The model already has a `priorSeason` input and a shrinkage schedule that says
*"at GW1 believe last season 70%, decaying to zero by GW6"*. In production
`priorSeason` is passed as `null`. **So for exactly the six gameweeks the
shrinkage exists to cover, it blends toward nothing.**

That is the single highest-value data change available, it needs no new source,
and it matters most in the gameweeks starting now. Cost is one request per
player, once — `history_past` only changes between seasons.

### The second gap: team strength

The opponent adjustment uses FPL's published `strength_*` ratings, and the
backtest says disabling it entirely costs only **0.4 percentage points**. It is
barely earning its place.

The fix is also already in the database: team xG for and against is the sum of
player xG by team, and `player_gw_stats` will hold that from the first
gameweek. Observed attacking and defensive strength beats a published rating
that updates rarely and lags.

### What genuinely is not in the FPL API

Only two things, and one of them is not sold anywhere:

**Predicted lineups and press-conference detail.** Nothing free and reliable
covers this. It is the one place an LLM adds real predictive value, because it
lands on minutes. See `multi-user-and-ai.md`.

**Shot-level detail** — where a shot was taken from, whether it was a big
chance, xG chain and buildup. Aggregate xG is in FPL; the shot-level breakdown
is not.

### The external options, honestly

| Source | Cost | Adds | Verdict |
|---|---|---|---|
| [Understat](https://understat.com) | Free, scraped | Shot-level xG, npxG, xGChain, xGBuildup | Real signal. No official API, terms unclear, and structurally fragile. Only worth it once the model is good enough to be limited by shot detail — it is not. |
| [FBref](https://fbref.com) (StatsBomb) | Free, scraped, rate-limited | Deep possession and defensive metrics | Heavy for what it adds over FPL's own xG. Explicit crawl-delay. |
| [vaastav/Fantasy-Premier-League](https://github.com/vaastav/Fantasy-Premier-League) | Free, CC-licensed | Historical FPL data as CSVs | **Already used** by the backtest and the preview harness. The legitimate free archive. |
| [football-data.org](https://www.football-data.org) | Free tier | Fixtures, results, tables | Adds nothing the FPL API lacks. |
| [Sportmonks](https://www.sportmonks.com/football-api/xg-data/) | ~€34/month | xG, lineups, predictions | The only paid option that would add something real — predicted lineups. Not worth it before the free gaps above are closed. |

### The recommendation

Close the two free gaps first, in this order:

1. **`history_past` → `priorSeason`.** Hours of work, no new dependency, and it
   fixes a model input that is inert during the exact gameweeks now starting.
2. **Team strength from observed xG.** Needs a few gameweeks of
   `player_gw_stats`, then replaces the weakest input in the model with one
   derived from data already held.

Neither needs a new API, a key, or a scraper. Reach outside FPL only once the
model is demonstrably limited by something FPL does not have — and on the
current evidence, it is limited by things FPL does have and the app is not yet
reading.
