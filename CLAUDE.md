@AGENTS.md

# FPL Edge

A Fantasy Premier League decision engine. A deterministic model projects points,
a MILP picks the optimal squad, and a journal records what was advised before
each deadline so the advice can be scored afterwards. Next.js 16 + Supabase.

## Five invariants

These are load-bearing. Each one has already been broken once, and in every case
the breakage was silent — the code compiled, the tests passed, and the screen
showed a plausible number that was wrong. Read the rule before changing anything
near it.

### 1. The engine must work with no `ANTHROPIC_API_KEY`

The LLM is the optional half of every screen. `lib/llm/client.ts` returns `null`
when there is no key, on any API failure, and on an empty response; every caller
renders its numbers regardless. A missing key is a **configuration state, not an
error**.

Never make a code path depend on the model succeeding. Never throw from
`lib/llm/`.

### 2. The LLM never computes a number and never decides anything

`lib/llm/brief.ts` receives numbers the deterministic engine has already
produced, and its job is judgement and plain English. It cannot out-pick a
mixed-integer programme that solved the problem exactly, and the system prompt
forbids it from inventing, recomputing or contradicting.

If a feature needs the model to choose, the correct shape is **model translates
intent into constraints, solver decides** — never model decides.

Measured: `npm run eval:brief`. See `evals/brief/README.md`.

### 3. Record only the gameweek that is still OPEN

`lib/db/sync-journal.ts` writes recommendations for the current gameweek before
its deadline, and never for one that has passed. A recommendation written after
a deadline is hindsight wearing a timestamp, and a journal containing even one
of them cannot be used to judge anything.

Recording upserts on `(entry_id, gw, kind)`, so the surviving row is the last
advice given before the deadline. Resolving is separate and happens only once
results have landed. Do not merge the two.

### 4. Stored rows are history; anything current is read live

The sync writes a daily snapshot. That is right for prices and fixtures and
**wrong for anything that changes within a day** — fitness flags, live scores,
results in progress.

Pedro Porro read `status=a` from a 02:52 sync while the API said `status=i,
"Expected back 29 Aug"`. Twenty-one hours in which an injured player was
projected as a starter and stayed a legitimate transfer target — with the fresh
data already in memory, because every page fetches `bootstrap-static` anyway.

Read-time overlays live in `lib/fpl/availability.ts` and `lib/fpl/live-context.ts`
and deliberately **do not write back**: the stored row records what the sync saw,
and the history built on it stays honest.

Related: key live views on the gameweek `in play`, not the `target` gameweek —
`target` advances the moment the current one kicks off.

### 5. A missing known field in a schema is fatal ON PURPOSE

`lib/fpl/schemas.ts` validates every API response. Unknown fields are ignored,
so additions upstream are harmless. Fields we use are **required**, so removals
upstream throw. That asymmetry is deliberate: a season of quietly-corrupted
history is unrecoverable.

**Do not make a field optional to stop a throw.** FPL dropped `id` from league
standings rows mid-season; the schema threw, a downstream `.catch(() => null)`
turned it into "standings could not be fetched", and it read as an outage for
days. The fix was to distinguish the two failures on screen, not to loosen the
schema.

When a parse throws, the schema needs updating to match the new shape — that is
our bug, and it must stay loud.

## Working here

```
npm run check        # typecheck + lint + tests. The gate. Run before finishing.
npm test             # vitest
npm run backtest     # replay the EP model over a season vs a naive baseline
npm run backtest:squad # replay SELECTION — does it pick well, not just predict well
npm run eval:brief   # grade recorded briefs for groundedness (free, no key)
npm run ep:smoke     # rank every player; catches "GK above Haaland" bugs
npm run db:types     # regenerate lib/db/types.generated.ts after a migration
```

- **Constants carry their evidence.** Every value in `lib/engine/constants.ts`
  has the sweep table that produced it in a comment. Add one the same way, or
  it is decoration.
- **A migration is not done until `npm run db:types` has run.**
- **Comments explain why, not what** — particularly why an obvious-looking
  alternative was rejected. Match the surrounding density.
- Claims in UI copy about how the model works are tested
  (`tests/scoreline-panel-claims.test.ts`). Changing the method means changing
  the caption, and the test will say so.
