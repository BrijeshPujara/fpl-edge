-- Keep last season's rating alongside the one in use.
--
-- Refitting overwrites `attack` and `defence` with the blend of last season
-- and this one. Without somewhere to keep the prior, the second refit would
-- blend against the first refit's output rather than against last season —
-- a feedback loop that would drift the ratings somewhere neither season
-- supports, and do it silently.
--
-- Written once by the seed and carried forward unchanged by every refit.

alter table team_ratings add column prior_attack         numeric(6, 4);
alter table team_ratings add column prior_defence        numeric(6, 4);
alter table team_ratings add column prior_league_mean    numeric(6, 4);
alter table team_ratings add column prior_home_advantage numeric(6, 4);

-- How much this season counted in the blend, 0 to 1. Stored rather than
-- recomputed so a prediction can be explained months later without knowing
-- what the schedule was on the day it was made.
alter table team_ratings add column blend_weight numeric(5, 4) not null default 0;

comment on column team_ratings.prior_attack is
  'Last season''s rating. Never overwritten by a refit — the blend needs a fixed point to move away from, or it compounds against itself.';
