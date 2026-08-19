# FPL Edge — Build Plan

A data-driven Fantasy Premier League decision engine. Ingests official FPL data, computes expected points, optimises transfers under FPL's constraints, tracks every decision against its outcome, and produces a weekly brief.

This document is the spec. Work through it phase by phase. Do not skip ahead — each phase should be committed and working before the next begins.

---

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js (App Router), TypeScript strict | UI + API routes + cron in one deployable |
| Database | Supabase (Postgres) | Free tier, generated TS types, SQL is the right tool for this data |
| Hosting | Vercel | Free tier includes cron |
| Styling | Tailwind + shadcn/ui | Fast, looks intentional |
| Charts | Recharts | Form trends, EP distributions |
| LLM | Anthropic SDK (`@anthropic-ai/sdk`) | Weekly brief commentary only — never on the critical path |
| Validation | Zod | FPL API is untyped and occasionally changes shape |
| Testing | Vitest | Unit tests on the scoring/optimiser modules |

**Non-negotiable architectural rule:** the deterministic engine (EP model + optimiser) must work with no LLM key present. The LLM is a presentation layer that explains the numbers. If `ANTHROPIC_API_KEY` is unset, the app renders raw analysis and skips commentary.

---

## 2. Data sources

All from the official, unauthenticated FPL API at `https://fantasy.premierleague.com/api/`.

| Endpoint | Contents | Sync frequency |
|---|---|---|
| `bootstrap-static/` | All players (price, form, xG, xA, ICT, ownership, status flags), all teams (strength ratings), all gameweeks (`events`, incl. deadlines) | Daily 00:15 UK |
| `fixtures/` | Every fixture, difficulty ratings, kickoff times, finished flags | Daily |
| `element-summary/{playerId}/` | Per-player gameweek history + upcoming fixtures | On demand, cached |
| `event/{gw}/live/` | Live points for a gameweek | Every 15 min during match windows |
| `entry/{teamId}/` | Manager summary, chips used | Daily |
| `entry/{teamId}/event/{gw}/picks/` | Squad, captain, bench order for a gameweek | Post-deadline |
| `entry/{teamId}/history/` | Season history, past chips, transfers | Weekly |
| `leagues-classic/{leagueId}/standings/` | Mini-league standings, rival team IDs | Weekly |

**Implementation notes:**
- CORS-blocked in the browser. Every call must be server-side (route handler or server component).
- Send a normal browser `User-Agent` header; the API rejects some default fetch agents.
- Never derive gameweek numbers or deadlines from hardcoded dates. Read them from `bootstrap-static.events[]` (`id`, `deadline_time`, `is_current`, `is_next`, `finished`). This is the single source of truth for "what gameweek is it".
- Wrap every response in a Zod schema. Fail loudly on shape changes rather than silently writing nulls.

---

## 3. Domain rules for 2026/27

Encode these as constants in `lib/rules.ts`.

**Squad:** £100.0m budget, 15 players — 2 GK, 5 DEF, 5 MID, 3 FWD. Max 3 players per club. Valid formations: 1 GK, 3–5 DEF, 2–5 MID, 1–3 FWD, 11 starters.

**Transfers:** 1 free transfer per gameweek, rolling to a maximum of 5 banked. Additional transfers cost −4 points each. Free transfers carry over even when a Wildcard or Free Hit is played.

**Chips:** Two full sets — Wildcard, Free Hit, Triple Captain, Bench Boost. One set per half. The first set expires at the Gameweek 19 deadline (13:30 GMT, Saturday 2 January 2027) and does not carry over. The second set unlocks from GW20. Only one chip per gameweek.

**Scoring — defensive contributions (DefCon):** Defenders scoring 2 points for 10+ combined clearances, blocks, interceptions and tackles in a match. Midfielders and forwards need 12+, with ball recoveries also counting toward the total. Unchanged this season.

**Bonus points:** The BPS was rebalanced for 2026/27 to reduce overlap with DefCon, improving bonus potential for goalkeepers, full-backs, attacking midfielders and forwards. Historical bonus rates from 2025/26 therefore slightly *understate* these positions — apply a positional correction factor in the EP model and flag it as a tunable constant.

**Live data:** Points, ranks and mini-league standings now update live, and projected bonus appears 20 minutes into each match. Useful for the in-play view in Phase 6.

---

## 4. Database schema

Supabase migrations in `supabase/migrations/`. Generate types with `supabase gen types typescript`.

```sql
-- Reference data, refreshed from bootstrap-static
teams (
  id int primary key, name text, short_name text,
  strength_attack_home int, strength_attack_away int,
  strength_defence_home int, strength_defence_away int,
  updated_at timestamptz
)

players (
  id int primary key,
  web_name text, first_name text, second_name text,
  team_id int references teams(id),
  position smallint,              -- 1 GK, 2 DEF, 3 MID, 4 FWD
  now_cost int,                   -- tenths of a million
  status text,                    -- a/d/i/s/u
  chance_of_playing_next_round int,
  selected_by_percent numeric,
  updated_at timestamptz
)

-- One row per player per gameweek. This is the history that makes the app worth building.
player_gw_stats (
  player_id int references players(id),
  gw smallint,
  minutes int, goals int, assists int, clean_sheets int,
  expected_goals numeric, expected_assists numeric,
  defensive_contribution int, bonus int, bps int,
  total_points int, value int, transfers_balance int,
  primary key (player_id, gw)
)

price_history (
  player_id int references players(id),
  recorded_at timestamptz,
  cost int,
  primary key (player_id, recorded_at)
)

fixtures (
  id int primary key, gw smallint,
  home_team int references teams(id), away_team int references teams(id),
  kickoff timestamptz, finished bool,
  home_difficulty smallint, away_difficulty smallint
)

-- Your state
squads (
  id uuid primary key default gen_random_uuid(),
  gw smallint, captain_id int, vice_captain_id int,
  chip_played text,               -- null | wildcard | freehit | 3xc | bboost
  bank int, team_value int,
  free_transfers smallint,
  created_at timestamptz
)

squad_picks (
  squad_id uuid references squads(id) on delete cascade,
  player_id int references players(id),
  position smallint,              -- 1-15, 12-15 are bench in order
  is_captain bool, is_vice bool,
  primary key (squad_id, player_id)
)

-- The differentiator: what was decided, why, and what else was considered
decisions (
  id uuid primary key default gen_random_uuid(),
  gw smallint,
  kind text,                      -- transfer | captain | chip | hold
  player_in int, player_out int,
  predicted_ep numeric,
  alternatives jsonb,             -- [{ player_id, ep, reason }]
  rationale text,
  source text,                    -- engine | llm | manual
  created_at timestamptz
)

outcomes (
  decision_id uuid references decisions(id) on delete cascade,
  actual_points int,
  best_alternative_points int,
  delta int,                      -- actual - best_alternative
  resolved_at timestamptz,
  primary key (decision_id)
)
```

Index `player_gw_stats(gw)`, `fixtures(gw)`, `decisions(gw)`.

---

## 5. The expected points model

`lib/engine/expected-points.ts`. Pure functions, no I/O, fully unit-tested. This is the heart of the project — treat it as such.

```
EP(player, fixture) =
    P(plays 60+) × 2
  + P(plays 1–59) × 1
  + xG_per90_adj × P(minutes)/90 × goalPoints(position)
  + xA_per90_adj × P(minutes)/90 × 3
  + P(clean sheet) × cleanSheetPoints(position)
  + E(defcon points)
  + E(bonus points)
  − E(goals conceded penalty)      // GK/DEF only
  − E(cards)
```

**Component specs:**

- `xG_per90_adj` — rolling weighted mean over the last 6 gameweeks, weights `[0.25, 0.22, 0.19, 0.15, 0.11, 0.08]`, then multiplied by an opponent adjustment derived from the opponent's defensive strength rating relative to league mean. Early season (GW1–5), blend with prior-season rates using a shrinkage factor that decays linearly to zero by GW6.
- `P(minutes)` — from `chance_of_playing_next_round` when set, otherwise the proportion of recent starts. Hard zero when `status !== 'a'`. This is the highest-leverage input; a great player with 40% minutes probability is worse than a decent nailed one.
- `P(clean sheet)` — Poisson on the opponent's expected goals: `P(0 goals) = exp(-λ)` where λ is derived from the opponent's attack strength versus the player's team defence strength, home/away adjusted.
- `E(defcon)` — 2 × P(hitting threshold), estimated as the player's historical rate of reaching 10 (DEF) or 12 (MID/FWD) defensive actions. Strongly position- and role-dependent; centre-backs and defensive midfielders dominate here.
- `E(bonus)` — historical bonus per appearance × the positional correction factor from §3.

Build a **multi-gameweek EP** function that sums EP over the next N fixtures (default 5), handling doubles (two fixtures in one GW) and blanks (zero). Optimise on this, not on single gameweeks — that is what stops you chasing last week's points.

**Calibration requirement:** `scripts/backtest.ts` replays the model over 2025/26 gameweek by gameweek, using only data available at the time, and reports mean absolute error per position against the naive baseline. Run it with `npm run backtest`, or `-- --neutral` to disable the opponent adjustment. Tune constants against this, not against intuition.

**Result as of the first calibration run (GW7–38, n=25,004):**

| Position | Model MAE | Baseline MAE | |
|---|---|---|---|
| All | 1.010 | 1.038 | beats by 2.6% |
| GK | 0.527 | 0.593 | beats by 11.1% |
| DEF | 1.168 | 1.210 | beats by 3.5% |
| MID | 0.983 | 1.008 | beats by 2.4% |
| FWD | 1.154 | 1.110 | **loses by 3.9%** |

Three things this exposed, all worth keeping in mind before trusting the numbers:

- **Minutes dominate everything.** 62% of player-gameweek rows are non-appearances. The first run *lost* to the baseline by 16.2% purely because a fixed cameo probability was applied to every non-starter, handing appearance points to reserves who had not played in six weeks. Deriving the cameo rate from observed appearances instead moved the model from −16.2% to +2.6% in one change. No other single constant comes close to mattering this much.
- **The opponent adjustment barely earns its place.** Disabling it entirely costs only 0.4pp (2.6% → 2.2%). Either the strength ratings carry little signal or §5's formulation underuses them. Worth revisiting before adding complexity elsewhere.
- **Forwards are still worse than the baseline.** Their scoring is the most goal-dependent and therefore the most skewed, and MAE rewards conservative predictions on skewed distributions. This is the open problem in the model.

The margin overall is real but thin. Treat it as "not worse than doing nothing obvious", not as a validated edge.

---

## 6. The optimiser

`lib/engine/optimiser.ts`. Squad selection is a mixed-integer linear programme solved with `glpk.js` (pure WASM, no Python dependency).

**Import `glpk.js/node`, not the package default** — the default build dispatches to a browser `Worker` and throws in Node.

**Purity.** `lib/engine/**` takes no I/O, and GLPK needs async WASM initialisation. The solver is therefore *injected*: the engine depends only on the `LpSolver` interface in `lib/engine/lp.ts`, and `lib/solver/glpk.ts` adapts glpk.js to it at the boundary. Tests pass a fake. Expected points are likewise an input — the optimiser never computes them, which is what lets it be built and tested before §5 exists.

### Variables

- `x_i` — player *i* is in the fifteen
- `s_i` — player *i* starts

Bench membership is `x_i − s_i`, which keeps every bench rule linear.

### Objective

```
maximise  Σ EP_i · (benchWeight + (1 − benchWeight)·s_i) · x_i
        + priceWeight · Σ expectedPriceDelta_i · x_i
```

`priceWeight` converts tenths of a million into points. Its principled value is the shadow price on the budget constraint — money in the squad is worth exactly what that constraint says it is worth. `PRICE_WEIGHT_DEFAULT` is a static calibration of that; `priceWeight: "auto"` solves the relaxation first, reads the dual, and re-solves. The two are circular, and measuring once breaks the cycle.

`expectedPriceDelta` must be the **realisable** delta from `lib/engine/price-model.ts`, not the raw one. FPL's 50% sell-on fee means you keep half of a rise but bear all of a fall; treating movement symmetrically overvalues risers roughly twofold.

### Constraints

Budget, exact position counts, max 3 per club, valid formation, `s_i ≤ x_i`, and:

**Nailed bench.** At least `MIN_NAILED_BENCH_OUTFIELD` (2) of the three *outfield* bench players must have `P(minutes) ≥ MIN_BENCH_PLAYING_PROB` (0.5).

The goalkeeper bench slot is deliberately excluded. The standard and correct play is a £4.0m non-playing backup keeper, precisely because it frees budget into the XI. Counting the keeper toward the floor would force either a playing backup or all three outfield bench nailed — both of which spend the money this constraint exists to free. Set `BENCH_RULE_INCLUDES_GK` to `true` for the stricter "3 of 4" reading.

**Bench weight** is `0.05` when Bench Boost is inactive and `1.0` when active. Near-zero rather than zero: the bench is not worthless, but valuing it any higher buys bench quality with money the XI should be spending.

### The hit is not a term

Rolling, one transfer, two and three are structurally different problems. Each is solved separately, then compared **after** deducting `4 × (transfers − freeTransfers)`. That is what lets the tool answer "roll it" — rolling wins whenever no move clears the hit it costs. A single programme with a penalty term cannot express this.

### The shadow price

A mixed-integer programme has no duals; duality is LP theory. So there are two solves:

1. the MIP, with `x` and `s` binary, giving the squad;
2. the LP relaxation, with both in `[0,1]`, giving the dual on the budget row.

That dual is `marginalEpPerTenth` — the marginal expected points per £0.1m. It is **non-negative** and **non-increasing in budget**, reaching zero once budget stops binding. Both are asserted in tests.

Three honest caveats, which belong in the UI as well as the code: it is a *local* estimate, whereas the true integer marginal is a step function (an extra £0.1m buys nothing until it crosses a threshold, then buys a whole upgrade); degenerate optima make the dual non-unique; and it moves with the candidate pool.

### Value diagnostics

`lib/engine/frontier.ts` fits, per position, a monotone (isotonic) curve of EP against price and reports each player's vertical distance from it as `valueSurplus`. Positive means more output than the price implies — underpriced.

This is **not** an efficiency frontier in the strict sense. A true frontier is an upper envelope, so nothing sits above it and every surplus would be ≤ 0. What is wanted is a *typical* price-to-output curve, so roughly half the league lands on each side and the number discriminates. The fit is monotone because more expensive players should not be projected to score less, and positions are fitted separately because a £5.0m defender and a £5.0m forward are not competing for the same job.

**It is a diagnostic for the UI and must never enter the objective.** EP is already in the objective and price is already in the budget constraint; adding surplus on top pays twice for the same fact and biases the squad toward cheap players whose EP the model has merely overestimated.

### Price momentum

`lib/engine/price-model.ts` projects price movement from net transfer momentum (`transfers_balance`) scaled against ownership — FPL's change threshold rises with the owner base, so identical flow moves a differential further than a template pick.

Both inputs come from tables that are empty until gameweeks have been played, so the model returns zero with `confidence: "none"` until roughly GW4. Callers must not present that zero as a prediction of no movement.

### Modes

- `suggestTransfers(currentSquad, candidates, freeTransfers, bank)` — best 0/1/2/3-transfer moves ranked by net EP after hits. Must be able to recommend *rolling*.
- `optimalWildcard(budget, horizon)` — unconstrained rebuild.
- `optimalFreeHit(gw)` — single-gameweek rebuild, ignoring future value.
- `bestXI(squad, gw)` — formation and bench order.

### Result contract

Every option returned to `/transfers` carries, at minimum:

| Field | Meaning |
|---|---|
| `epGain` | Raw EP gain over the horizon, before hits |
| `hitCost` | `4 × (transfers − freeTransfers)`, floored at zero |
| `netGain` | `epGain − hitCost` — the number that decides it |
| `costDelta` | Change in squad cost, tenths. Negative frees money |
| `expectedPriceDelta` | Net realisable price movement, tenths, after sell-on |
| `marginalEpPerTenth` | What £0.1m is worth at this squad |

Always return the top 3–5 options with these deltas, not a single answer. The user makes the call; the tool informs it.

---

## 7. Chip strategy engine

`lib/engine/chips.ts`. Rules-based triggers, evaluated weekly, surfaced as advisories with confidence levels.

- **Triple Captain** — fire when a candidate's single-GW EP exceeds a threshold (start at 8.5) *and* it is the season maximum so far, weighted by how few gameweeks remain before expiry. In the second half, prioritise double gameweeks.
- **Bench Boost** — fire when total 15-man EP peaks, typically the week after a Wildcard when the bench was deliberately built strong, or in a double gameweek.
- **Wildcard** — fire on a squad-health score: count of flagged players, players with sub-4.0 EP, and cumulative value lost to price drops. Also flag the gameweek after an international break, when information is richest.
- **Free Hit** — fire on blank gameweeks (detected automatically: count fixtures per team per GW from the `fixtures` table), or when your squad's fixture set for one week is exceptionally bad.

**Expiry pressure:** every advisory carries an urgency score that rises as GW19 approaches. Surface a persistent countdown in the UI. An unused first-half chip is a wasted asset.

---

## 8. LLM layer

`lib/llm/brief.ts`. Single provider-agnostic function:

```ts
generateBrief(context: BriefContext): Promise<string | null>
```

Returns `null` if no key is configured — callers must handle that.

Use `claude-haiku-4-5` for routine weekly briefs (cheap, fast) and `claude-sonnet-5` for the bigger decisions — wildcard drafts and chip calls. Make the model a config constant.

**The context object contains the engine's output, never raw data dumps:** current squad with EPs, top transfer candidates with deltas, captain options with EPs, active chip advisories, flagged players, and the recent decision/outcome record.

**The prompt asks for judgement the maths cannot supply:** reconciling a strong EP with a fitness flag, reading rotation risk around European fixtures, weighing template versus differential given your mini-league position, and explaining the recommendation in plain language.

Cost control: cache the static portion of the system prompt, cap `max_tokens` at 1500, and log token usage per call to a `llm_usage` table so the spend is visible. Expected cost is roughly 2p per brief.

---

## 9. Cron and jobs

`vercel.json` cron entries hitting protected route handlers (verify a `CRON_SECRET` header):

| Route | Schedule | Job |
|---|---|---|
| `/api/cron/sync-static` | Daily 00:15 UK | bootstrap-static + fixtures → DB, snapshot prices |
| `/api/cron/sync-squad` | Daily 06:00 | Your entry, picks, mini-league standings |
| `/api/cron/weekly-brief` | Thu 09:00 | Run engine, generate brief, persist decisions, notify |
| `/api/cron/resolve-outcomes` | Tue 09:00 | Score last gameweek's decisions into `outcomes` |

Notification: start by writing the brief to the DB and rendering it in the UI. Add email later via Resend's free tier if you want a push.

---

## 10. UI routes

| Route | Contents |
|---|---|
| `/` | Dashboard — current GW, deadline countdown, squad EP total, top 3 recommended actions, chip expiry countdown |
| `/squad` | Your 15 in pitch view, per-player EP, next 5 fixtures with difficulty colouring, flag warnings |
| `/transfers` | Ranked transfer options, EP delta, cost after hits, price-change risk, "roll instead" option |
| `/captain` | Captain candidates ranked by EP with the distribution, not just the mean — ceiling matters for captaincy |
| `/chips` | Timeline across 38 gameweeks, chip advisories, blank/double gameweek markers |
| `/history` | Decision journal — what was recommended, what you did, what it returned versus the alternative |
| `/leagues` | Mini-league standings, rival squads, differential analysis (who owns what that you do not) |

---

## 11. Build phases

Each phase ends with a working commit and a passing test run.

**Phase 1 — Foundation (target: before GW1 deadline)**
Scaffold Next.js + Supabase + Tailwind. FPL API client with Zod schemas and typed responses. Migrations for `teams`, `players`, `player_gw_stats`, `fixtures`. `sync-static` route working. `/squad` page rendering your real 15 with basic stats.
*Done when:* your actual squad renders from the database, not from a live API call.

**Phase 2 — Expected points**
The EP model with full unit tests. Backtest script against 2025/26 data. EP surfaced on `/squad` and used to compute best XI and bench order.
*Done when:* backtest MAE is reported per position and the model beats a naive "last 4 gameweeks average" baseline.

**Phase 3 — Optimiser**
glpk.js integration. `suggestTransfers` and `bestXI`. `/transfers` and `/captain` pages.
*Done when:* it correctly recommends rolling a transfer when no move clears the 4-point hit threshold.

**Phase 4 — Chips and calendar**
Blank/double detection from fixtures. Chip advisory engine. `/chips` timeline with the GW19 expiry countdown.

**Phase 5 — Decision journal**
`decisions` and `outcomes` tables wired up. `resolve-outcomes` cron. `/history` page showing cumulative EP delta of followed recommendations.
*Done when:* the app can answer "has this thing actually been right?"

**Phase 6 — LLM brief and live view**
Anthropic integration, weekly brief cron, brief rendered on the dashboard. Live gameweek polling.

**Phase 7 — Portfolio polish**
README with architecture diagram and screenshots. GitHub Actions CI (typecheck, lint, test). Dockerise the sync worker. Terraform module provisioning the Supabase project and Vercel deployment. Deploy and link it.

---

## 12. Conventions

- TypeScript `strict: true`. No `any`. FPL API responses are `unknown` until Zod-parsed.
- Engine code (`lib/engine/**`) is pure — no DB calls, no fetch, no env access. Everything is passed in. This is what makes it testable and what makes the repo read well.
- Money in tenths of a million (integers) throughout, matching the API. Format only at the render boundary.
- Server-side only for all FPL calls. No secrets in client components.
- Conventional commits. One phase per branch, squash-merged.
- Every engine constant lives in a named export in `lib/engine/constants.ts` with a comment explaining its derivation. Magic numbers are the enemy of a tunable model.

---

## 13. Environment

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
ANTHROPIC_API_KEY=
FPL_TEAM_ID=
FPL_LEAGUE_IDS=            # comma-separated mini-league ids
CRON_SECRET=
```

---

## 14. Design brief (for Claude Design)

Paste this when generating the UI:

> A Fantasy Premier League analytics dashboard for a serious manager. Dense with data but calm — this is a decision tool, not a fan site. Dark theme, near-black background with a single accent colour used sparingly for positive expected-points deltas and one warning colour for injury flags and deadline pressure. Numbers are the hero: tabular figures, tight vertical rhythm, no decorative imagery.
>
> Key screens: (1) a dashboard with a deadline countdown, squad EP total, and three recommended actions as cards showing point deltas; (2) a squad pitch view — 15 players in formation, each tile showing name, price, expected points and a five-fixture difficulty strip as small coloured squares; (3) a transfer comparison table with EP gain, cost after hits, and price-change risk; (4) a 38-gameweek chip timeline with blank and double gameweeks marked and a visible expiry countdown.
>
> Avoid: gradients, glassmorphism, oversized hero sections, generic SaaS marketing layout. Think Bloomberg terminal restraint rather than a consumer app.

---

## 15. Immediate next step

> **See `docs/next-steps.md`** for the live working plan — known gaps and the
> optimisation roadmap. This section is the original pre-season intent and is
> kept for the record.


Phase 1, and get data flowing before the Gameweek 1 deadline. Read the deadline from `bootstrap-static.events[]` rather than assuming it. Even if only the sync and the squad page exist by kickoff, you will have started building history — and the per-gameweek history is the asset that makes every later phase possible.
