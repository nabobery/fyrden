-- Who watches which repository: the acknowledged copy of each repository's
-- own record (its `watchers`), one row per principal and repository, the
-- latest command by `(epoch_gen, revision)`. A restored repository takes its
-- watchers back from here; `GET /user/subscriptions` lists a principal's.
CREATE TABLE watch_preferences (
  principal_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('participating', 'watching', 'ignoring')),
  revision INTEGER NOT NULL,
  epoch_gen INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (principal_id, repo_id)
) STRICT;
CREATE INDEX watch_preferences_repo ON watch_preferences (repo_id, principal_id);
CREATE INDEX watch_preferences_listed ON watch_preferences (principal_id, level, repo_id);
