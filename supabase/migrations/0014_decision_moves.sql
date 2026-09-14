-- Record the whole transfer plan, what it cost, and when it was last advised.
--
-- Three gaps, each of which made the journal say something false:
--
--   * `player_in` / `player_out` hold ONE swap, and the optimiser recommends
--     up to several. A two-move plan was stored as its first swap carrying the
--     net gain of both, so the verdict scored half the advice against all of
--     the manager's moves. `moves` holds every swap. The two scalar columns are
--     kept as the first swap so existing readers do not break.
--
--   * A hit was only ever mentioned in the rationale, so scoring could not
--     subtract it. `hit_cost` is the points the plan would have cost.
--
--   * `created_at` is set on insert and never again, while the row is upserted
--     every sync until the deadline. The timestamp said when the engine FIRST
--     advised and the content was what it LAST advised — which is how the GW3
--     brief and the GW3 decision came to disagree with nothing to show why.
--     `updated_at` is when the surviving content was written, which is the
--     timestamp invariant 3 needs to be auditable.
--
-- Existing rows: `moves` stays empty, which readers treat as "first swap only,
-- the rest unknown" rather than as a one-move plan. Every recorded rationale
-- so far reads "free", so `hit_cost` 0 is what they actually were.

alter table decisions add column moves jsonb not null default '[]'::jsonb;
alter table decisions add column hit_cost smallint not null default 0;
alter table decisions add column updated_at timestamptz not null default now();

-- The best available answer for rows written before this column existed.
update decisions set updated_at = created_at;

comment on column decisions.moves is
  'Every swap in the advised plan, as [{"in": id, "out": id}]. Empty on rows written before 0014, which recorded the first swap only.';
comment on column decisions.hit_cost is
  'Points the advised plan would have cost in hits.';
comment on column decisions.updated_at is
  'When this content was written. Upserts refresh it; created_at is only the first time the gameweek was advised on.';

alter table briefs add column updated_at timestamptz not null default now();
update briefs set updated_at = created_at;

comment on column briefs.updated_at is
  'When this body was written. Compare with decisions.updated_at: a brief older than its decisions describes advice that has since changed.';
