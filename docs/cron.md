# Scheduling

## Why GitHub Actions and not Vercel Cron

There is deliberately **no `vercel.json`**. Scheduling lives entirely in
`.github/workflows/sync.yml`.

Vercel's Hobby tier has historically capped cron at **two jobs, daily
granularity only**, and the limit is enforced at deploy time rather than when
you write the config. PLAN.md §9 wants four schedules, and Phase 6 adds
15-minute polling during match windows. That does not fit now and will not fit
later, so building around it would mean unpicking it twice.

GitHub Actions is free, has minute-level granularity and no job limit.

Running **both** schedulers was the alternative and is worse than either alone:
the jobs are idempotent so nothing would break, but every sync would run twice
and the logs would misreport which schedule mattered.

If you later move to Vercel Pro and want the platform's scheduler, add
`vercel.json` back with a `crons` array pointing at the route handlers, and
delete the schedule block from the workflow. The routes and the script call the
same `syncStatic` and `syncSquad` functions, so the two paths cannot drift.

Note that Vercel injects `Authorization: Bearer $CRON_SECRET` into cron
invocations when that environment variable is set, and `authorizeCron` already
parses exactly that — so no code change is needed to switch.

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
| `/api/cron/sync-results` | Daily 08:00 | Played-gameweek results into `player_gw_stats` | Built |
| `/api/cron/weekly-brief` | Thu 09:00 | Run engine, generate brief, persist decisions | Not built |
| `/api/cron/resolve-outcomes` | Tue 09:00 | Score last gameweek's decisions | Not built |

Note the 00:15 timing on `sync-static`: it runs after the overnight price
changes have settled, so the daily price snapshot captures the new prices
rather than yesterday's.

`sync-squad` returns **200** with `status: "no-picks-yet"` when no gameweek
deadline has passed. That is the expected state through pre-season, not a
failure — alerting on a non-200 would otherwise cry wolf every morning until
the first deadline. Alert on `ok: false` instead.

`sync-results` only writes gameweeks the API reports as both `finished` AND
`data_checked`. Bonus points and stats stay provisional until the second flag,
so syncing on `finished` alone would store numbers that later change. A run
before the data is checked skips the gameweek rather than storing something
wrong, which is why it can safely run daily.

`transfers_balance` is written as zero. The live endpoint does not carry it, and
it is the price model's main input — so the price model stays inert until a
separate daily capture of net transfers exists. Recorded here rather than left
as a silent zero that looks like real data.

Mini-league standings are *not* synced. PLAN.md §9 lists them under this job,
but the §4 schema has no table to put them in, so that needs a schema addition
before the fetch is worth writing. `getLeagueStandings` in the FPL client is
ready for it.
