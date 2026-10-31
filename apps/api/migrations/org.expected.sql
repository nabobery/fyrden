-- table consumer_epochs
CREATE TABLE consumer_epochs (
  source_id TEXT PRIMARY KEY,
  epoch_gen INTEGER NOT NULL CHECK (epoch_gen >= 1),
  updated_at INTEGER NOT NULL
) STRICT;

-- table discretionary_hours
CREATE TABLE discretionary_hours (
  hour INTEGER PRIMARY KEY,
  do_requests INTEGER NOT NULL DEFAULT 0,
  do_rows_read INTEGER NOT NULL DEFAULT 0,
  do_rows_written INTEGER NOT NULL DEFAULT 0,
  do_duration_ms INTEGER NOT NULL DEFAULT 0,
  d1_rows_read INTEGER NOT NULL DEFAULT 0,
  d1_rows_written INTEGER NOT NULL DEFAULT 0,
  queue_ops INTEGER NOT NULL DEFAULT 0,
  granted INTEGER NOT NULL DEFAULT 0,
  last_grant TEXT
) STRICT;

-- table discretionary_state
CREATE TABLE discretionary_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  refused_day INTEGER NOT NULL,
  warn_until INTEGER NOT NULL
) STRICT;

-- table effects
CREATE TABLE effects (
  effect_id TEXT PRIMARY KEY,
  sink TEXT NOT NULL,
  target TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  -- Who is delivering it and until when: a delivery claims the row, and
  -- only the claim's holder records the outcome.
  lease_token TEXT,
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  done_at INTEGER
, source_id TEXT, epoch_gen INTEGER, owner_gen INTEGER, any_owner INTEGER NOT NULL DEFAULT 0 CHECK (any_owner IN (0, 1)), recover_at INTEGER NOT NULL DEFAULT 0, deliver_until INTEGER, max_attempts INTEGER CHECK (max_attempts IS NULL OR max_attempts >= 1)) STRICT;

-- table events_failed
CREATE TABLE events_failed (
  -- The dead letter's message id.
  id TEXT PRIMARY KEY,
  -- The source the envelope came from; null when it could not be read.
  source_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('repository', 'account', 'malformed')),
  -- Its events' positions and types (JSON), when it could be read.
  epoch_gen INTEGER,
  first_seq INTEGER,
  last_seq INTEGER,
  types TEXT CHECK (types IS NULL OR json_valid(types)),
  -- The envelope as it arrived (JSON), until it expires.
  envelope TEXT,
  reason TEXT,
  at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

-- table read_model_barrier
CREATE TABLE read_model_barrier (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  phase TEXT NOT NULL CHECK (phase IN ('running', 'pausing', 'paused', 'recovering')),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  protocol_version INTEGER NOT NULL CHECK (protocol_version >= 1)
) STRICT;

-- table read_model_restore_token
CREATE TABLE read_model_restore_token (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token TEXT NOT NULL
) STRICT;

-- table read_model_write
CREATE TABLE read_model_write (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  open INTEGER NOT NULL DEFAULT 0 CHECK (open IN (0, 1)),
  stray INTEGER NOT NULL DEFAULT 0 CHECK (stray >= 0),
  seq INTEGER NOT NULL DEFAULT 0 CHECK (seq >= 0),
  lease_id TEXT,
  generation INTEGER,
  protocol_version INTEGER,
  until INTEGER,
  mode TEXT CHECK (mode IS NULL OR mode IN ('ordinary', 'maintenance')),
  CHECK (
    open = 0 OR coalesce(
      lease_id IS NOT NULL AND generation >= 1 AND protocol_version >= 1 AND until > 0
        AND mode IS NOT NULL,
      0
    )
  )
) STRICT;

-- table repos
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
, description TEXT) STRICT;

-- table search_budget
CREATE TABLE search_budget (
  -- Days since the Unix epoch, UTC.
  day INTEGER PRIMARY KEY,
  -- Projection rows written (as D1 counts them).
  rows INTEGER NOT NULL DEFAULT 0,
  -- Rows reconciliations read.
  reads INTEGER NOT NULL DEFAULT 0
, admitted TEXT, repo_rows INTEGER NOT NULL DEFAULT 0
  CHECK (repo_rows >= 0), interactive_reads INTEGER NOT NULL DEFAULT 0
  CHECK (interactive_reads >= 0), recovery_rows INTEGER NOT NULL DEFAULT 0
  CHECK (recovery_rows >= 0), recovery_reads INTEGER NOT NULL DEFAULT 0
  CHECK (recovery_reads >= 0)) STRICT;

-- table search_byte_reservations
CREATE TABLE search_byte_reservations (
  token TEXT PRIMARY KEY,
  day INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 0)
) STRICT;

-- table search_docs
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
  updated_seq INTEGER NOT NULL, deleted_epoch INTEGER, deleted_seq INTEGER, fts_token TEXT,
  UNIQUE (repo_id, number),
  CHECK (deleted = 1 OR (state IS NOT NULL AND open_state IS NOT NULL AND title IS NOT NULL
    AND created_at IS NOT NULL AND updated_at IS NOT NULL))
) STRICT;

-- table search_fts
CREATE VIRTUAL TABLE search_fts USING fts5(
  title, body, repo, kind,
  content = 'search_live',
  content_rowid = 'doc_id',
  tokenize = 'unicode61 remove_diacritics 2'
);

-- table search_fts_config
CREATE TABLE 'search_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID;

-- table search_fts_data
CREATE TABLE 'search_fts_data'(id INTEGER PRIMARY KEY, block BLOB);

-- table search_fts_docsize
CREATE TABLE 'search_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB);

-- table search_fts_idx
CREATE TABLE 'search_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;

-- table search_index_state
CREATE TABLE search_index_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_repo_num INTEGER NOT NULL,
  next_owner_num INTEGER NOT NULL,
  live_docs INTEGER NOT NULL DEFAULT 0,
  indexed_repos INTEGER NOT NULL DEFAULT 0,
  recovery_gen INTEGER NOT NULL DEFAULT 0
) STRICT;

-- table search_labels
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
  updated_seq INTEGER NOT NULL, deleted_epoch INTEGER, deleted_seq INTEGER,
  PRIMARY KEY (repo_id, label_id),
  CHECK (deleted = 1 OR (name IS NOT NULL AND color IS NOT NULL))
) STRICT;

-- table search_milestones
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
  updated_seq INTEGER NOT NULL, deleted_epoch INTEGER, deleted_seq INTEGER,
  PRIMARY KEY (repo_id, number),
  CHECK (deleted = 1 OR (title IS NOT NULL AND state IS NOT NULL))
) STRICT;

-- table search_owner_nums
CREATE TABLE search_owner_nums (
  owner_id TEXT PRIMARY KEY,
  num INTEGER NOT NULL UNIQUE
) STRICT;

-- table search_reconciles
CREATE TABLE search_reconciles (
  repo_id TEXT PRIMARY KEY,
  gen INTEGER NOT NULL CHECK (gen >= 1),
  epoch_gen INTEGER NOT NULL,
  owner_gen INTEGER NOT NULL,
  watermark INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('subjects', 'labels', 'milestones', 'done')),
  after INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL
, partial INTEGER NOT NULL DEFAULT 0
  CHECK (partial IN (0, 1)), coverage INTEGER NOT NULL DEFAULT 0
  CHECK (coverage IN (0, 1)), partial_reason TEXT, recovery_gen INTEGER NOT NULL DEFAULT 0
  CHECK (recovery_gen >= 0)) STRICT;

-- table search_repairs
CREATE TABLE search_repairs (
  repo_id TEXT PRIMARY KEY,
  dirty INTEGER NOT NULL,
  active INTEGER,
  covered INTEGER NOT NULL DEFAULT 0,
  -- Why the newest revision was asked for, and since when one has been pending.
  reason TEXT NOT NULL,
  since INTEGER NOT NULL,
  next_at INTEGER NOT NULL
, blocked_reason TEXT, retry_at INTEGER NOT NULL DEFAULT 0) STRICT;

-- table search_repo_nums
CREATE TABLE search_repo_nums (
  repo_id TEXT PRIMARY KEY,
  num INTEGER NOT NULL UNIQUE,
  indexed INTEGER NOT NULL DEFAULT 0 CHECK (indexed IN (0, 1)),
  indexed_epoch INTEGER,
  indexed_owner_gen INTEGER,
  indexed_version INTEGER,
  fts_token TEXT
) STRICT;

-- table search_repos_fts
CREATE VIRTUAL TABLE search_repos_fts USING fts5(
  name, description, owner,
  content = 'search_repos_live',
  content_rowid = 'doc_id',
  tokenize = 'unicode61 remove_diacritics 2'
);

-- table search_repos_fts_config
CREATE TABLE 'search_repos_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID;

-- table search_repos_fts_data
CREATE TABLE 'search_repos_fts_data'(id INTEGER PRIMARY KEY, block BLOB);

-- table search_repos_fts_docsize
CREATE TABLE 'search_repos_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB);

-- table search_repos_fts_idx
CREATE TABLE 'search_repos_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;

-- table search_repos_vocab
CREATE VIRTUAL TABLE search_repos_vocab USING fts5vocab(search_repos_fts, 'row');

-- table search_size
CREATE TABLE search_size (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  clock INTEGER NOT NULL,
  observed INTEGER NOT NULL,
  bytes INTEGER NOT NULL
, bytes_reserved INTEGER NOT NULL DEFAULT 0
  CHECK (bytes_reserved >= 0)) STRICT;

-- table search_sources
CREATE TABLE search_sources (
  repo_id TEXT PRIMARY KEY,
  cutoff_epoch INTEGER NOT NULL,
  cutoff_seq INTEGER NOT NULL
, index_covered INTEGER NOT NULL DEFAULT 0
  CHECK (index_covered IN (0, 1)), visible_gen INTEGER NOT NULL DEFAULT 0
  CHECK (visible_gen >= 0)) STRICT;

-- table search_sweep
CREATE TABLE search_sweep (
  name TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  deleted_epoch INTEGER NOT NULL,
  deleted_seq INTEGER NOT NULL,
  row INTEGER NOT NULL
) STRICT;

-- table search_vocab
CREATE VIRTUAL TABLE search_vocab USING fts5vocab(search_fts, 'row');

-- table source_owner
CREATE TABLE source_owner (
  source_id TEXT PRIMARY KEY,
  owner_gen INTEGER NOT NULL CHECK (owner_gen >= 1)
) STRICT;

-- table webhook_attempts
CREATE TABLE webhook_attempts (
  delivery_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  at INTEGER NOT NULL,
  config_version INTEGER,
  url TEXT,
  status INTEGER,
  duration_ms INTEGER,
  response_excerpt TEXT,
  error TEXT,
  PRIMARY KEY (delivery_id, n)
) STRICT;

-- table webhook_deliveries
CREATE TABLE webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  hook_id INTEGER NOT NULL,
  event TEXT NOT NULL,
  action TEXT,
  -- The repository was private when the event happened: https only, whatever it is now.
  private INTEGER NOT NULL CHECK (private IN (0, 1)),
  payload_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'done', 'failed', 'cancelled', 'dropped')),
  reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  -- When a message for the next attempt was last sent (the cron sends one again when it is lost).
  enqueued_at INTEGER,
  lease_token TEXT,
  lease_until INTEGER,
  last_status INTEGER,
  -- The receiver answered 410 Gone: the hook is to be turned off, if still at this configuration
  -- version (set with the outcome, cleared once the repository object has been told).
  disable_hook_version INTEGER,
  -- When the cron next tries to turn that hook off (apart from updated_at, which orders outcomes).
  disable_retry_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
, attempt_limit INTEGER) STRICT;

-- table webhook_payloads
CREATE TABLE webhook_payloads (
  event_key TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  payload_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('intent', 'established', 'expired')),
  -- The stored body's size, once established.
  bytes INTEGER,
  expires_at INTEGER NOT NULL
) STRICT;

-- index effects_done
CREATE INDEX effects_done ON effects (done_at) WHERE state = 'done';

-- index effects_due_order
CREATE INDEX effects_due_order ON effects (next_attempt_at, effect_id) WHERE state = 'pending';

-- index effects_failed
CREATE INDEX effects_failed ON effects (next_attempt_at) WHERE state = 'failed';

-- index effects_failed_reportable
CREATE INDEX effects_failed_reportable ON effects (next_attempt_at)
  WHERE state = 'failed' AND coalesce(last_error, '') NOT LIKE 'invalidated:%';

-- index effects_recover
CREATE INDEX effects_recover ON effects (recover_at, effect_id) WHERE state = 'pending';

-- index events_failed_expiry
CREATE INDEX events_failed_expiry ON events_failed (expires_at) WHERE envelope IS NOT NULL;

-- index events_failed_source
CREATE INDEX events_failed_source ON events_failed (source_id) WHERE source_id IS NOT NULL;

-- index repos_owner
CREATE INDEX repos_owner ON repos (owner_id, name) WHERE deleted = 0;

-- index search_byte_reservations_sequence
CREATE INDEX search_byte_reservations_sequence
  ON search_byte_reservations (sequence, token);

-- index search_docs_deleted
CREATE INDEX search_docs_deleted ON search_docs (repo_id, deleted_epoch, deleted_seq)
  WHERE deleted = 1 AND deleted_epoch IS NOT NULL;

-- index search_docs_open_created
CREATE INDEX search_docs_open_created ON search_docs (repo_id, open_state, created_at, doc_id)
  WHERE deleted = 0;

-- index search_docs_open_updated
CREATE INDEX search_docs_open_updated ON search_docs (repo_id, open_state, updated_at, doc_id)
  WHERE deleted = 0;

-- index search_docs_state_created
CREATE INDEX search_docs_state_created ON search_docs (repo_id, state, created_at, doc_id)
  WHERE deleted = 0;

-- index search_docs_state_updated
CREATE INDEX search_docs_state_updated ON search_docs (repo_id, state, updated_at, doc_id)
  WHERE deleted = 0;

-- index search_labels_deleted
CREATE INDEX search_labels_deleted ON search_labels (repo_id, deleted_epoch, deleted_seq)
  WHERE deleted = 1 AND deleted_epoch IS NOT NULL;

-- index search_milestones_deleted
CREATE INDEX search_milestones_deleted ON search_milestones (repo_id, deleted_epoch, deleted_seq)
  WHERE deleted = 1 AND deleted_epoch IS NOT NULL;

-- index search_repairs_due
CREATE INDEX search_repairs_due ON search_repairs (next_at, repo_id)
  WHERE dirty > covered AND blocked_reason IS NULL;

-- index search_repairs_retry
CREATE INDEX search_repairs_retry ON search_repairs (retry_at, repo_id)
  WHERE dirty > covered AND blocked_reason IS NOT NULL;

-- index search_repo_nums_indexed
CREATE INDEX search_repo_nums_indexed ON search_repo_nums (repo_id) WHERE indexed = 1;

-- index search_sources_uncovered
CREATE INDEX search_sources_uncovered ON search_sources (repo_id) WHERE index_covered = 0;

-- index webhook_deliveries_disable
CREATE INDEX webhook_deliveries_disable ON webhook_deliveries (disable_retry_at)
  WHERE disable_hook_version IS NOT NULL;

-- index webhook_deliveries_due
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (next_attempt_at) WHERE state = 'pending';

-- index webhook_deliveries_expiry
CREATE INDEX webhook_deliveries_expiry ON webhook_deliveries (expires_at);

-- index webhook_deliveries_finished
CREATE INDEX webhook_deliveries_finished ON webhook_deliveries (repo_id, hook_id, updated_at, delivery_id)
  WHERE state IN ('done', 'failed');

-- index webhook_deliveries_hook
CREATE INDEX webhook_deliveries_hook ON webhook_deliveries (repo_id, hook_id, created_at);

-- index webhook_deliveries_leased
CREATE INDEX webhook_deliveries_leased ON webhook_deliveries (attempts, lease_until)
  WHERE state = 'pending' AND lease_until IS NOT NULL;

-- index webhook_deliveries_payload
CREATE INDEX webhook_deliveries_payload ON webhook_deliveries (payload_key, delivery_id);

-- index webhook_deliveries_pending
CREATE INDEX webhook_deliveries_pending ON webhook_deliveries (repo_id, hook_id) WHERE state = 'pending';

-- index webhook_payloads_expiry
CREATE INDEX webhook_payloads_expiry ON webhook_payloads (expires_at);

-- index webhook_payloads_repo
CREATE INDEX webhook_payloads_repo ON webhook_payloads (repo_id);

-- view search_live
CREATE VIEW search_live AS
SELECT d.doc_id, d.title, d.body, 'r' || n.num AS repo, 'k' || d.kind AS kind
FROM search_docs d
JOIN search_repo_nums n ON n.repo_id = d.repo_id
WHERE d.deleted = 0;

-- view search_repos_live
CREATE VIEW search_repos_live AS
SELECT n.num AS doc_id, r.name, r.description, 'o' || o.num AS owner
FROM repos r
JOIN search_repo_nums n ON n.repo_id = r.repo_id
JOIN search_owner_nums o ON o.owner_id = r.owner_id
WHERE r.deleted = 0 AND n.indexed = 1;

-- trigger read_model_consumer_epochs_delete
CREATE TRIGGER read_model_consumer_epochs_delete BEFORE DELETE ON consumer_epochs
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_consumer_epochs_insert
CREATE TRIGGER read_model_consumer_epochs_insert BEFORE INSERT ON consumer_epochs
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_consumer_epochs_update
CREATE TRIGGER read_model_consumer_epochs_update BEFORE UPDATE ON consumer_epochs
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_discretionary_hours_delete
CREATE TRIGGER read_model_discretionary_hours_delete BEFORE DELETE ON discretionary_hours
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_discretionary_hours_insert
CREATE TRIGGER read_model_discretionary_hours_insert BEFORE INSERT ON discretionary_hours
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_discretionary_hours_update
CREATE TRIGGER read_model_discretionary_hours_update BEFORE UPDATE ON discretionary_hours
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_discretionary_state_delete
CREATE TRIGGER read_model_discretionary_state_delete BEFORE DELETE ON discretionary_state
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_discretionary_state_insert
CREATE TRIGGER read_model_discretionary_state_insert BEFORE INSERT ON discretionary_state
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_discretionary_state_update
CREATE TRIGGER read_model_discretionary_state_update BEFORE UPDATE ON discretionary_state
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_effects_delete
CREATE TRIGGER read_model_effects_delete BEFORE DELETE ON effects
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_effects_insert
CREATE TRIGGER read_model_effects_insert BEFORE INSERT ON effects
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_effects_update
CREATE TRIGGER read_model_effects_update BEFORE UPDATE ON effects
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_events_failed_delete
CREATE TRIGGER read_model_events_failed_delete BEFORE DELETE ON events_failed
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_events_failed_insert
CREATE TRIGGER read_model_events_failed_insert BEFORE INSERT ON events_failed
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_events_failed_update
CREATE TRIGGER read_model_events_failed_update BEFORE UPDATE ON events_failed
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_read_model_barrier_delete
CREATE TRIGGER read_model_read_model_barrier_delete BEFORE DELETE ON read_model_barrier
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_read_model_barrier_insert
CREATE TRIGGER read_model_read_model_barrier_insert BEFORE INSERT ON read_model_barrier
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_read_model_barrier_update
CREATE TRIGGER read_model_read_model_barrier_update BEFORE UPDATE ON read_model_barrier
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.mode = 'maintenance' AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(OLD.protocol_version, 2)
    AND NEW.id = OLD.id AND NEW.protocol_version = OLD.protocol_version
    AND NEW.generation = w.generation AND NEW.generation >= OLD.generation
  FROM read_model_write w WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_read_model_restore_token_delete
CREATE TRIGGER read_model_read_model_restore_token_delete BEFORE DELETE ON read_model_restore_token
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_read_model_restore_token_insert
CREATE TRIGGER read_model_read_model_restore_token_insert BEFORE INSERT ON read_model_restore_token
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_read_model_restore_token_update
CREATE TRIGGER read_model_read_model_restore_token_update BEFORE UPDATE ON read_model_restore_token
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_repos_delete
CREATE TRIGGER read_model_repos_delete BEFORE DELETE ON repos
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_repos_insert
CREATE TRIGGER read_model_repos_insert BEFORE INSERT ON repos
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_repos_update
CREATE TRIGGER read_model_repos_update BEFORE UPDATE ON repos
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_search_budget_delete
CREATE TRIGGER read_model_search_budget_delete BEFORE DELETE ON search_budget
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_search_budget_insert
CREATE TRIGGER read_model_search_budget_insert BEFORE INSERT ON search_budget
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_search_budget_update
CREATE TRIGGER read_model_search_budget_update BEFORE UPDATE ON search_budget
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_search_byte_reservations_delete
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

-- trigger read_model_search_byte_reservations_insert
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

-- trigger read_model_search_byte_reservations_update
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

-- trigger read_model_search_docs_delete
CREATE TRIGGER read_model_search_docs_delete BEFORE DELETE ON search_docs
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_search_docs_insert
CREATE TRIGGER read_model_search_docs_insert BEFORE INSERT ON search_docs
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_search_docs_update
CREATE TRIGGER read_model_search_docs_update BEFORE UPDATE ON search_docs
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_search_index_state_delete
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

-- trigger read_model_search_index_state_insert
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

-- trigger read_model_search_index_state_update
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

-- trigger read_model_search_labels_delete
CREATE TRIGGER read_model_search_labels_delete BEFORE DELETE ON search_labels
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_search_labels_insert
CREATE TRIGGER read_model_search_labels_insert BEFORE INSERT ON search_labels
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_search_labels_update
CREATE TRIGGER read_model_search_labels_update BEFORE UPDATE ON search_labels
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_search_milestones_delete
CREATE TRIGGER read_model_search_milestones_delete BEFORE DELETE ON search_milestones
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_search_milestones_insert
CREATE TRIGGER read_model_search_milestones_insert BEFORE INSERT ON search_milestones
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_search_milestones_update
CREATE TRIGGER read_model_search_milestones_update BEFORE UPDATE ON search_milestones
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_search_owner_nums_delete
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

-- trigger read_model_search_owner_nums_insert
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

-- trigger read_model_search_owner_nums_update
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

-- trigger read_model_search_reconciles_delete
CREATE TRIGGER read_model_search_reconciles_delete BEFORE DELETE ON search_reconciles
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_search_reconciles_insert
CREATE TRIGGER read_model_search_reconciles_insert BEFORE INSERT ON search_reconciles
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_search_reconciles_update
CREATE TRIGGER read_model_search_reconciles_update BEFORE UPDATE ON search_reconciles
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_search_repairs_delete
CREATE TRIGGER read_model_search_repairs_delete BEFORE DELETE ON search_repairs
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_search_repairs_insert
CREATE TRIGGER read_model_search_repairs_insert BEFORE INSERT ON search_repairs
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_search_repairs_update
CREATE TRIGGER read_model_search_repairs_update BEFORE UPDATE ON search_repairs
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_search_repo_nums_delete
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

-- trigger read_model_search_repo_nums_insert
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

-- trigger read_model_search_repo_nums_update
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

-- trigger read_model_search_size_delete
CREATE TRIGGER read_model_search_size_delete BEFORE DELETE ON search_size
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_search_size_insert
CREATE TRIGGER read_model_search_size_insert BEFORE INSERT ON search_size
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_search_size_update
CREATE TRIGGER read_model_search_size_update BEFORE UPDATE ON search_size
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_search_sources_delete
CREATE TRIGGER read_model_search_sources_delete BEFORE DELETE ON search_sources
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_search_sources_insert
CREATE TRIGGER read_model_search_sources_insert BEFORE INSERT ON search_sources
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_search_sources_update
CREATE TRIGGER read_model_search_sources_update BEFORE UPDATE ON search_sources
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_search_sweep_delete
CREATE TRIGGER read_model_search_sweep_delete BEFORE DELETE ON search_sweep
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_search_sweep_insert
CREATE TRIGGER read_model_search_sweep_insert BEFORE INSERT ON search_sweep
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_search_sweep_update
CREATE TRIGGER read_model_search_sweep_update BEFORE UPDATE ON search_sweep
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_source_owner_delete
CREATE TRIGGER read_model_source_owner_delete BEFORE DELETE ON source_owner
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_source_owner_insert
CREATE TRIGGER read_model_source_owner_insert BEFORE INSERT ON source_owner
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_source_owner_update
CREATE TRIGGER read_model_source_owner_update BEFORE UPDATE ON source_owner
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_webhook_attempts_delete
CREATE TRIGGER read_model_webhook_attempts_delete BEFORE DELETE ON webhook_attempts
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_webhook_attempts_insert
CREATE TRIGGER read_model_webhook_attempts_insert BEFORE INSERT ON webhook_attempts
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_webhook_attempts_update
CREATE TRIGGER read_model_webhook_attempts_update BEFORE UPDATE ON webhook_attempts
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_webhook_deliveries_delete
CREATE TRIGGER read_model_webhook_deliveries_delete BEFORE DELETE ON webhook_deliveries
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_webhook_deliveries_insert
CREATE TRIGGER read_model_webhook_deliveries_insert BEFORE INSERT ON webhook_deliveries
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_webhook_deliveries_update
CREATE TRIGGER read_model_webhook_deliveries_update BEFORE UPDATE ON webhook_deliveries
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_webhook_payloads_delete
CREATE TRIGGER read_model_webhook_payloads_delete BEFORE DELETE ON webhook_payloads
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_webhook_payloads_insert
CREATE TRIGGER read_model_webhook_payloads_insert BEFORE INSERT ON webhook_payloads
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger read_model_webhook_payloads_update
CREATE TRIGGER read_model_webhook_payloads_update BEFORE UPDATE ON webhook_payloads
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

-- trigger search_repairs_uncover_insert
CREATE TRIGGER search_repairs_uncover_insert AFTER INSERT ON search_repairs
WHEN NEW.dirty > NEW.covered
BEGIN
  UPDATE search_sources SET index_covered = 0
  WHERE repo_id = NEW.repo_id AND index_covered <> 0;
END;

-- trigger search_repairs_uncover_update
CREATE TRIGGER search_repairs_uncover_update AFTER UPDATE OF dirty ON search_repairs
WHEN NEW.dirty > OLD.dirty AND NEW.dirty > NEW.covered
BEGIN
  UPDATE search_sources SET index_covered = 0
  WHERE repo_id = NEW.repo_id AND index_covered <> 0;
END;
