-- FPL Edge — core schema
--
-- Money is stored in tenths of a million (integers), matching the API.
-- Gameweeks are smallints 1-38. Nothing in here derives a gameweek from a
-- date; the API is the authority on that.

-- ---------------------------------------------------------------------------
-- Reference data, refreshed from bootstrap-static
-- ---------------------------------------------------------------------------

-- The strength columns are nullable and default to zero because the API
-- reports them that way before a season is under way: `strength` is null and
-- the attack/defence ratings are all zero until matches have been played.
-- Model code must treat zero as "no rating", not as "very weak".
create table teams (
  id                     int primary key,
  name                   text        not null,
  short_name             text        not null,
  strength               int,
  strength_overall_home  int         not null default 0,
  strength_overall_away  int         not null default 0,
  strength_attack_home   int         not null default 0,
  strength_attack_away   int         not null default 0,
  strength_defence_home  int         not null default 0,
  strength_defence_away  int         not null default 0,
  updated_at             timestamptz not null default now()
);

create table players (
  id                            int primary key,
  code                          int         not null,
  web_name                      text        not null,
  first_name                    text        not null,
  second_name                   text        not null,
  team_id                       int         not null references teams (id),
  position                      smallint    not null check (position between 1 and 4),
  now_cost                      int         not null,
  status                        text        not null,
  chance_of_playing_next_round  int,
  news                          text        not null default '',
  selected_by_percent           numeric(5, 2) not null default 0,
  updated_at                    timestamptz not null default now()
);

create index players_team_id_idx on players (team_id);
create index players_position_idx on players (position);

create table fixtures (
  id               int primary key,
  -- Null for fixtures not yet assigned to a gameweek (postponements).
  gw               smallint,
  home_team        int         not null references teams (id),
  away_team        int         not null references teams (id),
  kickoff          timestamptz,
  started          boolean     not null default false,
  finished         boolean     not null default false,
  home_score       int,
  away_score       int,
  home_difficulty  smallint    not null,
  away_difficulty  smallint    not null,
  updated_at       timestamptz not null default now()
);

create index fixtures_gw_idx on fixtures (gw);
create index fixtures_home_team_idx on fixtures (home_team);
create index fixtures_away_team_idx on fixtures (away_team);

-- ---------------------------------------------------------------------------
-- Per-gameweek history — the asset that makes every later phase possible
-- ---------------------------------------------------------------------------

-- The primary key includes fixture_id, not just (player_id, gw). In a double
-- gameweek a player has two rows; keying on (player_id, gw) alone would make
-- doubles unrepresentable and silently drop half the data.
--
-- opponent_team and was_home are stored because the expected-points model
-- applies an opponent-strength adjustment. Without them the history cannot
-- answer "who did they play", and the model's central term is uncomputable.
create table player_gw_stats (
  player_id                int      not null references players (id) on delete cascade,
  gw                       smallint not null,
  fixture_id               int      not null references fixtures (id) on delete cascade,
  opponent_team            int      not null references teams (id),
  was_home                 boolean  not null,
  minutes                  int      not null default 0,
  starts                   int      not null default 0,
  goals                    int      not null default 0,
  assists                  int      not null default 0,
  clean_sheets             int      not null default 0,
  goals_conceded           int      not null default 0,
  yellow_cards             int      not null default 0,
  red_cards                int      not null default 0,
  expected_goals           numeric(6, 3) not null default 0,
  expected_assists         numeric(6, 3) not null default 0,
  expected_goals_conceded  numeric(6, 3) not null default 0,
  defensive_contribution   int      not null default 0,
  bonus                    int      not null default 0,
  bps                      int      not null default 0,
  total_points             int      not null default 0,
  value                    int      not null default 0,
  transfers_balance        int      not null default 0,
  primary key (player_id, fixture_id)
);

create index player_gw_stats_gw_idx on player_gw_stats (gw);
create index player_gw_stats_player_gw_idx on player_gw_stats (player_id, gw);

create table price_history (
  player_id   int         not null references players (id) on delete cascade,
  recorded_at timestamptz not null default now(),
  cost        int         not null,
  primary key (player_id, recorded_at)
);

create index price_history_recorded_at_idx on price_history (recorded_at desc);

-- ---------------------------------------------------------------------------
-- Your state
-- ---------------------------------------------------------------------------

create table squads (
  id              uuid primary key default gen_random_uuid(),
  gw              smallint not null,
  captain_id      int      references players (id),
  vice_captain_id int      references players (id),
  chip_played     text     check (
    chip_played is null
    or chip_played in ('wildcard', 'freehit', '3xc', 'bboost')
  ),
  bank            int      not null default 0,
  team_value      int      not null default 0,
  free_transfers  smallint not null default 1,
  created_at      timestamptz not null default now(),
  -- One squad per gameweek. Re-syncing updates the row rather than appending.
  unique (gw)
);

create table squad_picks (
  squad_id   uuid     not null references squads (id) on delete cascade,
  player_id  int      not null references players (id),
  -- 1-15; 12-15 are the bench, in order.
  position   smallint not null check (position between 1 and 15),
  is_captain boolean  not null default false,
  is_vice    boolean  not null default false,
  primary key (squad_id, player_id),
  unique (squad_id, position)
);

-- ---------------------------------------------------------------------------
-- The differentiator: what was decided, why, and what else was considered
-- ---------------------------------------------------------------------------

create table decisions (
  id            uuid primary key default gen_random_uuid(),
  gw            smallint not null,
  kind          text     not null check (kind in ('transfer', 'captain', 'chip', 'hold')),
  player_in     int      references players (id),
  player_out    int      references players (id),
  predicted_ep  numeric(6, 2),
  -- [{ player_id, ep, reason }]
  alternatives  jsonb    not null default '[]'::jsonb,
  rationale     text,
  source        text     not null check (source in ('engine', 'llm', 'manual')),
  created_at    timestamptz not null default now()
);

create index decisions_gw_idx on decisions (gw);

create table outcomes (
  decision_id             uuid primary key references decisions (id) on delete cascade,
  actual_points           int not null,
  best_alternative_points int not null,
  -- Stored rather than computed so it survives a change to how it is derived.
  delta                   int not null,
  resolved_at             timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Observability
-- ---------------------------------------------------------------------------

-- LLM spend is visible by construction. The brief is a presentation layer and
-- should never become an invisible cost centre.
create table llm_usage (
  id            uuid primary key default gen_random_uuid(),
  gw            smallint,
  model         text        not null,
  purpose       text        not null,
  input_tokens  int         not null,
  output_tokens int         not null,
  cached_tokens int         not null default 0,
  created_at    timestamptz not null default now()
);

create index llm_usage_created_at_idx on llm_usage (created_at desc);

-- The weekly brief, persisted so the UI renders it without calling the LLM.
create table briefs (
  gw         smallint primary key,
  body       text        not null,
  model      text        not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

-- Every table here is written and read exclusively by the server: cron route
-- handlers and server components, using the service role key, which bypasses
-- RLS entirely.
--
-- No browser ever queries Supabase directly, so RLS is enabled with NO
-- policies. That is a deliberate deny-all, not an oversight. The anon key ships
-- in the client bundle by construction (NEXT_PUBLIC_), and without this,
-- PostgREST would expose every one of these tables to anyone who read it out of
-- the JavaScript.
--
-- If a screen ever does need to query from the browser, add a narrow policy for
-- that table — do not disable RLS.

alter table teams            enable row level security;
alter table players          enable row level security;
alter table fixtures         enable row level security;
alter table player_gw_stats  enable row level security;
alter table price_history    enable row level security;
alter table squads           enable row level security;
alter table squad_picks      enable row level security;
alter table decisions        enable row level security;
alter table outcomes         enable row level security;
alter table llm_usage        enable row level security;
alter table briefs           enable row level security;
