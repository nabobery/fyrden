-- Renaming repositories. `name_gen` counts a repository's renames, so the
-- repository object, told of renames that can arrive out of order, keeps
-- the newest name. A redirect keeps an old name working (owner, name ->
-- repository) until a repository takes that name again.

ALTER TABLE repos ADD COLUMN name_gen INTEGER NOT NULL DEFAULT 0;

CREATE TABLE repo_redirects (
  owner_id TEXT NOT NULL REFERENCES principals (id),
  name TEXT NOT NULL COLLATE NOCASE,
  repo_id TEXT NOT NULL REFERENCES repos (id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, name)
) STRICT;

CREATE INDEX repo_redirects_repo ON repo_redirects (repo_id);
