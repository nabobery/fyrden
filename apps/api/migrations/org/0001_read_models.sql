-- D1 `org`: read models built from the events of repositories and
-- organizations. Every row records the event position it was built from,
-- (epoch_gen, version), and a write only replaces a row from an older
-- position, so redelivered and reordered events cannot move it backwards.
-- Forward-only: later changes add new numbered files, expand then contract.

-- Repositories. A deletion is kept as a tombstone (deleted = 1) so an older
-- snapshot arriving late cannot bring the row back.
CREATE TABLE repos (
  repo_id TEXT PRIMARY KEY,
  owner_id TEXT,
  name TEXT,
  visibility TEXT CHECK (visibility IS NULL OR visibility IN ('public', 'internal', 'private')),
  default_branch TEXT,
  pushed_at INTEGER,
  created_at INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  epoch_gen INTEGER NOT NULL,
  version INTEGER NOT NULL,
  owner_gen INTEGER NOT NULL,
  -- The sequence of the event that wrote the row, for rebuilds.
  updated_seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX repos_owner ON repos (owner_id, name) WHERE deleted = 0;

-- The newest restore generation seen per source. Events from an older one
-- are dropped.
CREATE TABLE consumer_epochs (
  source_id TEXT PRIMARY KEY,
  epoch_gen INTEGER NOT NULL CHECK (epoch_gen >= 1),
  updated_at INTEGER NOT NULL
) STRICT;

-- The current ownership generation per source, bumped when a repository
-- moves to another organization; events with an older one are dropped.
CREATE TABLE source_owner (
  source_id TEXT PRIMARY KEY,
  owner_gen INTEGER NOT NULL CHECK (owner_gen >= 1)
) STRICT;
