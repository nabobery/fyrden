-- A receipt is kept an hour past its validity (or until its settlement window closes), not two
-- days: past its validity it is refused by its dates, whether or not its row is there. SQLite
-- cannot alter a CHECK, so the table is rebuilt, rows and dates as they are.
CREATE TABLE live_budget_receipts_next (
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
    expires_at >= valid_until + 3600000 AND expires_at >= settle_until
  ),
  settled_at INTEGER,
  completion TEXT CHECK (
    completion IS NULL OR (json_valid(completion) AND json_type(completion) = 'object')
  ),
  settlement_mint TEXT,
  released_owners TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(released_owners) AND json_type(released_owners) = 'array'
      AND json_array_length(released_owners) <= 1
  ),
  CHECK (
    (settled_at IS NULL AND completion IS NULL AND settlement_mint IS NULL)
    OR (settled_at IS NOT NULL AND completion IS NOT NULL AND settlement_mint IS NOT NULL)
  ),
  CHECK (produces_local = 0 OR (class = 'ordinary' AND recipient_type = 'UserDO'))
) STRICT;

INSERT INTO live_budget_receipts_next (
  seq, operation_id, mint, incarnation, recipient_type, recipient,
  kind, class, epoch, produces_local, valid_from, valid_until,
  granted_at, plan, directory_cleanup_debt, settle_until, expires_at, settled_at,
  completion, settlement_mint, released_owners
)
SELECT
  seq, operation_id, mint, incarnation, recipient_type, recipient,
  kind, class, epoch, produces_local, valid_from, valid_until,
  granted_at, plan, directory_cleanup_debt, settle_until, expires_at, settled_at,
  completion, settlement_mint, released_owners
FROM live_budget_receipts;

DROP TABLE live_budget_receipts;
ALTER TABLE live_budget_receipts_next RENAME TO live_budget_receipts;

CREATE INDEX live_budget_receipts_expiry ON live_budget_receipts (expires_at, seq);
CREATE INDEX live_budget_receipts_overdue ON live_budget_receipts (expires_at)
  WHERE kind NOT IN ('maintenance', 'revocation_page');
CREATE INDEX live_budget_receipts_recipient
  ON live_budget_receipts (recipient, kind, valid_until) WHERE settled_at IS NULL;
CREATE INDEX live_budget_receipts_turn ON live_budget_receipts (recipient, valid_until)
  WHERE kind = 'pump' AND settled_at IS NULL;
