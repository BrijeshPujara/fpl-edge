-- Net transfer momentum — the input the price model has never had.
--
-- WHY CUMULATIVE COUNTERS AND NOT `transfers_in_event`
--
-- bootstrap-static offers both. `transfers_in_event` is a running total for the
-- gameweek in progress and RESETS at every deadline, so capturing it correctly
-- means landing a sync in the window between the last transfer and the
-- rollover. Miss one run, or run late, and that gameweek is gone for good.
--
-- `transfers_in` and `transfers_out` are season-cumulative and never reset.
-- Differencing consecutive snapshots recovers the same signal with three
-- properties the event fields cannot offer:
--
--   * self-healing  — a missed day merges into the next delta instead of
--                     vanishing, so the series stays complete
--   * idempotent    — re-running a sync overwrites the day's row rather than
--                     appending, so a retry cannot double count
--   * finer-grained — deltas are daily, and FPL moves prices daily, not weekly
--
-- The cost is one row per player per day (~217k a season, trivially indexed)
-- against price_history's changes-only design. Worth it: price_history answers
-- "when did this move", this answers "what is about to move", and the second
-- question needs the samples where nothing happened.

create table player_transfer_snapshots (
  player_id           int         not null references players (id) on delete cascade,
  -- Date, not timestamp. One sample a day is the resolution that matters, and a
  -- date key makes a same-day re-run an upsert rather than a duplicate.
  captured_on         date        not null,
  -- The gameweek transfers were being made FOR when this was sampled: the one
  -- whose deadline had not yet passed. Null before the season opens.
  gw                  smallint,
  -- Season-cumulative. bigint because a popular player clears 2^31 over a
  -- season across 6.7m managers.
  transfers_in        bigint      not null,
  transfers_out       bigint      not null,
  -- Carried alongside so the price model can read ownership and its trend from
  -- one place. Ownership sets the threshold a price change has to cross.
  selected_by_percent numeric(5, 2) not null default 0,
  now_cost            int         not null,
  primary key (player_id, captured_on)
);

create index player_transfer_snapshots_captured_on_idx
  on player_transfer_snapshots (captured_on desc);

alter table player_transfer_snapshots enable row level security;

-- ---------------------------------------------------------------------------

-- Global game facts. Single row, enforced by the primary key check.
--
-- total_players is the denominator for every ownership calculation: a 20%-owned
-- player is 1.3m managers, and the price-change threshold scales with that
-- number rather than with the percentage.
create table game_state (
  id            boolean     primary key default true check (id),
  total_players int         not null,
  updated_at    timestamptz not null default now()
);

alter table game_state enable row level security;

-- ---------------------------------------------------------------------------

-- player_gw_stats.transfers_balance is removed rather than populated.
--
-- That table is keyed on (player_id, fixture_id) so that double gameweeks are
-- representable. Net transfers are a per-GAMEWEEK quantity, so in a double
-- there is no honest value to write: the true figure on both rows double counts
-- on aggregation, and splitting it across rows invents a per-fixture number
-- that does not exist. The column was unrepresentable where it sat.
--
-- player_transfer_snapshots is now the source of truth, and it is strictly
-- better: daily rather than weekly, and available before a gameweek is played
-- rather than only after.
alter table player_gw_stats drop column transfers_balance;
