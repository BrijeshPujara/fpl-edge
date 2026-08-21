-- Let a prediction describe itself.
--
-- The caption on the scorelines panel went stale three times in one feature:
-- a header still reading LIKELY SCORES over columns that had become
-- HOME/DRAW/AWAY, a footnote claiming "last season only" after the prior
-- became three seasons, and a description of the mode after the statistic
-- became the mean. Every time, the numbers changed and the sentence explaining
-- them did not, and the page stated something false with nothing to reveal it.
--
-- The cause was that the prose assumed facts rather than reading them. These
-- two columns are the facts, so the sentence can be derived instead:
--
--   * `score_method` names the summary that produced the scoreline. A row
--     written under one summary keeps describing itself correctly after the
--     active one changes — otherwise every past prediction is retroactively
--     mislabelled by the next fix.
--   * `prior_seasons` is how many completed seasons the ratings were fitted
--     on, so the screen states the number instead of hardcoding "last season".
--
-- Defaults match what existing rows were actually produced with.

alter table predictions add column score_method text not null default 'expected';

comment on column predictions.score_method is
  'Which scoreline summary produced score_home/away. Stored so a prediction still describes itself correctly after the active summary changes.';

alter table team_ratings add column prior_seasons smallint not null default 1;

comment on column team_ratings.prior_seasons is
  'How many completed seasons the prior was fitted on. Stored so the screen can state it rather than assume it.';
