-- The managers this deployment knows about.
--
-- Registered on demand: someone types a team id, the app looks it up once and
-- remembers the name. There is nothing private here — `entry/{id}/` is an
-- unauthenticated endpoint and every mini-league table on the FPL site reads
-- exactly this data — so the table needs validating, not protecting.
--
-- `last_synced_at` is the rate limit that matters. It is not really about abuse
-- (though it helps): it is about not asking someone else's server the same
-- question twice in a minute because a page was refreshed.

create table entries (
  id             int         primary key,
  -- The team name, as the manager set it.
  name           text        not null,
  -- Who the manager is. Public on every league table they appear in.
  manager_name   text        not null,
  last_synced_at timestamptz not null default now(),
  created_at     timestamptz not null default now()
);

comment on table entries is
  'FPL managers known to this deployment. Registered on demand from a team id, which is public data.';

alter table entries enable row level security;

-- A squad must belong to a manager the app has actually looked up. This is
-- what stops a typo'd id quietly accumulating orphan squads.
alter table squads
  add constraint squads_entry_id_fkey
  foreign key (entry_id) references entries (id) on delete cascade;
