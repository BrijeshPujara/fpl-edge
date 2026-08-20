-- The decision journal, per manager.
--
-- `decisions` and `outcomes` were designed when the app served one person.
-- They now need to say whose decision a decision was.
--
-- The unique key is what makes recording safe to repeat. The recorder runs on
-- every daily sync and rewrites the recommendation for the gameweek that is
-- still open, so the row that survives is the last one before the deadline —
-- which is the recommendation that was actually live when it mattered. Without
-- the constraint that would append a row a day and the journal would be a log
-- of the engine changing its mind rather than a record of what it advised.

alter table decisions add column entry_id int not null references entries (id) on delete cascade;

-- One decision of each kind per manager per gameweek.
alter table decisions
  add constraint decisions_entry_gw_kind_key unique (entry_id, gw, kind);

create index decisions_entry_gw_idx on decisions (entry_id, gw desc);

comment on column decisions.entry_id is
  'Whose decision this was. Decisions are per manager; the projections behind them are not.';
