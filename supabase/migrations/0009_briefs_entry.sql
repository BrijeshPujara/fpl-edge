-- Briefs belong to a manager, not just to a gameweek.
--
-- `briefs` was keyed on `gw` alone, which was right when the app served one
-- person and becomes a collision the moment it serves two: a brief is about a
-- squad, and squads differ.
--
-- `llm_usage.entry_id` is nullable and set null on delete, because the point of
-- that table is to make spend visible. A deleted manager should not delete the
-- record of what was spent on their behalf.

alter table briefs drop constraint briefs_pkey;
alter table briefs add column entry_id int not null references entries (id) on delete cascade;
alter table briefs add primary key (entry_id, gw);

alter table llm_usage add column entry_id int references entries (id) on delete set null;

comment on table briefs is
  'One written brief per manager per gameweek. Keyed on both: a brief is about a squad, and squads differ.';
