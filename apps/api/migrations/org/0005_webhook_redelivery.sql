-- A delivery sent again by hand: one more attempt, past the attempts its
-- automatic retries had (null: the delivery policy's limit).
ALTER TABLE webhook_deliveries ADD COLUMN attempt_limit INTEGER;
