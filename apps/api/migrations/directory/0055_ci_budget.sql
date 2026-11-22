-- CI's daily allowance on Free (src/ci/budget.ts): one ledger for the deployment, modeled on
-- live's (0033). A grant pays before the work and is debited atomically against every UTC day
-- (D1's clock) it may run on; its receipt is its idempotent identity. Only the per-minute part
-- of a job is refunded, once. Nothing grants here yet.

-- A UTC day's spending, in each resource, and the part of it viewer receipts took.
CREATE TABLE ci_budget_days (
  day INTEGER PRIMARY KEY CHECK (day >= 0),
  do_requests INTEGER NOT NULL DEFAULT 0 CHECK (do_requests BETWEEN 0 AND 9007199254740991),
  do_rows_read INTEGER NOT NULL DEFAULT 0 CHECK (do_rows_read BETWEEN 0 AND 9007199254740991),
  do_rows_written INTEGER NOT NULL DEFAULT 0 CHECK (do_rows_written BETWEEN 0 AND 9007199254740991),
  do_duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (do_duration_ms BETWEEN 0 AND 9007199254740991),
  d1_rows_read INTEGER NOT NULL DEFAULT 0 CHECK (d1_rows_read BETWEEN 0 AND 9007199254740991),
  d1_rows_written INTEGER NOT NULL DEFAULT 0 CHECK (d1_rows_written BETWEEN 0 AND 9007199254740991),
  queue_ops INTEGER NOT NULL DEFAULT 0 CHECK (queue_ops BETWEEN 0 AND 9007199254740991),
  worker_requests INTEGER NOT NULL DEFAULT 0 CHECK (worker_requests BETWEEN 0 AND 9007199254740991),
  r2_class_b INTEGER NOT NULL DEFAULT 0 CHECK (r2_class_b BETWEEN 0 AND 9007199254740991),
  viewer_do_requests INTEGER NOT NULL DEFAULT 0 CHECK (viewer_do_requests BETWEEN 0 AND do_requests),
  viewer_do_rows_read INTEGER NOT NULL DEFAULT 0 CHECK (viewer_do_rows_read BETWEEN 0 AND do_rows_read),
  viewer_do_rows_written INTEGER NOT NULL DEFAULT 0 CHECK (viewer_do_rows_written BETWEEN 0 AND do_rows_written),
  viewer_do_duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (viewer_do_duration_ms BETWEEN 0 AND do_duration_ms),
  viewer_d1_rows_read INTEGER NOT NULL DEFAULT 0 CHECK (viewer_d1_rows_read BETWEEN 0 AND d1_rows_read),
  viewer_d1_rows_written INTEGER NOT NULL DEFAULT 0 CHECK (viewer_d1_rows_written BETWEEN 0 AND d1_rows_written),
  viewer_queue_ops INTEGER NOT NULL DEFAULT 0 CHECK (viewer_queue_ops BETWEEN 0 AND queue_ops),
  viewer_worker_requests INTEGER NOT NULL DEFAULT 0 CHECK (viewer_worker_requests BETWEEN 0 AND worker_requests),
  viewer_r2_class_b INTEGER NOT NULL DEFAULT 0 CHECK (viewer_r2_class_b BETWEEN 0 AND r2_class_b)
) STRICT;

-- Grants by key. A granted receipt charged `fixed` plus `per_minute` times `minutes` on every day
-- from `first_day` to `last_day`; its span (`span_from`, `span_until`, D1's milliseconds) is what
-- a settlement's times are clamped to. A key released before it was granted is a tombstone (no
-- kind, no charge) that answers a later grant `released`. `mint` is the granting batch's own.
-- Kept until a day past `expires_at`, which is never before `valid_until`.
CREATE TABLE ci_budget_receipts (
  key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 200),
  kind TEXT CHECK (kind IN ('job', 'viewer')),
  account_id TEXT,
  first_day INTEGER,
  last_day INTEGER,
  span_from INTEGER,
  span_until INTEGER,
  fixed TEXT CHECK (fixed IS NULL OR (json_valid(fixed) AND json_type(fixed) = 'object')),
  per_minute TEXT CHECK (per_minute IS NULL OR (json_valid(per_minute) AND json_type(per_minute) = 'object')),
  minutes INTEGER CHECK (minutes IS NULL OR minutes BETWEEN 0 AND 10080),
  mint TEXT,
  valid_until INTEGER CHECK (valid_until IS NULL OR valid_until >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at >= coalesce(valid_until, 0)),
  state TEXT NOT NULL CHECK (state IN ('granted', 'settled', 'released')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  CHECK (
    (kind IS NULL AND state = 'released' AND account_id IS NULL AND first_day IS NULL
      AND last_day IS NULL AND span_from IS NULL AND span_until IS NULL AND fixed IS NULL
      AND per_minute IS NULL AND minutes IS NULL AND mint IS NULL)
    OR (kind IS NOT NULL AND account_id IS NOT NULL AND valid_until IS NOT NULL
      AND first_day IS NOT NULL AND last_day IS NOT NULL AND span_from IS NOT NULL
      AND span_until IS NOT NULL
      AND first_day >= 0 AND last_day >= first_day AND span_from >= 0 AND span_until > span_from
      AND fixed IS NOT NULL AND per_minute IS NOT NULL AND minutes IS NOT NULL AND mint IS NOT NULL)
  )
) STRICT;
CREATE INDEX ci_budget_receipts_expiry ON ci_budget_receipts (expires_at);

-- Runners' daily polling (the UTC day by D1's clock and the polls leased on it) and why a runner
-- was revoked: deleted by an owner, polling past its daily budget, past the fleet's size, or an
-- ephemeral runner's report window over.
ALTER TABLE ci_runners ADD COLUMN poll_day INTEGER NOT NULL DEFAULT 0 CHECK (poll_day >= 0);
ALTER TABLE ci_runners ADD COLUMN poll_used INTEGER NOT NULL DEFAULT 0 CHECK (poll_used >= 0);
ALTER TABLE ci_runners ADD COLUMN revoked_reason TEXT
  CHECK (revoked_reason IN ('deleted', 'poll_rate', 'fleet_cap', 'spent'));

-- Until now an owner's delete was the only revocation.
UPDATE ci_runners SET revoked_reason = 'deleted' WHERE revoked_at IS NOT NULL;
-- An ephemeral runner past its report window is refused already; stamped revoked, it leaves the
-- index of runners that may still serve.
UPDATE ci_runners SET revoked_at = expires_at, revoked_reason = 'spent'
  WHERE revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at <= unixepoch() * 1000;

-- Runners that may still serve: long-lived ones (no expiry) and ephemeral ones by expiry, each
-- counted as a range of this index, so expired history is never scanned.
CREATE INDEX ci_runners_live ON ci_runners (expires_at, id) WHERE revoked_at IS NULL;

-- Runners no longer serving, by the UTC day of their polls: registration's sum of today's polls
-- by inactive runners must read through this index (only today's revoked rows).
CREATE INDEX ci_runners_polls ON ci_runners (poll_day) WHERE revoked_at IS NOT NULL;
