-- Live hints' daily budgets (src/live/budget.ts): one ledger for the
-- deployment, with what each live unit of work was granted, dated by UTC day
-- (D1's clock), so a grant is debited once, atomically, against the day it
-- runs on. Nothing writes here yet: live hints stay off until the funded
-- paths are wired.
--
-- The singleton: the ledger's incarnation (a directory restored by Time
-- Travel gets a new one, fencing every grant made before), the sequence that
-- orders grants (and fences recovery), the latest grant's mint (the batch's
-- own conditional transition, which every later statement of that batch
-- repeats), and the cleanup still owed for what grants left behind.
CREATE TABLE live_budget_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  incarnation TEXT NOT NULL CHECK (length(incarnation) = 32),
  grant_seq INTEGER NOT NULL DEFAULT 0 CHECK (grant_seq BETWEEN 0 AND 9007199254740991),
  last_mint TEXT,
  last_mint_at INTEGER NOT NULL DEFAULT 0 CHECK (last_mint_at >= 0),
  debt_do_requests INTEGER NOT NULL DEFAULT 0 CHECK (debt_do_requests BETWEEN 0 AND 9007199254740991),
  debt_do_rows_read INTEGER NOT NULL DEFAULT 0 CHECK (debt_do_rows_read BETWEEN 0 AND 9007199254740991),
  debt_do_rows_written INTEGER NOT NULL DEFAULT 0 CHECK (debt_do_rows_written BETWEEN 0 AND 9007199254740991),
  debt_do_duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (debt_do_duration_ms BETWEEN 0 AND 9007199254740991),
  debt_d1_rows_read INTEGER NOT NULL DEFAULT 0 CHECK (debt_d1_rows_read BETWEEN 0 AND 9007199254740991),
  debt_d1_rows_written INTEGER NOT NULL DEFAULT 0 CHECK (debt_d1_rows_written BETWEEN 0 AND 9007199254740991),
  debt_queue_ops INTEGER NOT NULL DEFAULT 0 CHECK (debt_queue_ops = 0)
) STRICT;

INSERT INTO live_budget_state (id, incarnation) VALUES (1, lower(hex(randomblob(16))));

-- A UTC day's spending: totals, the part cleanup spent (protected), the
-- duration held for operations not yet settled (at most 64 a day), how long
-- a receipt naming the day may still need it, and the cleanup the row itself
-- owes once removed.
CREATE TABLE live_budget_days (
  day INTEGER PRIMARY KEY CHECK (day >= 0),
  do_requests INTEGER NOT NULL DEFAULT 0 CHECK (do_requests BETWEEN 0 AND 9007199254740991),
  do_rows_read INTEGER NOT NULL DEFAULT 0 CHECK (do_rows_read BETWEEN 0 AND 9007199254740991),
  do_rows_written INTEGER NOT NULL DEFAULT 0 CHECK (do_rows_written BETWEEN 0 AND 9007199254740991),
  do_duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (do_duration_ms BETWEEN 0 AND 9007199254740991),
  d1_rows_read INTEGER NOT NULL DEFAULT 0 CHECK (d1_rows_read BETWEEN 0 AND 9007199254740991),
  d1_rows_written INTEGER NOT NULL DEFAULT 0 CHECK (d1_rows_written BETWEEN 0 AND 9007199254740991),
  queue_ops INTEGER NOT NULL DEFAULT 0 CHECK (queue_ops = 0),
  protected_do_requests INTEGER NOT NULL DEFAULT 0 CHECK (protected_do_requests BETWEEN 0 AND do_requests),
  protected_do_rows_read INTEGER NOT NULL DEFAULT 0 CHECK (protected_do_rows_read BETWEEN 0 AND do_rows_read),
  protected_do_rows_written INTEGER NOT NULL DEFAULT 0 CHECK (protected_do_rows_written BETWEEN 0 AND do_rows_written),
  protected_do_duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (protected_do_duration_ms BETWEEN 0 AND do_duration_ms),
  protected_d1_rows_read INTEGER NOT NULL DEFAULT 0 CHECK (protected_d1_rows_read BETWEEN 0 AND d1_rows_read),
  protected_d1_rows_written INTEGER NOT NULL DEFAULT 0 CHECK (protected_d1_rows_written BETWEEN 0 AND d1_rows_written),
  protected_queue_ops INTEGER NOT NULL DEFAULT 0 CHECK (protected_queue_ops BETWEEN 0 AND queue_ops),
  escrow TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(escrow) AND json_type(escrow) = 'array' AND json_array_length(escrow) <= 64
  ),
  retain_until INTEGER NOT NULL CHECK (
    retain_until >= 0 AND retain_until <= (day + 5) * 86400000
  ),
  cleanup_debt TEXT NOT NULL CHECK (coalesce(
      json_valid(cleanup_debt)
      AND json(cleanup_debt) = json_object('do_requests', json_extract(cleanup_debt, '$.do_requests'), 'do_rows_read', json_extract(cleanup_debt, '$.do_rows_read'), 'do_rows_written', json_extract(cleanup_debt, '$.do_rows_written'), 'do_duration_ms', json_extract(cleanup_debt, '$.do_duration_ms'), 'd1_rows_read', json_extract(cleanup_debt, '$.d1_rows_read'), 'd1_rows_written', json_extract(cleanup_debt, '$.d1_rows_written'), 'queue_ops', json_extract(cleanup_debt, '$.queue_ops'))
      AND json_type(cleanup_debt, '$.do_requests') = 'integer'
      AND json_extract(cleanup_debt, '$.do_requests') BETWEEN 0 AND 9007199254740991
      AND json_type(cleanup_debt, '$.do_rows_read') = 'integer'
      AND json_extract(cleanup_debt, '$.do_rows_read') BETWEEN 0 AND 9007199254740991
      AND json_type(cleanup_debt, '$.do_rows_written') = 'integer'
      AND json_extract(cleanup_debt, '$.do_rows_written') BETWEEN 0 AND 9007199254740991
      AND json_type(cleanup_debt, '$.do_duration_ms') = 'integer'
      AND json_extract(cleanup_debt, '$.do_duration_ms') BETWEEN 0 AND 9007199254740991
      AND json_type(cleanup_debt, '$.d1_rows_read') = 'integer'
      AND json_extract(cleanup_debt, '$.d1_rows_read') BETWEEN 0 AND 9007199254740991
      AND json_type(cleanup_debt, '$.d1_rows_written') = 'integer'
      AND json_extract(cleanup_debt, '$.d1_rows_written') BETWEEN 0 AND 9007199254740991
      AND json_type(cleanup_debt, '$.queue_ops') = 'integer'
      AND json_extract(cleanup_debt, '$.queue_ops') BETWEEN 0 AND 9007199254740991
      AND json_extract(cleanup_debt, '$.queue_ops') = 0,
      0
    ))
) STRICT;

-- Grants: immutable once written (only the settlement columns change), kept
-- until `expires_at` as the tombstone that refuses a replay of the same
-- operation. `plan` is the canonical request (its dates, prices, duration
-- holds and cleanup).
CREATE TABLE live_budget_receipts (
  seq INTEGER PRIMARY KEY CHECK (seq BETWEEN 1 AND 9007199254740991),
  operation_id TEXT NOT NULL UNIQUE,
  mint TEXT NOT NULL,
  incarnation TEXT NOT NULL CHECK (length(incarnation) = 32),
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('UserDO', 'OrgDO', 'MaintenanceDO')),
  recipient TEXT NOT NULL CHECK (length(recipient) > 0),
  kind TEXT NOT NULL,
  class TEXT NOT NULL CHECK (class IN ('ordinary', 'cleanup')),
  epoch INTEGER NOT NULL CHECK (epoch >= 0),
  produces_local INTEGER NOT NULL CHECK (produces_local IN (0, 1)),
  valid_from INTEGER NOT NULL CHECK (valid_from >= 0),
  valid_until INTEGER NOT NULL CHECK (
    valid_until > valid_from AND valid_until - valid_from <= 86400000
  ),
  granted_at INTEGER NOT NULL CHECK (granted_at >= 0),
  plan TEXT NOT NULL CHECK (json_valid(plan) AND json_type(plan) = 'object'),
  directory_cleanup_debt TEXT NOT NULL CHECK (coalesce(
      json_valid(directory_cleanup_debt)
      AND json(directory_cleanup_debt) = json_object('do_requests', json_extract(directory_cleanup_debt, '$.do_requests'), 'do_rows_read', json_extract(directory_cleanup_debt, '$.do_rows_read'), 'do_rows_written', json_extract(directory_cleanup_debt, '$.do_rows_written'), 'do_duration_ms', json_extract(directory_cleanup_debt, '$.do_duration_ms'), 'd1_rows_read', json_extract(directory_cleanup_debt, '$.d1_rows_read'), 'd1_rows_written', json_extract(directory_cleanup_debt, '$.d1_rows_written'), 'queue_ops', json_extract(directory_cleanup_debt, '$.queue_ops'))
      AND json_type(directory_cleanup_debt, '$.do_requests') = 'integer'
      AND json_extract(directory_cleanup_debt, '$.do_requests') BETWEEN 0 AND 9007199254740991
      AND json_type(directory_cleanup_debt, '$.do_rows_read') = 'integer'
      AND json_extract(directory_cleanup_debt, '$.do_rows_read') BETWEEN 0 AND 9007199254740991
      AND json_type(directory_cleanup_debt, '$.do_rows_written') = 'integer'
      AND json_extract(directory_cleanup_debt, '$.do_rows_written') BETWEEN 0 AND 9007199254740991
      AND json_type(directory_cleanup_debt, '$.do_duration_ms') = 'integer'
      AND json_extract(directory_cleanup_debt, '$.do_duration_ms') BETWEEN 0 AND 9007199254740991
      AND json_type(directory_cleanup_debt, '$.d1_rows_read') = 'integer'
      AND json_extract(directory_cleanup_debt, '$.d1_rows_read') BETWEEN 0 AND 9007199254740991
      AND json_type(directory_cleanup_debt, '$.d1_rows_written') = 'integer'
      AND json_extract(directory_cleanup_debt, '$.d1_rows_written') BETWEEN 0 AND 9007199254740991
      AND json_type(directory_cleanup_debt, '$.queue_ops') = 'integer'
      AND json_extract(directory_cleanup_debt, '$.queue_ops') BETWEEN 0 AND 9007199254740991
      AND json_extract(directory_cleanup_debt, '$.queue_ops') = 0,
      0
    )),
  settle_until INTEGER NOT NULL CHECK (settle_until >= valid_until),
  expires_at INTEGER NOT NULL CHECK (
    expires_at >= valid_until + 172800000 AND expires_at >= settle_until
  ),
  settled_at INTEGER,
  completion TEXT CHECK (
    completion IS NULL OR (json_valid(completion) AND json_type(completion) = 'object')
  ),
  settlement_mint TEXT,
  CHECK (
    (settled_at IS NULL AND completion IS NULL AND settlement_mint IS NULL)
    OR (settled_at IS NOT NULL AND completion IS NOT NULL AND settlement_mint IS NOT NULL)
  ),
  CHECK (produces_local = 0 OR (class = 'ordinary' AND recipient_type = 'UserDO'))
) STRICT;
CREATE INDEX live_budget_receipts_expiry ON live_budget_receipts (expires_at, seq);

-- A feed whose object holds state grants paid for: cleaned (recovered)
-- through `through_seq` once due, retried with backoff, its local cleanup
-- debt retired only when the object acknowledges that sequence clean.
CREATE TABLE live_recovery_targets (
  feed TEXT PRIMARY KEY CHECK (length(feed) > 0),
  incarnation TEXT NOT NULL CHECK (length(incarnation) = 32),
  through_seq INTEGER NOT NULL CHECK (through_seq BETWEEN 1 AND 9007199254740991),
  next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 7),
  local_cleanup_debt TEXT NOT NULL CHECK (coalesce(
      json_valid(local_cleanup_debt)
      AND json(local_cleanup_debt) = json_object('do_requests', json_extract(local_cleanup_debt, '$.do_requests'), 'do_rows_read', json_extract(local_cleanup_debt, '$.do_rows_read'), 'do_rows_written', json_extract(local_cleanup_debt, '$.do_rows_written'), 'do_duration_ms', json_extract(local_cleanup_debt, '$.do_duration_ms'), 'd1_rows_read', json_extract(local_cleanup_debt, '$.d1_rows_read'), 'd1_rows_written', json_extract(local_cleanup_debt, '$.d1_rows_written'), 'queue_ops', json_extract(local_cleanup_debt, '$.queue_ops'))
      AND json_type(local_cleanup_debt, '$.do_requests') = 'integer'
      AND json_extract(local_cleanup_debt, '$.do_requests') BETWEEN 0 AND 9007199254740991
      AND json_type(local_cleanup_debt, '$.do_rows_read') = 'integer'
      AND json_extract(local_cleanup_debt, '$.do_rows_read') BETWEEN 0 AND 9007199254740991
      AND json_type(local_cleanup_debt, '$.do_rows_written') = 'integer'
      AND json_extract(local_cleanup_debt, '$.do_rows_written') BETWEEN 0 AND 9007199254740991
      AND json_type(local_cleanup_debt, '$.do_duration_ms') = 'integer'
      AND json_extract(local_cleanup_debt, '$.do_duration_ms') BETWEEN 0 AND 9007199254740991
      AND json_type(local_cleanup_debt, '$.d1_rows_read') = 'integer'
      AND json_extract(local_cleanup_debt, '$.d1_rows_read') BETWEEN 0 AND 9007199254740991
      AND json_type(local_cleanup_debt, '$.d1_rows_written') = 'integer'
      AND json_extract(local_cleanup_debt, '$.d1_rows_written') BETWEEN 0 AND 9007199254740991
      AND json_type(local_cleanup_debt, '$.queue_ops') = 'integer'
      AND json_extract(local_cleanup_debt, '$.queue_ops') BETWEEN 0 AND 9007199254740991
      AND json_extract(local_cleanup_debt, '$.queue_ops') = 0,
      0
    ))
) STRICT, WITHOUT ROWID;
CREATE INDEX live_recovery_targets_due ON live_recovery_targets (next_attempt_at, feed);

-- Tickets issued a principal's day (written by the funded issuance, later).
ALTER TABLE live_admissions ADD COLUMN issued INTEGER NOT NULL DEFAULT 0 CHECK (issued BETWEEN 0 AND 60);
CREATE INDEX live_admissions_day ON live_admissions (day, principal_id);
