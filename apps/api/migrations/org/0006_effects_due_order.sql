-- Pending effects in the order the sweep claims them: due time, then id
-- among effects due at once (a burst shares one timestamp). With the id in
-- the index, the claim reads a page of due effects in order and stops,
-- instead of reading and sorting every effect due at the same time.
-- IF NOT EXISTS and IF EXISTS let a database whose indexes drifted (a
-- rebuilt table, a repair by hand) migrate too; fyrden deploy then compares
-- its schema with the expected one, so an index left with another
-- definition is still reported.
CREATE INDEX IF NOT EXISTS effects_due_order ON effects (next_attempt_at, effect_id) WHERE state = 'pending';

-- Every query that used effects_due (the claim, the health check's oldest
-- pending effect) uses the index above's leading column instead.
DROP INDEX IF EXISTS effects_due;
