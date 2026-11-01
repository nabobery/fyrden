-- Search's projections of a repository's issues, pull requests, labels and
-- milestones, written through the guarded statements of src/search/statements.ts
-- (nothing writes them yet). Each row carries the position of the event that wrote
-- it (the source's epoch, ownership generation and sequence) and the entity's
-- version, so a delayed or replayed event never moves a row back. A deleted entity
-- keeps a row marked deleted, without its text, so an older event cannot bring it
-- back.

-- Issues and pull requests (one number sequence a repository).
CREATE TABLE search_docs (
  doc_id INTEGER PRIMARY KEY,
  repo_id TEXT NOT NULL,
  number INTEGER NOT NULL CHECK (number >= 1),
  -- 1 an issue, 2 a pull request.
  kind INTEGER NOT NULL CHECK (kind IN (1, 2)),
  -- 1 open, 2 closed, 3 merged; open_state folds merged into closed (as listings do).
  state INTEGER CHECK (state IN (1, 2, 3)),
  open_state INTEGER CHECK (open_state IN (1, 2)),
  state_reason TEXT,
  draft INTEGER NOT NULL DEFAULT 0 CHECK (draft IN (0, 1)),
  locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
  lock_reason TEXT,
  author_id TEXT,
  author_root TEXT,
  -- Principal ids and label ids, ascending, as the snapshot carries them.
  assignees TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(assignees)),
  labels TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(labels)),
  milestone INTEGER,
  title TEXT,
  body TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  closed_at INTEGER,
  merged_at INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  epoch_gen INTEGER NOT NULL,
  owner_gen INTEGER NOT NULL,
  version INTEGER NOT NULL,
  -- The sequence of the event that wrote the row.
  updated_seq INTEGER NOT NULL,
  UNIQUE (repo_id, number),
  CHECK (deleted = 1 OR (state IS NOT NULL AND open_state IS NOT NULL AND title IS NOT NULL
    AND created_at IS NOT NULL AND updated_at IS NOT NULL))
) STRICT;

-- Listing and sorting a repository's open or closed (merged included) ones, and
-- its merged ones, by update and by creation; doc_id breaks ties.
CREATE INDEX search_docs_open_updated ON search_docs (repo_id, open_state, updated_at, doc_id)
  WHERE deleted = 0;
CREATE INDEX search_docs_open_created ON search_docs (repo_id, open_state, created_at, doc_id)
  WHERE deleted = 0;
CREATE INDEX search_docs_state_updated ON search_docs (repo_id, state, updated_at, doc_id)
  WHERE deleted = 0;
CREATE INDEX search_docs_state_created ON search_docs (repo_id, state, created_at, doc_id)
  WHERE deleted = 0;

-- Labels, for qualifiers and items (renames and deletions resolved through them).
CREATE TABLE search_labels (
  repo_id TEXT NOT NULL,
  label_id INTEGER NOT NULL CHECK (label_id >= 1),
  name TEXT,
  color TEXT,
  description TEXT,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  epoch_gen INTEGER NOT NULL,
  owner_gen INTEGER NOT NULL,
  version INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL,
  PRIMARY KEY (repo_id, label_id),
  CHECK (deleted = 1 OR (name IS NOT NULL AND color IS NOT NULL))
) STRICT;

-- Milestones, for qualifiers and items (no counts: those depend on who reads).
CREATE TABLE search_milestones (
  repo_id TEXT NOT NULL,
  number INTEGER NOT NULL CHECK (number >= 1),
  title TEXT,
  -- 1 open, 2 closed.
  state INTEGER CHECK (state IN (1, 2)),
  description TEXT,
  due_on INTEGER,
  closed_at INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  epoch_gen INTEGER NOT NULL,
  owner_gen INTEGER NOT NULL,
  version INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL,
  PRIMARY KEY (repo_id, number),
  CHECK (deleted = 1 OR (title IS NOT NULL AND state IS NOT NULL))
) STRICT;

-- Each source repository's search state. The cutoff: the position its last
-- completed export started at; events at or before it are refused (everything
-- they carry is in the export or superseded).
CREATE TABLE search_sources (
  repo_id TEXT PRIMARY KEY,
  cutoff_epoch INTEGER NOT NULL,
  cutoff_seq INTEGER NOT NULL
) STRICT;
