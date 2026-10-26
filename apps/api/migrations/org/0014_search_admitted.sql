-- The batch the day's allowance last admitted: the events consumer reserves its
-- projection writes in their own batch, marking the day's row with a token of
-- the batch's when the reservation is made, and its guarded writes stand only
-- when the row carries that token (batches run one at a time).
ALTER TABLE search_budget ADD COLUMN admitted TEXT;
