-- Running repository deletions: who asked (the deletion's events and audit
-- rows name them), the last failure for operators, and an index for the
-- cron that advances the ones not done.

ALTER TABLE repo_deletions ADD COLUMN requested_by TEXT;
ALTER TABLE repo_deletions ADD COLUMN last_error TEXT;

CREATE INDEX repo_deletions_pending ON repo_deletions (updated_at) WHERE step <> 'done';
