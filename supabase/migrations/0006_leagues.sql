-- Mini-leagues.
--
-- Discovered, not configured. `entry/{id}/` already returns every league a
-- manager belongs to, and the app already fetches that payload to register
-- them — it was simply discarding the field. Nobody types a league id.
--
-- WHAT IS NOT HERE: standings.
--
-- They are deliberately absent. A league table is read-only display data that
-- `leagues-classic/{id}/standings/` returns in one call, and storing it would
-- mean a table, a sync job and a staleness problem in exchange for saving a
-- request the HTTP cache already handles. Storage starts earning its place
-- when the question becomes "how has my rank MOVED" or "what do my rivals own
-- that I do not" — history and rival squads, neither of which is this table.

create table leagues (
  id          int         primary key,
  name        text        not null,
  -- "x" is a league someone joined; "s" is one the game enrolled them into
  -- (Overall, their country, their favourite club). Only the first kind is a
  -- mini-league in any useful sense, and the UI leads with it.
  league_type text        not null,
  -- "c" classic, "h" head-to-head.
  scoring     text        not null,
  start_event smallint,
  updated_at  timestamptz not null default now()
);

comment on table leagues is
  'Leagues discovered from entry/{id}/. league_type "x" is a real mini-league; "s" is a global one the game enrols everyone into.';

alter table leagues enable row level security;

-- Who is in what. Many-to-many, and the rank columns are a convenience: they
-- come free in the entry payload and save a standings call to answer "where am
-- I" on a summary screen.
create table league_memberships (
  league_id       int         not null references leagues (id) on delete cascade,
  entry_id        int         not null references entries (id) on delete cascade,
  -- Zero before a gameweek is scored. Stored as null in that case rather than
  -- as a rank of zero, which would sort to the top and read as first place.
  entry_rank      int,
  entry_last_rank int,
  updated_at      timestamptz not null default now(),
  primary key (league_id, entry_id)
);

create index league_memberships_entry_id_idx on league_memberships (entry_id);

alter table league_memberships enable row level security;
