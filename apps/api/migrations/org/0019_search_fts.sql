-- Full-text indexes of search's projections: issues and pull requests (`search_fts`: title,
-- body, and tokens of the repository and the kind) and repositories (`search_repos_fts`: name,
-- description, and a token of the owner), external content read through views of the
-- projections, and their vocabularies. Repositories and owners get numbers of their own for the
-- tokens, allocated from counters in the transaction that maps them, never reused. A
-- projection's write and its index's change are one statement group: the old indexed tuple
-- deleted, the row written (a token marking a tuple to index), the new tuple inserted.
-- `search_byte_reservations` and `search_size.bytes_reserved` are for byte admission. The
-- indexes start empty: nothing is indexed here. The new ordinary tables refuse writes outside
-- the executor's admission as the others do (0018); virtual and shadow tables take no triggers.
ALTER TABLE search_docs ADD COLUMN fts_token TEXT;

CREATE TABLE search_repo_nums (
  repo_id TEXT PRIMARY KEY,
  num INTEGER NOT NULL UNIQUE,
  indexed INTEGER NOT NULL DEFAULT 0 CHECK (indexed IN (0, 1)),
  indexed_epoch INTEGER,
  indexed_owner_gen INTEGER,
  indexed_version INTEGER,
  fts_token TEXT
) STRICT;

CREATE TABLE search_owner_nums (
  owner_id TEXT PRIMARY KEY,
  num INTEGER NOT NULL UNIQUE
) STRICT;

CREATE TABLE search_index_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_repo_num INTEGER NOT NULL,
  next_owner_num INTEGER NOT NULL,
  live_docs INTEGER NOT NULL DEFAULT 0,
  indexed_repos INTEGER NOT NULL DEFAULT 0,
  recovery_gen INTEGER NOT NULL DEFAULT 0
) STRICT;

INSERT INTO search_index_state (id, next_repo_num, next_owner_num) VALUES (1, 1, 1);

CREATE TABLE search_byte_reservations (
  token TEXT PRIMARY KEY,
  day INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 0)
) STRICT;

ALTER TABLE search_size ADD COLUMN bytes_reserved INTEGER NOT NULL DEFAULT 0
  CHECK (bytes_reserved >= 0);

CREATE VIEW search_live AS
SELECT d.doc_id, d.title, d.body, 'r' || n.num AS repo, 'k' || d.kind AS kind
FROM search_docs d
JOIN search_repo_nums n ON n.repo_id = d.repo_id
WHERE d.deleted = 0;

CREATE VIRTUAL TABLE search_fts USING fts5(
  title, body, repo, kind,
  content = 'search_live',
  content_rowid = 'doc_id',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE VIEW search_repos_live AS
SELECT n.num AS doc_id, r.name, r.description, 'o' || o.num AS owner
FROM repos r
JOIN search_repo_nums n ON n.repo_id = r.repo_id
JOIN search_owner_nums o ON o.owner_id = r.owner_id
WHERE r.deleted = 0 AND n.indexed = 1;

CREATE VIRTUAL TABLE search_repos_fts USING fts5(
  name, description, owner,
  content = 'search_repos_live',
  content_rowid = 'doc_id',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE search_vocab USING fts5vocab(search_fts, 'row');
CREATE VIRTUAL TABLE search_repos_vocab USING fts5vocab(search_repos_fts, 'row');

CREATE TRIGGER read_model_search_repo_nums_insert BEFORE INSERT ON search_repo_nums
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

CREATE TRIGGER read_model_search_repo_nums_update BEFORE UPDATE ON search_repo_nums
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

CREATE TRIGGER read_model_search_repo_nums_delete BEFORE DELETE ON search_repo_nums
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

CREATE TRIGGER read_model_search_owner_nums_insert BEFORE INSERT ON search_owner_nums
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

CREATE TRIGGER read_model_search_owner_nums_update BEFORE UPDATE ON search_owner_nums
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

CREATE TRIGGER read_model_search_owner_nums_delete BEFORE DELETE ON search_owner_nums
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

CREATE TRIGGER read_model_search_index_state_insert BEFORE INSERT ON search_index_state
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

CREATE TRIGGER read_model_search_index_state_update BEFORE UPDATE ON search_index_state
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

CREATE TRIGGER read_model_search_index_state_delete BEFORE DELETE ON search_index_state
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

CREATE TRIGGER read_model_search_byte_reservations_insert BEFORE INSERT ON search_byte_reservations
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

CREATE TRIGGER read_model_search_byte_reservations_update BEFORE UPDATE ON search_byte_reservations
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

CREATE TRIGGER read_model_search_byte_reservations_delete BEFORE DELETE ON search_byte_reservations
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;
