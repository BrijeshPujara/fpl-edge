# Two questions: other people, and AI

Written 2026-08-20, in answer to two things worth deciding deliberately rather
than drifting into.

1. Making the app usable by anyone who enters a team ID.
2. What "using AI to improve my points" actually means, and what it does not.

The short version: **the multi-user work is much cheaper than it looks and
should still wait**, and **AI helps in exactly one place that matters, which is
not the place people expect**.

---

## 1. Letting anyone use it

### The good news, which changes the shape of everything

**An FPL team ID is public, not a credential.** `entry/{id}/` and
`entry/{id}/event/{gw}/picks/` are unauthenticated endpoints — anyone can read
anyone's squad, and the site itself does this on every mini-league page.

That removes the entire hard half of multi-tenancy:

- no accounts, no passwords, no email verification, no password resets
- no session management, no OAuth, no auth provider bill
- no personal data of any kind — a team ID and a squad, both already public
- nothing to leak, because there is nothing private in the system

"Enter your team ID and press go" is not a simplification of a login. It is the
whole thing, correctly.

### What actually has to change

Most of the database is already shared and needs no work at all. Players,
teams, fixtures, `player_gw_stats`, `price_history` and
`player_transfer_snapshots` are facts about the league, identical for every
user, and they are the overwhelming majority of the rows.

Only two tables are per-user, and only one column is missing:

| Change | Effort |
|---|---|
| `squads.entry_id`, and the key becomes `(entry_id, gw)` | 20 minutes |
| `entries` table caching team name and last sync | 30 minutes |
| Routes become `/t/{entryId}/...`, with a cookie remembering the last one | half a day |
| A landing page that takes an ID and redirects | an hour |
| `sync-squad` becomes on-demand per entry rather than a nightly job for one | half a day |
| Per-IP rate limiting on first sync of a new ID | an hour |
| Cache the optimiser result per `(entry, gw)` | half a day |

Call it two days of honest work. Nothing in it is difficult.

### The two real constraints

**The FPL API is someone else's server.** Today the app makes a handful of
calls a day. With a hundred users entering IDs it makes a call per new team per
gameweek, which is still trivial — but it has to be *bounded*, or a script
pointed at the landing page turns this project into a load generator aimed at
Premier League infrastructure. Rate limit per IP, and cache an entry's picks for
the rest of the gameweek once fetched. They cannot change until the next
deadline anyway.

**Every render solves a MILP.** Measured: 175ms for transfers, ~500ms for the
chip scan, ~700ms for a dashboard. Fine for one user, and fine for many *if
cached*, because the answer only changes when the projections change — which is
once a day, after the overnight sync. Cache on `(entry, gw, projection date)`
and the solver runs once per user per day rather than once per page view.

Neither is a blocker. Both are the kind of thing that is cheap to design in and
expensive to retrofit.

### Recommendation: not yet, but do one thing now

**Do not build this yet.** Not because it is hard — it is two days — but
because it multiplies the value of the engine, and the engine is the thing that
is not yet proven.

The honest state of the model: it beats a naive baseline by 2.6% overall, wins
clearly on goalkeepers and defenders, and **loses to it on forwards**. It has
never run against a real gameweek. Opening that to strangers is shipping a thin
and partly unverified edge to people who will judge the whole idea on it.

The sequence that makes sense is: run it on one team for a season, fix what a
season exposes, then open it up with something that has a track record.

**The one thing worth doing now**, while it costs nothing: add `entry_id` to
`squads`. The table is empty today. Adding a column to an empty table is free;
adding one to a table carrying half a season of your own history, mid-season,
with foreign keys onto it, is an afternoon and a migration you have to get right
first time.

---

## 2. What AI can actually do here

### What it cannot do

It cannot pick a better squad. The optimiser is a mixed-integer programme that
returns the **provably optimal** fifteen for a given set of projections — not a
good answer, the best one. There is no room above that. An LLM asked to improve
on it can only make it worse.

It cannot improve the arithmetic either. Expected points is a model; a language
model has no privileged access to Poisson distributions.

This matters because "add AI to it" usually means "let a model make the
decision", and here that would be a straight downgrade. The architectural rule
already in the README is the right one: **the LLM never touches the objective.**

### What it can do, and this is the whole opportunity

**Read the football the numbers cannot see — and convert it into minutes.**

Recall the single largest finding in the whole project: minutes dominate
everything. 62% of player-gameweek rows are non-appearances, and fixing one
assumption about substitute appearances moved the model from 16.2% *worse* than
a naive baseline to 2.6% better. Nothing else in the model comes close.

Now look at what the model actually knows about whether someone will play:

- `status` — one letter
- `chance_of_playing_next_round` — a coarse percentage, often null
- appearance history — accurate, and always six days stale

And look at what it does not know, all of which is in plain English:

- what the manager said in Friday's press conference
- that a player is being managed through a fixture pile-up
- that there is a European tie on Tuesday
- that a new signing is expected to go straight in
- that a transfer is being finalised
- `players.news` — **already in the database, and completely unused by the
  model**

An LLM turning that text into a bounded adjustment on the minutes projection is
doing genuine predictive work, on the model's most sensitive input, using
information the numeric pipeline structurally cannot represent.

That is where AI raises your points. Everything else it does here is
presentation.

### How to build it safely

```
lib/llm/minutes-news.ts

  in:   player, club, status, news text, recent starts, fixture congestion
  out:  { multiplier, confidence, rationale, citedText }
```

Five rules, all of which exist to stop it doing harm:

1. **It adjusts an input, never an output.** The multiplier lands on
   `projectMinutes`, upstream of expected points. The optimiser never sees it
   and never knows it happened.
2. **It is bounded.** A multiplier clamped to roughly 0.5–1.15. An unbounded
   model that hallucinates a season-ending injury should not be able to sell
   your captain.
3. **It must cite.** No adjustment without quoting the text it came from. An
   adjustment with no source is a hallucination with a decimal point.
4. **It is logged.** `llm_usage` and the decision journal already exist. Every
   adjustment gets recorded with its rationale, so it can be scored against
   outcomes exactly like every other decision — which means within a season you
   will know whether it is helping, rather than assuming.
5. **Absence is not failure.** No key, no adjustment, model runs as it does
   today. That rule is already in the README and should hold here.

### The rest of the AI surface, honestly ranked

| Use | Real value |
|---|---|
| **News → minutes adjustment** | High. The only one that changes predictions. |
| Weekly brief explaining the numbers | Moderate. Makes it usable, changes nothing. |
| "What am I missing?" sanity pass before a deadline | Moderate. Catches the structurally invisible. |
| Mini-league differential analysis | Moderate, but blocked on league tables. |
| Letting an LLM pick the squad | Negative. Do not. |

---

## Suggested order

1. **Add `entry_id` to `squads` now** — free today, awkward later.
2. **Let a real gameweek land.** `sync-results` is built and waiting. Nothing
   is worth tuning against a season that has not started.
3. **`/captain`** — still a stub, and captaincy is the highest-variance
   decision of the week. It also needs a different loss: MAE rewards
   conservative predictions, and for the armband the ceiling matters more than
   the mean.
4. **News → minutes.** Buildable now, uses a field already synced, and lands on
   the model's most sensitive input.
5. **Forwards, and the transfer path.** Both want ten or more gameweeks of real
   data first (see `next-steps.md`).
6. **Multi-user.** When there is a track record worth putting in front of
   someone.
