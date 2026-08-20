-- Completed seasons, per player.
--
-- The model has always had a `priorSeason` input and a shrinkage schedule that
-- says "at GW1 believe last season 70%, decaying to zero by GW6". Production
-- passed null. For exactly the six gameweeks that schedule exists to cover, it
-- blended toward nothing.
--
-- This is the fix, and it needed no new data source: FPL publishes four
-- seasons per player at `element-summary/{id}.history_past`.
--
-- KEYED ON element_code, NOT player id. FPL renumbers ids every season — the
-- same footballer is a different `id` in 2024/25 and 2026/27 — while `code` is
-- stable for a player's whole career. Keying on id would silently attach last
-- season's rates to whoever inherited the number.

create table player_season_history (
  -- Stable across seasons. `players.code`, not `players.id`.
  player_code            int         not null,
  season_name            text        not null,
  minutes                int         not null default 0,
  starts                 int         not null default 0,
  goals_scored           int         not null default 0,
  assists                int         not null default 0,
  clean_sheets           int         not null default 0,
  goals_conceded         int         not null default 0,
  -- Null for seasons before FPL published xG at all, rather than zero: a
  -- season with no expected-goals data is unusable, and zero would read as a
  -- player who never threatened.
  expected_goals         numeric(8, 2),
  expected_assists       numeric(8, 2),
  -- Season total of defensive ACTIONS, not threshold hits.
  defensive_contribution int         not null default 0,
  bonus                  int         not null default 0,
  total_points           int         not null default 0,
  updated_at             timestamptz not null default now(),
  primary key (player_code, season_name)
);

comment on table player_season_history is
  'Completed seasons from element-summary/{id}.history_past, keyed on the career-stable element_code.';

create index player_season_history_code_idx on player_season_history (player_code);

alter table player_season_history enable row level security;
