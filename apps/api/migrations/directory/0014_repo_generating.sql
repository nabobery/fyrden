-- A repository being generated from a template: set when it is created,
-- cleared once its first commit is made. A generation whose request never
-- cleared it is settled by the cron once it is overdue: kept when the
-- commit was made, deleted otherwise.
ALTER TABLE repos ADD COLUMN generating_since INTEGER;
-- Active ones only: a deleted repository keeps its marker in its tombstone.
CREATE INDEX repos_generating ON repos (generating_since)
  WHERE generating_since IS NOT NULL AND state = 'active';
