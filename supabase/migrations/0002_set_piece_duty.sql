-- Set-piece and penalty duty.
--
-- bootstrap-static reports these as a per-club ordering: 1 is the designated
-- taker, 2 the deputy, and NULL means no listed duty. Nullable rather than
-- defaulted, because "nobody listed" and "first choice" are opposite claims and
-- a default of 1 would make every player in the league a penalty taker.
--
-- Roughly 60 of ~595 players carry a penalties_order at any time — one to five
-- names per club — so these columns are sparse by nature, not by omission.

alter table players
  add column penalties_order        smallint,
  add column corners_order          smallint,
  add column direct_freekicks_order smallint;

comment on column players.penalties_order is
  'Club penalty-taking order from bootstrap-static; 1 = designated taker, null = no listed duty.';
comment on column players.corners_order is
  'Club corner and indirect free-kick order. The API reports both as one duty.';
comment on column players.direct_freekicks_order is
  'Club direct free-kick order. Synced but not yet modelled — see lib/engine/set-pieces.ts.';

-- Partial: the column is null for the overwhelming majority of rows, and the
-- queries that use it are always looking for the players who have a duty.
create index players_penalties_order_idx
  on players (penalties_order)
  where penalties_order is not null;
