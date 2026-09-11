# FPL Edge

A Fantasy Premier League decision engine. It forecasts what every player is
worth, solves for the best squad the budget allows, and shows the number behind
every recommendation — including when the recommendation is to do nothing.

Built for one manager, usable by anyone with a team id. No sign-in: an FPL team
id is public data, not a credential.

![The dashboard](docs/screenshots/dashboard.jpg)

*Ranked by what the decision is worth, not by the biggest number. Haaland's 8.2
is the largest figure on the screen, but Enzo sits at 6.0 behind him — so the
armband is worth +4.5 and ranks third.*

*Captured from the preview harness before the live-points and scorelines panels
were added; the ranking logic it illustrates is unchanged.*

---

## Only two questions

Fantasy football is a shopping problem wearing a football shirt. £100m, fifteen
players, eleven of whom score. There are exactly two questions in it, and
keeping them apart is the whole design:

1. **What is each player worth?** A forecasting problem. The answer is an
   average across every way the match could go — never a prediction that
   someone *will* score.
2. **Given that, which fifteen should I own?** A shopping problem. Not the
   fifteen highest scorers; the best *combination* inside the budget and the
   squad rules. About 2.8 × 10²⁷ legal squads, so it is solved rather than
   searched.

Most tools mash the two together and end up recommending whoever did well last
Saturday.

---

## Architecture

```mermaid
flowchart TB
    subgraph external["Outside"]
        FPL["FPL API<br/><i>unauthenticated</i>"]
        LLM["Anthropic API<br/><i>optional</i>"]
    end

    subgraph jobs["Scheduled jobs — GitHub Actions"]
        direction LR
        J1["02:00 static<br/>prices, transfers"]
        J2["06:00 squad<br/>your picks"]
        J3["08:00 results<br/>played gameweeks"]
        J4["09:00 journal<br/>record + score"]
        J1 --> J2 --> J3 --> J4
    end

    DB[("Postgres — Supabase<br/>RLS deny-all, service role only")]

    subgraph engine["lib/engine — pure, no I/O"]
        direction TB
        MIN["minutes.ts<br/><i>the dominant input</i>"]
        EP["expected-points.ts"]
        DIST["distribution.ts<br/><i>shape, not centre</i>"]
        OPT["optimiser.ts<br/><i>MIP + LP dual</i>"]
        RAT["team-ratings.ts<br/><i>Poisson attack/defence</i>"]
        SCORE["scoreline.ts<br/><i>joint goal grid</i>"]
        MIN --> EP
        EP --> DIST
        EP --> OPT
        RAT --> SCORE
    end

    subgraph screens["Screens — Next.js, server-rendered"]
        direction LR
        S1["/squad"]
        S2["/transfers"]
        S3["/captain"]
        S4["/chips"]
        S5["/history"]
    end

    FPL -->|"sync"| jobs
    jobs -->|"upsert"| DB
    DB -->|"rows"| engine
    engine -->|"projections"| screens
    J4 -.->|"context"| LLM
    LLM -.->|"prose only"| DB

    FPL ==>|"read-time overlay<br/>flags · live scores · results"| screens

    GLPK["glpk.js<br/><i>WASM solver</i>"] -.->|"injected"| OPT
```

<!--
  Deliberately unstyled. GitHub renders Mermaid in the READER's theme, and
  hardcoded fills only work in one of them — dark subgraph fills rendered as
  dark-on-dark, unreadable, for anyone on light mode. The default theme adapts.
-->

Three rules hold the shape:

**`lib/engine/**` is pure.** No database, no `fetch`, no environment. Everything
is passed in and everything comes back as a value. That is what makes the model
unit-testable and what makes `scripts/backtest.ts` able to replay a whole season
through it. The solver is WASM and needs async init, so it is injected through
an interface rather than imported.

**The LLM never touches the objective.** It receives numbers the engine has
already computed and is forbidden from inventing or recomputing any. With no
API key the engine works exactly as before and the brief simply does not render.

**Game rules and model constants are different things.** `lib/rules.ts` holds
facts about FPL — goal points, budget, hit cost — and is never tuned.
`lib/engine/constants.ts` holds tunables, each with a comment on where the
number came from, tuned against the backtest rather than intuition.

**Stored rows are history; anything you are looking at now is read live.** The
sync writes once a day, which is right for building a record and wrong for
three things that move faster than that: fitness flags, live scores, and
results. All three are overlaid at read time from `bootstrap-static` — which
every page already fetches — rather than served a day late from our own tables.
The stored row stays a record of what the sync saw, so the history built on it
never rewrites itself. That thick arrow on the diagram is the whole idea.

---

## What is built

### Screens

| Screen | What it does |
|---|---|
| `/` | Landing page — what it does, the data, the calculations, and the limits |
| `/t/{id}` | This week's actions, live score, and the scoreline board |
| `/t/{id}/squad` | Pitch view — live points and projected EP side by side, difficulty strips, flags |
| `/t/{id}/transfers` | Roll / 1 / 2 / 3 moves, each with gain, hit, net, and the budget shadow price |
| `/t/{id}/captain` | The outcome *distribution* — haul, blank, ceiling, floor |
| `/t/{id}/chips` | 38-week timeline, and which gameweek to play each chip |
| `/t/{id}/history` | Decisions recorded before the deadline, scored after |
| `/t/{id}/leagues` | Mini-leagues, discovered from your entry |
| `/preview/*` | Dev-only harness — 404s in production |

Two panels on the dashboard are worth calling out because they answer different
questions from everything else:

**Live points** is the only screen here about the present rather than the next
decision. It exists because the stored results deliberately lag — `syncResults`
waits for the API to report both `finished` and `data_checked`, typically the
Monday after — which is correct for a decision journal and useless while you
are watching a match. It applies no autosubs and no vice-captain promotion,
matching what the official site shows live rather than what Monday's table will
say. Bonus in an unfinished match is provisional, worked out from the BPS
standings, and marked as such.

**Scorelines** predicts every fixture in the gameweek, but only when you press
the button. That is deliberate: predictions are *recorded* and scored against
the results, and a record that writes itself on every page view is not a record
of anything. Nothing can be predicted after kickoff — the store refuses it — so
the row that survives a whistle is the last thing the model said while it could
still be wrong.

### The engine

| Module | What it solves |
|---|---|
| `minutes.ts` | Will he play? The highest-leverage input in the project |
| `expected-points.ts` | Appearance, xG, xA, clean sheets, defcon, bonus, cards |
| `set-pieces.ts` | Penalty and corner duty, without double-counting penalty xG |
| `prior-season.ts` | Last season's rates, for the gameweeks before form exists |
| `news-signal.ts` | What team news says that the percentage does not |
| `distribution.ts` | The shape of an outcome, by convolution |
| `captain.ts` | Because doubling is linear and cannot change a ranking by mean |
| `optimiser.ts` | MIP for the fifteen, LP relaxation for what £0.1m buys |
| `transfers.ts` | Each transfer count pinned by a retention floor, compared after hits |
| `chips.ts` | Chip timing as a bipartite assignment, not a threshold |
| `best-xi.ts` | Eleven from fifteen, by enumeration — seven legal formations |
| `free-transfers.ts` | Derived, because the API never reports it |
| `price-model.ts` | Price movement from transfer momentum, halved for the sell-on fee |
| `frontier.ts` | Isotonic value curve — a diagnostic that must never enter the objective |
| `scoreline.ts` | Match scorelines as a joint distribution, with proper scoring rules |
| `team-ratings.ts` | Poisson attack and defence, fitted by MLE, with recency weighting |
| `../squad/live.ts` | What the squad is scoring right now, provisional bonus included |

556 tests. `npm run check` runs typecheck, lint and the suite.

---

## Screens

### Scorelines — a distribution, not a prediction

The obvious shape for a score predictor is a function returning 2-1, and it is
the wrong shape. Measured over 280 held-out matches, a model that knows
**nothing** — league-average rate for both sides, every team identical — names
the exact scoreline 13.2% of the time, because it always says 1-1 and 1-1 is
the most common Premier League result. Every model that actually knows
something about the teams scores *worse* on that measure. Ranking by exact-score
accuracy selects for ignorance.

So the panel shows three probabilities and, under each, the scoreline that
result averages out at. Three decisions behind that, each measured rather than
assumed:

**The mean, not the mode.** Goals are right-skewed, so the most likely single
scoreline sits below the average one. Of real home wins, 49% had the winner
scoring three or more; the modal scoreline produced a 3+ result in 2% of them,
and understated the winning margin by a third every time (1.29 against an actual
1.93). The conditional mean is near-unbiased at 1.85.

**One scoreline per result, not the three likeliest overall.** The three
likeliest are marginally better as a set — right 30.9% against 27.1% — and
unusable, because the leading one is 1-1 in 74.6% of fixtures. "1-1" beside
"61% home win" reads as broken even when both numbers are right.

**A prior fitted on three seasons, and a measured promoted prior.** The
promoted-side estimate used to be the average of the clubs they replaced, which
sounds reasonable and is not: each year's guess came from the previous year's
relegated cohort, so it walked rather than converged, and by 2025/26 it had
drifted to 0.63 attack against a promoted group averaging 0.81.

Every prediction is stored before kickoff and scored after, by ranked
probability score and log loss. Both, because they disagree informatively — a
model improving on RPS while worsening on log loss has become better calibrated
about who wins and more reckless about how sure it is.

### Captain — the one that is genuinely different

![Captaincy](docs/screenshots/captain.jpg)

Every other screen ranks on expected points. Doubling is linear, so it cannot
change which player has the highest mean — "highest EP" is only the right
captain if you are indifferent to risk. Defending a lead wants the highest
floor; chasing wants the fattest tail. The shape bar is blank / ordinary / haul.

### Transfers

![Transfers](docs/screenshots/transfers.jpg)

Every transfer count is its own solve, pinned by a retention floor, compared
*after* the four-point hit. Rolling needs no solve at all and is always offered.

**It will not spend points on a difference it cannot see.** While projections
rest on last season, no option that costs a hit is recommended — a hit is a
certain four points against a gain resting on how someone was used a year ago.
Free transfers are untouched, because that asymmetry is the argument: a free
move that turns out wrong costs only the move. The move it declined is still
computed, still shown, and still says what it was worth; hiding it would be a
different kind of dishonesty. The guard lifts on its own once real minutes
arrive.

### Squad

![Squad](docs/screenshots/squad.jpg)

### Landing

![Landing](docs/screenshots/landing.jpg)

*Screenshots are from the dev preview harness — real players, real fixtures,
last season's form replayed as gameweek eight.*

---

## Running it

```bash
npm install
cp .env.example .env.local   # fill in what you have; the app degrades without it
npm run dev
```

`npm run check` runs the typecheck, the linter and the test suite.

### Tools

| Command | What it answers |
|---|---|
| `npm run pick` | What fifteen would the optimiser buy from a clean £100m? |
| `npm run seed-ratings` | Fit team ratings from the last three seasons and store them |
| `npm run backtest` | Replay 2025/26 through the model against a naive baseline |
| `npm run backtest:squad` | Replay SELECTION: buy a squad each gameweek and score it |
| `npm run brief:check` | Exercise the LLM brief without a squad |
| `npm run ep:smoke` | Sanity-check expected points end to end |

`scripts/rate-squad.ts` and `scripts/predict-gw.ts` take arguments rather than
having aliases — the first scores a squad someone actually picked against what
the optimiser would have bought, the second prints the gameweek's scoreline
board to a terminal.

The two that read `.backtest-cache/` need `npm run backtest` to have run once;
the directory is gitignored, so on a fresh clone they fail until it has.

### Seeing the screens before a gameweek exists

Every ranked screen refuses to rank until the model has something to tell
players apart with. To see them working before then:

```bash
npm run backtest   # once, to populate .backtest-cache/
npm run dev        # then open /preview
```

The preview replays **real 2025/26 results**, matched onto this season's players
by name — around three quarters match, and the rest are new signings and
promoted-club players who genuinely have no Premier League history. Fixtures and
prices are this season's; the squad is invented, picked on last season's points
the way a person would, so the optimiser has real disagreements to show.

Three fences keep it out of production: `app/preview/layout.tsx` returns 404
when `NODE_ENV` is production, nothing under `lib/preview/` writes to the
database, and every preview page carries a banner. The real routes never import
from `lib/preview/`.

### Checking the brief

```bash
npm run brief:check                  # the real call, against the preview
npm run brief:check -- --prompt-only # what would be sent, without sending it
```

The dry run is the fastest way to audit exactly what the model is and is not
told — which matters, because the whole safety argument is that it only ever
sees numbers the engine already computed.

---

## Routes and sign-in

```
/                      landing — how it works, and the way in
/?switch=1             the landing page, forcing the team-id form
/t/{entryId}           dashboard, squad, transfers, captain, chips, history, leagues
/preview/*             dev-only harness
```

**There is no sign-in, and there is not going to be one.** An FPL entry id is
public: `entry/{id}/` is unauthenticated and the FPL site reads it for every
mini-league table. A password would protect nothing and imply the opposite.

`/` resolves a team from the `fpl_entry` cookie, then `FPL_TEAM_ID`. The cookie
wins on purpose — a configured team id is the deployment's default, not a lock.

### Where the keys go

| | Supabase pair | `FPL_TEAM_ID` | `ANTHROPIC_API_KEY` |
|---|---|---|---|
| `.env.local` | yes | optional | to run `brief:check` |
| GitHub Actions | yes | yes | to write the brief |
| **Vercel** | **yes** | optional | **no** |

Briefs are *written* by the sync job and *read* by the app. Those are different
processes on different machines, and the app has no use for a key.

---

## Scheduled jobs

Four, on GitHub Actions rather than Vercel Cron — see `docs/cron.md` for why.
The order is not arbitrary:

| UTC | Job | Needs |
|---|---|---|
| 02:00 | `static` | after the 01:30 UK price change, in both BST and GMT |
| 06:00 | `squad` | — |
| 08:00 | `results` | late enough that bonus is confirmed and `data_checked` is set |
| 09:00 | `journal` | the squad, the day's prices, *and* results |

`journal` runs last because it does two things whose inputs differ: it records
what the engine advises for the gameweek still **open**, and it scores decisions
for gameweeks whose results have landed.

Recording only ever happens for the open gameweek. A recommendation written
after a deadline is hindsight wearing a timestamp, and a journal containing any
of those cannot be used to judge anything.

`npm run sync -- history` is manual: it pulls four seasons of per-player history
and skips anyone already recorded, so the first run is ~600 requests and every
run after it is a handful.

---

## Database

Supabase project `ehfuwpslwzxsjjaatgng`. All thirteen migrations in
`supabase/migrations/` are applied.

**Access is server-side only, and the schema enforces it.** Every table has RLS
enabled with *no policies* — a deliberate deny-all. The publishable key can read
and write nothing, so all access goes through `SUPABASE_SERVICE_ROLE_KEY`, which
bypasses RLS. `lib/db/client.ts` imports `server-only`, so a mistaken client
import is a build error rather than a leaked credential.

Supabase's linter reports `rls_enabled_no_policy` at INFO level for every table.
That is the intended state, not a gap to close.

**Reads over 1000 rows must page.** PostgREST caps a response at 1000 rows and
does so *silently* — no error, no flag. `fetchAll` in `lib/db/queries.ts` exists
for that, and season history, recent stats, transfer snapshots, gameweek points
and price history all use it. A new query that can exceed a thousand rows and
does not page will not fail; it will quietly make the model worse.

**Two tables store a claim rather than only a number.** `predictions` carries
`score_method` and `team_ratings` carries `prior_seasons`, so a row written
under one version of the model still describes itself correctly after the model
changes. That exists because the scorelines panel stated something false three
times in one day — a caption that assumed a fact instead of reading one, with
nothing able to notice when the fact changed. Captions are now derived from
stored values, and adding a new summary without writing its caption does not
compile.

`team_ratings` also keeps `prior_attack` / `prior_defence` untouched by any
refit. Each refit blends against **last season**, never against what the
previous refit wrote — feeding the output back in compounds, walking the
ratings away from both seasons with nothing able to detect it.

After changing a migration, regenerate the types with `npm run db:types`.

---

## Data

Everything comes from the official unauthenticated API at
`https://fantasy.premierleague.com/api/`. No scraping, no paid feed.

`docs/data-and-calculations.md` lists every field consumed, what each is used
for, and — as usefully — the fields deliberately ignored and why. It also
answers whether the FPL API is sufficient. Short version: yes, and the most
valuable thing found was four seasons of history sitting in an endpoint the app
was not calling.

Three things about the API shape the code:

1. **It is CORS-blocked in the browser.** Every call is server-side.
   `lib/fpl/client.ts` imports `server-only`.
2. **It rejects some default fetch user-agents.** The client sends a browser UA.
3. **It is untyped and changes shape.** Every response is `unknown` until it
   passes a Zod schema. Unknown fields are ignored; missing known fields are
   fatal. A season of quietly-corrupted history is unrecoverable.

Two endpoint choices worth knowing:

- Per-gameweek history comes from `event/{gw}/live/`, which returns every
  player's stats in one response — 38 calls a season against roughly 700 to
  `element-summary/`.
- `entry/{id}/event/{gw}/picks/` returns 404 until a deadline has passed. That
  is a state, not an error, and `getEntryPicksIfAvailable` treats it as one.

---

## Honest state

The model **beats a naive baseline by 2.6%** over the 2025/26 season and
**loses to it on forwards** by 3.9%. That is a real edge and a thin one.

It has now run against a live gameweek. The first scored prediction — Arsenal
3-0 Coventry, called 3-0 — was right, which means nothing yet. The decision
journal is the only thing that will eventually answer whether any of this beats
a manager's own judgement, and it accumulates one gameweek a week regardless of
how much else gets built.

**Everything improves on a schedule, and the schedule is in the code:**

| Gameweek | What changes |
|---|---|
| any stats land | `basis` flips to `this-season`; the transfer hit guard lifts |
| ~4 | price momentum starts fitting; before then it reports `confidence: "none"` |
| 5 | a player's own DefCon rate replaces the positional average |
| **6** | **last season stops counting** — shrinkage runs 0.7 to 0 linearly |
| 7 | the form window is fully populated — it needs six gameweeks |
| ~15 | team ratings are fully on this season; promoted sides stop using a prior |

The slowest is deliberate. Team ratings take fifteen matches a club rather than
six, because twenty clubs share 380 matches and that is far less evidence per
parameter than a single player's own minutes. Measured, not assumed.

**Where it is weakest until then.** Promoted sides have no rating at all and
carry the measured average of what promoted sides do — every scoreline
involving one is marked `?`. Anyone who moved clubs this summer has no Premier
League history, gets the flat starting prior, and will essentially never be
recommended. Both resolve by playing.

---

## Where this is going

`docs/next-steps.md` is the working plan: known gaps that are real defects, and
an optimisation roadmap ordered by payoff. Start there rather than at PLAN.md
§11 if you are picking the work up cold — PLAN.md is the spec, that file is the
state.

`docs/multi-user-and-ai.md` answers two questions deliberately: what it takes to
let anyone use this with their own team id, and what an LLM can genuinely
contribute — one thing, and it is not picking the squad.

**[How the engine thinks](https://claude.ai/code/artifact/33678294-5060-4a74-8f0a-84faed44b8c5)**
is the same explanation for someone who does not read code.

---

## Layout

```
app/                 routes — /, /t/[entryId]/*, /preview/*, /api/cron/*
components/          chrome, ui primitives, and one board per screen
lib/rules.ts         rules of the game — never tuned
lib/engine/          the model — pure functions, no I/O
lib/squad/           rows to projections — the one conversion everything shares
lib/fpl/             API client, Zod schemas, gameweek resolution
lib/db/              Supabase client, sync jobs, generated types — server-only
lib/llm/             the brief — returns null with no key
lib/preview/         dev-only harness
lib/format.ts        the render boundary — the only place £ appears
supabase/migrations/ schema
tests/               Vitest — engine and pure logic only
design/              vendored Claude Design canvas, the visual source of truth
```

`design/fpl-terminal.dc.html` is the source of truth for the visual system —
every colour, type size and border weight in `app/globals.css` came from it. If
a value in the code disagrees with the canvas, the canvas wins.
