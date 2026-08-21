-- Scoreline predictions, and the team ratings behind them.
--
-- Two tables that mirror `decisions` / `outcomes`, for the same reason. A
-- prediction nobody scores is an opinion, and the only prediction worth
-- scoring is one made BEFORE kickoff. Writing is therefore restricted to
-- fixtures that have not started, and re-generating upserts rather than
-- appends — so the row that survives a kickoff is the last thing the model
-- said while it could still be wrong.

-- ---------------------------------------------------------------------------
-- Ratings
-- ---------------------------------------------------------------------------

create table team_ratings (
  team_id        int primary key references teams (id) on delete cascade,
  -- Both centred on 1.0. `defence` multiplies what the OPPONENT is expected to
  -- score, so higher means worse — the orientation `lib/engine/scoreline.ts`
  -- uses, kept identical here so no conversion happens at the boundary.
  attack         numeric(6, 4) not null,
  defence        numeric(6, 4) not null,
  -- Fit-level scalars, written identically to every row.
  --
  -- Repeated rather than split into their own table on purpose: a rating is
  -- meaningless without the scale it was fitted against, and separating them
  -- would allow a half-applied refit to leave ratings from one fit beside a
  -- league mean from another. Rewriting all twenty rows together makes that
  -- impossible.
  league_mean    numeric(6, 4) not null,
  home_advantage numeric(6, 4) not null,
  -- What the fit was able to see. 'prior-season' until this season has enough
  -- played matches to stand on its own, which the UI must be able to say.
  basis          text not null check (basis in ('prior-season', 'blended', 'this-season')),
  matches        int  not null,
  -- True when the side had no fitted rating and carries the promoted prior.
  -- The single weakest number in any prediction that uses it.
  is_prior       boolean not null default false,
  updated_at     timestamptz not null default now()
);

comment on table team_ratings is
  'Poisson attack/defence per club. Rewritten as a set, never row by row.';

-- ---------------------------------------------------------------------------
-- Predictions
-- ---------------------------------------------------------------------------

create table predictions (
  id             uuid primary key default gen_random_uuid(),
  gw             smallint not null,
  fixture_id     int not null references fixtures (id) on delete cascade,
  lambda_home    numeric(6, 3) not null,
  lambda_away    numeric(6, 3) not null,
  p_home         numeric(5, 4) not null,
  p_draw         numeric(5, 4) not null,
  p_away         numeric(5, 4) not null,
  -- The most likely scoreline WITHIN the favoured outcome, not the mode of the
  -- whole grid. The unconditional mode is 1-1 in nine fixtures out of ten and
  -- carries no information; see `mostLikelyScoreByOutcome`.
  score_home     smallint not null,
  score_away     smallint not null,
  score_p        numeric(5, 4) not null,
  cs_home        numeric(5, 4) not null,
  cs_away        numeric(5, 4) not null,
  btts           numeric(5, 4) not null,
  over_two_five  numeric(5, 4) not null,
  -- Carried so a prediction can still be read honestly months later, when the
  -- ratings behind it have been refitted several times over.
  basis          text not null,
  uses_prior     boolean not null default false,
  created_at     timestamptz not null default now(),
  -- One live prediction per fixture. Regenerating replaces it.
  unique (fixture_id)
);

create index predictions_gw_idx on predictions (gw desc);

create table prediction_outcomes (
  prediction_id   uuid primary key references predictions (id) on delete cascade,
  actual_home     smallint not null,
  actual_away     smallint not null,
  outcome_correct boolean  not null,
  exact_correct   boolean  not null,
  -- Ranked probability score, the proper scoring rule for an ordered
  -- three-way outcome. Lower is better; 0 is perfect, 1 is maximally wrong.
  -- Stored rather than recomputed so the record survives a change to how it
  -- is derived — the same reasoning as `outcomes.delta`.
  rps             numeric(6, 5) not null,
  log_loss        numeric(8, 5) not null,
  scored_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

-- Deny-all, like every other table here. Reads and writes go through the
-- service role in server code; nothing is reachable from a browser.
alter table team_ratings        enable row level security;
alter table predictions         enable row level security;
alter table prediction_outcomes enable row level security;
