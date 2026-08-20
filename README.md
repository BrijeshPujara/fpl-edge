# FPL Edge

A data-driven Fantasy Premier League decision engine. It ingests official FPL
data, computes expected points, optimises transfers under FPL's constraints,
tracks every decision against its outcome, and produces a weekly brief.

`docs/data-and-calculations.md` answers what data goes in, what is computed
from it, and whether the FPL API is sufficient. Short answer to the last one:
yes, and the app is not yet using all of it — `element-summary/{id}` carries
four seasons of prior history that the model's shrinkage schedule is currently
blending toward `null`.

**[How the engine thinks](https://claude.ai/code/artifact/33678294-5060-4a74-8f0a-84faed44b8c5)**
— a plain-English explanation of what the engine is for and how it calculates,
written for someone who does not read code. Source at
`docs/engine-explainer.html`; republish that file passing the URL above as
`url` to update the page in place rather than creating a second one.

The full specification is in [PLAN.md](./PLAN.md). This README covers only how
to run what exists.

## Architectural rule

The deterministic engine — the expected-points model and the optimiser — must
work with no LLM key present. The LLM is a presentation layer that explains
numbers the engine has already computed. If `ANTHROPIC_API_KEY` is unset, the
app renders the raw analysis and skips the commentary.

Two conventions follow from that and are worth stating up front:

- **`lib/engine/**` is pure.** No database calls, no `fetch`, no environment
  access. Everything is passed in. This is what makes the model testable and
  what makes the backtest possible.
- **Money is an integer in tenths of a million** everywhere, matching the API.
  It becomes a `£` string only in `lib/format.ts`.

## Routes

Every screen belongs to a manager and lives under their entry id:

```
/                      landing — how it works, and the way in
/?switch=1             the landing page, forcing the team-id form
/t/{entryId}           dashboard
/t/{entryId}/squad     pitch view
/t/{entryId}/transfers ranked options
/t/{entryId}/chips     timeline and plan
/preview/*             dev-only harness, no manager behind it
```

**There is no sign-in, and there is not going to be one.** An FPL entry id is
public: `entry/{id}/` is unauthenticated and the FPL site reads it for every
mini-league table. A password would protect nothing and imply the opposite.

`/` explains what the tool does and offers a way in. A known team — the
`fpl_entry` cookie first, then `FPL_TEAM_ID` — becomes a button rather than a
redirect. It used to redirect automatically, which made the landing page
invisible to everyone arriving for the first time; one click is worth the page
existing. The cookie outranks the environment on purpose: a configured
`FPL_TEAM_ID` is the deployment's default, not a lock.

Entering an id looks the manager up once, registers them in `entries`, pulls
their squad, and redirects. `registerEntry` will not re-ask the FPL API about
the same manager within fifteen minutes, which is what stops a refreshed page
turning into traffic on someone else's server.

## Running it

```bash
npm install
cp .env.example .env.local   # fill in what you have; the app degrades without it
npm run dev
```

`npm run check` runs the typecheck, the linter and the test suite. That is the
gate each build phase has to pass.

## What works today

| Area | State |
|---|---|
| FPL API client, Zod-validated | Working |
| Gameweek / deadline resolution | Working — read from `bootstrap-static.events[]` |
| Chip windows | Working — read from `bootstrap-static.chips[]` |
| Blank and double gameweek detection | Working — counted from the fixture list |
| Chip timeline (`/chips`) | Working |
| Database schema | Applied — 17 tables, RLS enabled |
| `sync-static` cron route | Working — 20 teams, 595 players, 380 fixtures, daily price and transfer snapshots |
| `sync-squad` cron route | Built — waits for the first deadline |
| `sync-results` cron route | Built — waits for a `data_checked` gameweek |
| Free-transfer accounting | Working — derived, since the API does not report it |
| Prior-season rates | Working — `history_past`, 346 players, feeds the GW1–6 shrinkage |
| Expected-points model | Working — beats the naive baseline by 2.6% over 2025/26; loses on forwards |
| Set-piece and penalty duty | Working — synced and priced, without double-counting penalty xG |
| Squad optimiser | Working — MIP for the fifteen, LP relaxation for the budget shadow price |
| Transfer suggestions | Working — each transfer count pinned by a retention floor |
| Chip planner | Working — assignment problem over chips and gameweeks |
| Price momentum | Capturing daily; reports no confidence until roughly GW4 |
| Landing page (`/`) | Working — what it does, what data it uses, and its limits |
| Multi-manager routing | Working — `/t/{entryId}`, no sign-in, registered on demand |
| Mini-leagues (`/leagues`) | Working — discovered from your entry, no configuration |
| Dashboard (`/t/{entryId}`) | Working — this week's actions ranked by what the decision is worth |
| `/transfers` screen | Working — ranked options with the roll always offered |
| `/chips` screen | Working — timeline, plan, expiry pressure |
| LLM brief | Not built — see PLAN.md §8 |

Both decision screens gate on whether any gameweek has been played. Until one
has, every projection is the same positional prior, so they explain that rather
than ranking noise. That gate is `projectable` on the candidate pool, and it is
the single most important line of code on either screen.

### Seeing the screens before the season starts

That gate means nobody can watch the decision screens work until real results
exist. `/preview/squad`, `/preview/transfers` and `/preview/chips` fill the gap
in development:

```bash
npm run backtest   # once, to populate .backtest-cache/
npm run dev        # then open /preview
```

The preview replays **real 2025/26 results**, matched onto this season's players
by name — around three quarters match, and the rest are new signings and
promoted-club players who genuinely have no Premier League history, so the model
rating them low is correct rather than a gap. Fixtures and prices are this
season's; the squad is invented, picked on last season's points the way a person
would rather than on the model's own expected points, so the optimiser has real
disagreements to show.

Three fences keep it out of the running app: `app/preview/layout.tsx` returns a
404 when `NODE_ENV` is production, nothing under `lib/preview/` writes to the
database, and every preview page carries a banner saying what it is. The real
routes never import from `lib/preview/`, so there is no flag to leave switched
on by accident.

Screens whose engine does not exist yet render an explicit "awaiting phase N"
state. They never render placeholder numbers: a decision tool that displays an
invented expected-points figure is worse than one that displays nothing.

## Database

Supabase project `ehfuwpslwzxsjjaatgng`. All seven migrations in
`supabase/migrations/` are applied.

**Reads over 1000 rows must page.** PostgREST caps a response at 1000 rows and
does so silently — no error. `fetchAll` in `lib/db/queries.ts` exists for that,
and season history, recent stats and transfer snapshots all use it. A new query
that can exceed a thousand rows and does not page will not fail; it will just
make the model quietly worse.

**Access is server-side only, and the schema enforces it.** Every table has RLS
enabled with *no policies* — a deliberate deny-all. The publishable key can read
and write nothing, so all access goes through `SUPABASE_SERVICE_ROLE_KEY`, which
bypasses RLS. `lib/db/client.ts` imports `server-only`, so a mistaken client
import is a build error rather than a leaked credential.

Supabase's linter reports `rls_enabled_no_policy` at INFO level for all
seventeen tables. That is the intended state, not a gap to close. If a screen ever needs
to query from the browser, add a narrow policy for that one table — do not
disable RLS.

After changing a migration, regenerate the types:

```bash
npm run db:types
```

`lib/db/types.generated.ts` is generated. If it disagrees with
`supabase/migrations/`, the migrations are the truth and the file is stale.

### Running the sync

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  http://localhost:3000/api/cron/sync-static | jq
```

It is idempotent — running it twice changes nothing but `updated_at`. Prices are
snapshotted only when they actually move, so `price_history` stays a record of
changes rather than 250,000 rows of unchanged daily readings.

Transfer counters follow the opposite policy, deliberately: a row per player per
day whether anything moved or not. They are season-cumulative, and the momentum
series is recovered by differencing consecutive days — which needs the days
where nothing happened. See `supabase/migrations/0003_transfer_snapshots.sql`.

`/api/cron/sync-squad` does the same for your own team. It returns 200 with
`status: "no-picks-yet"` until a gameweek deadline has passed, because
`entry/{id}/event/{gw}/picks/` does not exist before then.

**Free transfers are derived, not fetched.** The API reports transfers *made*
per gameweek and the chip played; the remaining balance is reconstructed in
`lib/engine/free-transfers.ts` — pure and unit-tested, because it decides
whether a move is free or costs four points.

On a schedule this runs from GitHub Actions rather than Vercel Cron — see
`docs/cron.md` for why, and for what to change if you move to Vercel Pro.

## Where this is going

`docs/next-steps.md` is the working plan: known gaps that are real defects, and
an optimisation roadmap ordered by payoff. Start there rather than at PLAN.md
§11 if you are picking the work up cold — PLAN.md is the spec, that file is the
state.

`docs/multi-user-and-ai.md` answers two questions deliberately: what it takes to
let anyone use this with their own team ID (much less than you would think — an
FPL team ID is public, so there is no login to build), and what an LLM can
genuinely contribute (one thing, and it is not picking the squad).

## Data source notes

All data comes from the official unauthenticated API at
`https://fantasy.premierleague.com/api/`. Three things about it shape the code:

1. **It is CORS-blocked in the browser.** Every call is server-side.
   `lib/fpl/client.ts` imports `server-only` so a mistaken client import fails
   at build time rather than at runtime.
2. **It rejects some default fetch user-agents.** The client sends a normal
   browser UA.
3. **It is untyped and changes shape occasionally.** Every response is
   `unknown` until it passes a Zod schema. Unknown fields are ignored; missing
   known fields are fatal. A season of quietly-corrupted history is
   unrecoverable, so we fail loudly instead.

Two endpoint choices worth knowing:

- Per-gameweek history is built from `event/{gw}/live/`, which returns every
  player's stats in one response — 38 calls for a season, against roughly 700
  to `element-summary/`.
- `entry/{id}/event/{gw}/picks/` returns 404 until that gameweek's deadline has
  passed. Before the first deadline there is genuinely no public squad to
  render; `getEntryPicksIfAvailable` treats that as a state, not an error.

## Design

`design/fpl-terminal.dc.html` is the Claude Design canvas this UI is built
from. It is a vendored reference, excluded from linting, and it is the source
of truth for the visual system — every colour, type size and border weight in
`app/globals.css` was extracted from it. If a value in the code disagrees with
the canvas, the canvas wins.

The canvas contains mock data. None of it belongs in the running app.

## Layout

```
app/                 routes — one per screen in PLAN.md §10
components/chrome/   masthead, tabs, countdown
components/ui/       panels, rows, fixture strips — the design primitives
lib/rules.ts         rules of the game (squad size, scoring, hit cost)
lib/engine/          the model — pure functions, no I/O
lib/fpl/             API client, Zod schemas, gameweek resolution
lib/format.ts        the render boundary — the only place £ appears
lib/db/              Supabase client, sync, generated types — server-only
lib/cron/            shared-secret auth for the cron routes
app/api/cron/        scheduled jobs
supabase/migrations/ schema
tests/               Vitest, engine and pure logic only
design/              vendored Claude Design canvas
```

The split between `lib/rules.ts` and `lib/engine/constants.ts` is deliberate:
rules change once a season by decree, constants change whenever the backtest
says so.
