# FPL Edge

A data-driven Fantasy Premier League decision engine. It ingests official FPL
data, computes expected points, optimises transfers under FPL's constraints,
tracks every decision against its outcome, and produces a weekly brief.

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
| Database schema | Applied — 11 tables, RLS enabled |
| `sync-static` cron route | Working — 20 teams, 595 players, 380 fixtures synced |
| `sync-squad` cron route | Built — waits for the first deadline |
| Free-transfer accounting | Working — derived, since the API does not report it |
| EP model, optimiser, brief | Not built — see PLAN.md phases 2–6 |

Screens whose engine does not exist yet render an explicit "awaiting phase N"
state. They never render placeholder numbers: a decision tool that displays an
invented expected-points figure is worse than one that displays nothing.

## Database

Supabase project `ehfuwpslwzxsjjaatgng`. The schema in
`supabase/migrations/0001_core_schema.sql` is applied.

**Access is server-side only, and the schema enforces it.** Every table has RLS
enabled with *no policies* — a deliberate deny-all. The publishable key can read
and write nothing, so all access goes through `SUPABASE_SERVICE_ROLE_KEY`, which
bypasses RLS. `lib/db/client.ts` imports `server-only`, so a mistaken client
import is a build error rather than a leaked credential.

Supabase's linter reports `rls_enabled_no_policy` at INFO level for all eleven
tables. That is the intended state, not a gap to close. If a screen ever needs
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

`/api/cron/sync-squad` does the same for your own team. It returns 200 with
`status: "no-picks-yet"` until a gameweek deadline has passed, because
`entry/{id}/event/{gw}/picks/` does not exist before then.

**Free transfers are derived, not fetched.** The API reports transfers *made*
per gameweek and the chip played; the remaining balance is reconstructed in
`lib/engine/free-transfers.ts` — pure and unit-tested, because it decides
whether a move is free or costs four points.

On a schedule this runs from GitHub Actions rather than Vercel Cron — see
`docs/cron.md` for why, and for what to change if you move to Vercel Pro.

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
