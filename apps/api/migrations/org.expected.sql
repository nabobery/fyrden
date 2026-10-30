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
, admitted TEXT) STRICT;

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
  updated_seq INTEGER NOT NULL, deleted_epoch INTEGER, deleted_seq INTEGER,
  UNIQUE (repo_id, number),
  CHECK (deleted = 1 OR (state IS NOT NULL AND open_state IS NOT NULL AND title IS NOT NULL
    AND created_at IS NOT NULL AND updated_at IS NOT NULL))
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
  CHECK (partial IN (0, 1))) STRICT;

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
) STRICT;

-- table search_size
CREATE TABLE search_size (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  clock INTEGER NOT NULL,
  observed INTEGER NOT NULL,
  bytes INTEGER NOT NULL
) STRICT;

-- table search_sources
CREATE TABLE search_sources (
  repo_id TEXT PRIMARY KEY,
  cutoff_epoch INTEGER NOT NULL,
  cutoff_seq INTEGER NOT NULL
) STRICT;

-- table search_sweep
CREATE TABLE search_sweep (
  name TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  deleted_epoch INTEGER NOT NULL,
  deleted_seq INTEGER NOT NULL,
  row INTEGER NOT NULL
) STRICT;

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
CREATE INDEX search_repairs_due ON search_repairs (next_at, repo_id) WHERE dirty > covered;

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

-- trigger read_model_consumer_epochs_delete
CREATE TRIGGER read_model_consumer_epochs_delete BEFORE DELETE ON consumer_epochs
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_consumer_epochs_insert
CREATE TRIGGER read_model_consumer_epochs_insert BEFORE INSERT ON consumer_epochs
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_consumer_epochs_update
CREATE TRIGGER read_model_consumer_epochs_update BEFORE UPDATE ON consumer_epochs
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_discretionary_hours_delete
CREATE TRIGGER read_model_discretionary_hours_delete BEFORE DELETE ON discretionary_hours
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_discretionary_hours_insert
CREATE TRIGGER read_model_discretionary_hours_insert BEFORE INSERT ON discretionary_hours
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_discretionary_hours_update
CREATE TRIGGER read_model_discretionary_hours_update BEFORE UPDATE ON discretionary_hours
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_discretionary_state_delete
CREATE TRIGGER read_model_discretionary_state_delete BEFORE DELETE ON discretionary_state
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_discretionary_state_insert
CREATE TRIGGER read_model_discretionary_state_insert BEFORE INSERT ON discretionary_state
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_discretionary_state_update
CREATE TRIGGER read_model_discretionary_state_update BEFORE UPDATE ON discretionary_state
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_effects_delete
CREATE TRIGGER read_model_effects_delete BEFORE DELETE ON effects
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_effects_insert
CREATE TRIGGER read_model_effects_insert BEFORE INSERT ON effects
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_effects_update
CREATE TRIGGER read_model_effects_update BEFORE UPDATE ON effects
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_events_failed_delete
CREATE TRIGGER read_model_events_failed_delete BEFORE DELETE ON events_failed
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_events_failed_insert
CREATE TRIGGER read_model_events_failed_insert BEFORE INSERT ON events_failed
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_events_failed_update
CREATE TRIGGER read_model_events_failed_update BEFORE UPDATE ON events_failed
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_read_model_barrier_delete
CREATE TRIGGER read_model_read_model_barrier_delete BEFORE DELETE ON read_model_barrier
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_read_model_barrier_insert
CREATE TRIGGER read_model_read_model_barrier_insert BEFORE INSERT ON read_model_barrier
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_read_model_barrier_update
CREATE TRIGGER read_model_read_model_barrier_update BEFORE UPDATE ON read_model_barrier
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_repos_delete
CREATE TRIGGER read_model_repos_delete BEFORE DELETE ON repos
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_repos_insert
CREATE TRIGGER read_model_repos_insert BEFORE INSERT ON repos
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_repos_update
CREATE TRIGGER read_model_repos_update BEFORE UPDATE ON repos
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_search_budget_delete
CREATE TRIGGER read_model_search_budget_delete BEFORE DELETE ON search_budget
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_search_budget_insert
CREATE TRIGGER read_model_search_budget_insert BEFORE INSERT ON search_budget
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_search_budget_update
CREATE TRIGGER read_model_search_budget_update BEFORE UPDATE ON search_budget
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_search_docs_delete
CREATE TRIGGER read_model_search_docs_delete BEFORE DELETE ON search_docs
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_search_docs_insert
CREATE TRIGGER read_model_search_docs_insert BEFORE INSERT ON search_docs
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_search_docs_update
CREATE TRIGGER read_model_search_docs_update BEFORE UPDATE ON search_docs
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_search_labels_delete
CREATE TRIGGER read_model_search_labels_delete BEFORE DELETE ON search_labels
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_search_labels_insert
CREATE TRIGGER read_model_search_labels_insert BEFORE INSERT ON search_labels
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_search_labels_update
CREATE TRIGGER read_model_search_labels_update BEFORE UPDATE ON search_labels
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_search_milestones_delete
CREATE TRIGGER read_model_search_milestones_delete BEFORE DELETE ON search_milestones
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_search_milestones_insert
CREATE TRIGGER read_model_search_milestones_insert BEFORE INSERT ON search_milestones
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_search_milestones_update
CREATE TRIGGER read_model_search_milestones_update BEFORE UPDATE ON search_milestones
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_search_reconciles_delete
CREATE TRIGGER read_model_search_reconciles_delete BEFORE DELETE ON search_reconciles
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_search_reconciles_insert
CREATE TRIGGER read_model_search_reconciles_insert BEFORE INSERT ON search_reconciles
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_search_reconciles_update
CREATE TRIGGER read_model_search_reconciles_update BEFORE UPDATE ON search_reconciles
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_search_repairs_delete
CREATE TRIGGER read_model_search_repairs_delete BEFORE DELETE ON search_repairs
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_search_repairs_insert
CREATE TRIGGER read_model_search_repairs_insert BEFORE INSERT ON search_repairs
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_search_repairs_update
CREATE TRIGGER read_model_search_repairs_update BEFORE UPDATE ON search_repairs
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_search_size_delete
CREATE TRIGGER read_model_search_size_delete BEFORE DELETE ON search_size
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_search_size_insert
CREATE TRIGGER read_model_search_size_insert BEFORE INSERT ON search_size
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_search_size_update
CREATE TRIGGER read_model_search_size_update BEFORE UPDATE ON search_size
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_search_sources_delete
CREATE TRIGGER read_model_search_sources_delete BEFORE DELETE ON search_sources
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_search_sources_insert
CREATE TRIGGER read_model_search_sources_insert BEFORE INSERT ON search_sources
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_search_sources_update
CREATE TRIGGER read_model_search_sources_update BEFORE UPDATE ON search_sources
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_search_sweep_delete
CREATE TRIGGER read_model_search_sweep_delete BEFORE DELETE ON search_sweep
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_search_sweep_insert
CREATE TRIGGER read_model_search_sweep_insert BEFORE INSERT ON search_sweep
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_search_sweep_update
CREATE TRIGGER read_model_search_sweep_update BEFORE UPDATE ON search_sweep
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_source_owner_delete
CREATE TRIGGER read_model_source_owner_delete BEFORE DELETE ON source_owner
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_source_owner_insert
CREATE TRIGGER read_model_source_owner_insert BEFORE INSERT ON source_owner
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_source_owner_update
CREATE TRIGGER read_model_source_owner_update BEFORE UPDATE ON source_owner
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_webhook_attempts_delete
CREATE TRIGGER read_model_webhook_attempts_delete BEFORE DELETE ON webhook_attempts
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_webhook_attempts_insert
CREATE TRIGGER read_model_webhook_attempts_insert BEFORE INSERT ON webhook_attempts
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_webhook_attempts_update
CREATE TRIGGER read_model_webhook_attempts_update BEFORE UPDATE ON webhook_attempts
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_webhook_deliveries_delete
CREATE TRIGGER read_model_webhook_deliveries_delete BEFORE DELETE ON webhook_deliveries
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_webhook_deliveries_insert
CREATE TRIGGER read_model_webhook_deliveries_insert BEFORE INSERT ON webhook_deliveries
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_webhook_deliveries_update
CREATE TRIGGER read_model_webhook_deliveries_update BEFORE UPDATE ON webhook_deliveries
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_webhook_payloads_delete
CREATE TRIGGER read_model_webhook_payloads_delete BEFORE DELETE ON webhook_payloads
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_webhook_payloads_insert
CREATE TRIGGER read_model_webhook_payloads_insert BEFORE INSERT ON webhook_payloads
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

-- trigger read_model_webhook_payloads_update
CREATE TRIGGER read_model_webhook_payloads_update BEFORE UPDATE ON webhook_payloads
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;
