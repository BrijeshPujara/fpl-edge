-- The shadow manager: a second squad that follows only the engine's advice.
--
-- The journal compares single decisions, and every one of those comparisons
-- has to assume the rest of the squad was the manager's. The shadow removes the
-- assumption. It starts from the manager's own squad, then plays the season
-- under the same rules — free transfers, hits, bank, selling prices, chips,
-- auto-subs — doing exactly what the engine advises and nothing else. Its
-- points against the manager's is the whole case for or against the engine.
--
-- Same recording rule as the journal: a week is written only while its
-- gameweek is open, and the row that survives the deadline is the last plan
-- made before it. `updated_at` is set on every write for that reason.
--
-- Picks are a jsonb column rather than a child table, deliberately. A week is
-- rewritten every sync until the deadline, and with a child table that is a
-- delete followed by an insert — two statements, so a failure between them
-- leaves an open gameweek holding no squad at all. One upsert of one row
-- cannot be half-written.

create table shadow_squads (
  id             uuid primary key default gen_random_uuid(),
  entry_id       int      not null references entries (id) on delete cascade,
  gw             smallint not null,
  -- 'seed' is the manager's squad the shadow started from, and is never
  -- scored: both sides own it, so it cannot separate them.
  origin         text     not null check (origin in ('seed', 'engine')),
  chip_played    text     check (
    chip_played is null
    or chip_played in ('wildcard', 'freehit', '3xc', 'bboost')
  ),
  -- [{"playerId", "slot", "isCaptain", "isVice", "purchasePrice"}]
  picks          jsonb    not null,
  -- Tenths, after this week's moves.
  bank           int      not null,
  -- The balance the plan was made with. Null on the seed.
  free_transfers smallint,
  moves          jsonb    not null default '[]'::jsonb,
  hit_cost       smallint not null default 0,
  projected_ep   numeric,
  -- Final points before the hit, once results are checked. Null until then.
  points         int,
  scored_at      timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (entry_id, gw)
);

create index shadow_squads_entry_gw_idx on shadow_squads (entry_id, gw desc);

-- Same posture as every other table: RLS on, no policies, service role only.
alter table shadow_squads enable row level security;

comment on table shadow_squads is
  'A squad that follows only the engine''s advice, one row per gameweek, recorded while the gameweek is open.';
comment on column shadow_squads.points is
  'Final points before the hit. Subtract hit_cost for the number compared with the manager.';
