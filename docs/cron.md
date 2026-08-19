# Scheduling

## The Vercel Hobby constraint

`vercel.json` declares one cron job, not the four PLAN.md §9 specifies. That is
deliberate, and it needs a decision before the rest are added.

Vercel's Hobby tier has historically capped cron at **two jobs, daily
granularity only**. PLAN.md wants four schedules plus 15-minute live polling
during match windows. Those do not fit, and the limit is enforced at deploy
time — the failure arrives when you deploy, not when you write the config.

Confirm the current limits against Vercel's pricing page before building
further around this. Three ways forward:

1. **Schedule from GitHub Actions** (recommended). Free, minute-level
   granularity, unlimited schedules. The workflow just `curl`s the same route
   handlers with the `CRON_SECRET` bearer token, so no application code
   changes. The routes stay the interface; only the trigger moves.
2. **Consolidate into fewer routes.** One `/api/cron/daily` that branches
   internally on what needs doing. Fits the cap, but couples unrelated jobs and
   makes a single failure take down all of them.
3. **Upgrade to Pro.** Removes the constraint at a monthly cost.

Option 1 keeps the architecture honest and costs nothing. The route handlers
are already designed for it: they authenticate on a bearer token rather than
trusting Vercel's cron headers.

## Triggering a route by hand

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  http://localhost:3000/api/cron/sync-static | jq
```

Every cron route is idempotent. Running one twice is harmless — which matters,
because retries and manual triggers both happen.

## Schedules from PLAN.md §9

| Route | Schedule | Job | Status |
|---|---|---|---|
| `/api/cron/sync-static` | Daily 00:15 UK | bootstrap-static + fixtures, price snapshots | Built |
| `/api/cron/sync-squad` | Daily 06:00 | Entry, picks, derived free transfers | Built |
| `/api/cron/weekly-brief` | Thu 09:00 | Run engine, generate brief, persist decisions | Not built |
| `/api/cron/resolve-outcomes` | Tue 09:00 | Score last gameweek's decisions | Not built |

Note the 00:15 timing on `sync-static`: it runs after the overnight price
changes have settled, so the daily price snapshot captures the new prices
rather than yesterday's.

`sync-squad` returns **200** with `status: "no-picks-yet"` when no gameweek
deadline has passed. That is the expected state through pre-season, not a
failure — alerting on a non-200 would otherwise cry wolf every morning until
the first deadline. Alert on `ok: false` instead.

Mini-league standings are *not* synced. PLAN.md §9 lists them under this job,
but the §4 schema has no table to put them in, so that needs a schema addition
before the fetch is worth writing. `getLeagueStandings` in the FPL client is
ready for it.
