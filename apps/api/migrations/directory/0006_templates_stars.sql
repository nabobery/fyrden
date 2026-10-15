-- Template repositories (generating one starts a new repository from a copy
-- of its files), and stars: a user's mark on a repository.
ALTER TABLE repos ADD COLUMN is_template INTEGER NOT NULL DEFAULT 0 CHECK (is_template IN (0, 1));

CREATE TABLE stars (
  user_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, repo_id)
) STRICT;
CREATE INDEX stars_repo ON stars (repo_id);
CREATE INDEX stars_user ON stars (user_id, created_at, repo_id);
