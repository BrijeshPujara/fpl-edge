-- Store the shape of the scoreline distribution, not one cell of it.
--
-- A single scoreline is nearly uninformative and the panel was presenting it
-- as a finding. Measured over 280 held-out matches, the top cell is right
-- 12.5% of the time and the model names 2-1 or 1-2 in 53.6% of fixtures — so
-- it says the same thing half the time and is wrong seven times in eight.
--
-- The grid is not the problem: the top cell carries 14.2% of the probability
-- and is right 12.5% of the time, which is calibrated. Printing one cell of a
-- calibrated distribution is what over-claims. Three cells are right 33.6% of
-- the time and carry 34.5%, still calibrated and far more use.
--
-- [{ home, away, p }], most likely first.
alter table predictions add column likely_scores jsonb not null default '[]'::jsonb;

comment on column predictions.likely_scores is
  'Top scorelines with probabilities, most likely first. The display; score_home/away remains the single called scoreline that exact_correct is judged against.';
