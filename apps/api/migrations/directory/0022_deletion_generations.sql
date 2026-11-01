-- A repository deletion reopened from its start (src/do/repo/epoch.ts): its
-- object was restored from a backup taken before the deletion froze or
-- erased it. Each reopening counts a generation; a checkpoint of an earlier
-- generation's run is refused (src/repos/deletion.ts), and a cleanup done in
-- an earlier generation runs again. `reopened_epoch` is the restore
-- generation that reopened it, so one restore reopens it once.
ALTER TABLE repo_deletions ADD COLUMN gen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE repo_deletions ADD COLUMN reopened_epoch INTEGER;
ALTER TABLE repo_deletion_cleanups ADD COLUMN gen INTEGER NOT NULL DEFAULT 0;
