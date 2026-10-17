-- table consumer_epochs
CREATE TABLE consumer_epochs (
  source_id TEXT PRIMARY KEY,
  epoch_gen INTEGER NOT NULL CHECK (epoch_gen >= 1),
  updated_at INTEGER NOT NULL
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

-- index effects_done
CREATE INDEX effects_done ON effects (done_at) WHERE state = 'done';

-- index effects_due_order
CREATE INDEX effects_due_order ON effects (next_attempt_at, effect_id) WHERE state = 'pending';

-- index effects_failed
CREATE INDEX effects_failed ON effects (next_attempt_at) WHERE state = 'failed';

-- index repos_owner
CREATE INDEX repos_owner ON repos (owner_id, name) WHERE deleted = 0;

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
