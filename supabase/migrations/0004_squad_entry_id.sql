-- Which manager's squad this is.
--
-- Done now, deliberately, while `squads` is still empty. The column is
-- `not null` with no default, which is free on an empty table and impossible
-- on a populated one without either a backfill or a lie — and the lie would be
-- a default entry id, silently attributing someone else's squad to whoever the
-- default names.
--
-- Nothing else in the schema needs touching. `players`, `teams`, `fixtures`,
-- `player_gw_stats`, `price_history` and `player_transfer_snapshots` are facts
-- about the league, identical for every manager, and they are the overwhelming
-- majority of the rows. `squad_picks` needs no entry id either: it references
-- `squads`, which carries one.
--
-- This does not make the app multi-user on its own — routing, on-demand sync,
-- rate limiting and result caching are all still ahead (docs/multi-user-and-ai.md).
-- It removes the one part of that work that gets harder every day it is left.

alter table squads add column entry_id int not null;

comment on column squads.entry_id is
  'FPL entry id — the number in the My Team URL. Public data, not a credential: entry/{id}/ is unauthenticated.';

-- One squad per manager per gameweek, replacing one squad per gameweek.
-- Re-syncing still updates rather than appending; it just no longer collides
-- with a different manager's squad for the same week.
alter table squads drop constraint squads_gw_key;
alter table squads add constraint squads_entry_gw_key unique (entry_id, gw);

-- Every read is "this manager's squads", so the entry id leads.
create index squads_entry_id_gw_idx on squads (entry_id, gw desc);
