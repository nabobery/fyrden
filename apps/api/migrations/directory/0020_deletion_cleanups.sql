-- The cleanups a repository's deletion has finished (src/repos/cleanups.ts):
-- what the repository left outside its own storage, removed before that
-- storage goes. A cleanup listed here is not run again.
CREATE TABLE repo_deletion_cleanups (
  repo_id TEXT NOT NULL REFERENCES repo_deletions (repo_id),
  cleanup TEXT NOT NULL,
  done_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, cleanup)
) STRICT, WITHOUT ROWID;

-- Deletions already past their purge run their cleanups before the erase.
-- The cleanups touch only the org database and R2, so an object partly
-- erased already is no obstacle.
UPDATE repo_deletions SET step = 'cleanup' WHERE step = 'erase';
