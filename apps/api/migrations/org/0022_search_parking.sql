-- A source whose reconciliation ended partial (something it needed refused: its growth, the
-- repository index, the database at its size threshold) waits before its next pass, out of the
-- queue of those due: `blocked_reason` says why, `retry_at` when it may be woken. Both are
-- cleared when it is woken or its revision covered.
ALTER TABLE search_repairs ADD COLUMN blocked_reason TEXT;
ALTER TABLE search_repairs ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0;

DROP INDEX search_repairs_due;
CREATE INDEX search_repairs_due ON search_repairs (next_at, repo_id)
  WHERE dirty > covered AND blocked_reason IS NULL;
CREATE INDEX search_repairs_retry ON search_repairs (retry_at, repo_id)
  WHERE dirty > covered AND blocked_reason IS NOT NULL;

-- Why a pass ended partial: the first refusal it met.
ALTER TABLE search_reconciles ADD COLUMN partial_reason TEXT;
