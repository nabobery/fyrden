-- Failed effects, pruned after the effects' retention like delivered ones.
CREATE INDEX effects_failed ON effects (next_attempt_at) WHERE state = 'failed';

-- Webhook deliveries: one per event and hook, keyed by its webhook-id (a
-- hash of the event and the hook, the same on every attempt), with the
-- payload's bytes in R2 under `payload_key`. This table is authoritative
-- for when an attempt is due: each attempt is a queue message, and a cron
-- sends one again for a due delivery whose message was lost. Only a
-- delivery's claim holder (lease_token) records an attempt or an outcome.
-- Kept 30 days (expires_at), the payload's object first.

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
) STRICT;

CREATE INDEX webhook_deliveries_hook ON webhook_deliveries (repo_id, hook_id, created_at);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (next_attempt_at) WHERE state = 'pending';
CREATE INDEX webhook_deliveries_expiry ON webhook_deliveries (expires_at);
-- A hook's waiting deliveries, counted when one is admitted (bounded by its cap,
-- whatever its history).
CREATE INDEX webhook_deliveries_pending ON webhook_deliveries (repo_id, hook_id) WHERE state = 'pending';
-- The deliveries sharing an event's body, deleted with it.
CREATE INDEX webhook_deliveries_payload ON webhook_deliveries (payload_key, delivery_id);
-- Claims that died: the cron seeks the ones whose attempts are spent (few) by their count.
CREATE INDEX webhook_deliveries_leased ON webhook_deliveries (attempts, lease_until)
  WHERE state = 'pending' AND lease_until IS NOT NULL;
-- Hooks still to be turned off after a 410.
CREATE INDEX webhook_deliveries_disable ON webhook_deliveries (disable_retry_at)
  WHERE disable_hook_version IS NOT NULL;
-- A hook's newest finished delivery (its last response).
CREATE INDEX webhook_deliveries_finished ON webhook_deliveries (repo_id, hook_id, updated_at, delivery_id)
  WHERE state IN ('done', 'failed');

-- Each attempt: what it was sent to, under which hook configuration, and
-- what came back (no request header values beyond the delivery's ids).
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
