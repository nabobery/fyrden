-- Live work's duration, owned (src/live/owners.ts): each funded physical
-- operation on an object (a feed, an account) is admitted as an owner before
-- it is dispatched, and holds its place against the deployment's and the
-- object's caps (across days and instances) until what it really used is
-- observed, settled day by day, and released. An owner whose work cannot be
-- shown finished (an instance restarted while it ran) is uncertain: it keeps
-- its place. Nothing writes here yet: live hints stay off until the funded
-- paths are wired.
--
-- An owner: its operation (the grant that funds it, one owner a grant) and
-- role, and from that grant its object, class, epoch, incarnation and the
-- initial holds it was granted (two days at most); the window it may be
-- dispatched in, and, once dispatched, the instance and the start; once observed,
-- its physical finish and what is charged through (its declared tail
-- included), and the next day to settle.
CREATE TABLE live_duration_owners (
  owner_id TEXT PRIMARY KEY CHECK (length(owner_id) BETWEEN 1 AND 400),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 300),
  object_type TEXT NOT NULL CHECK (object_type IN ('UserDO', 'OrgDO', 'MaintenanceDO')),
  object_id TEXT NOT NULL CHECK (length(object_id) > 0),
  parent_id TEXT,
  class TEXT NOT NULL CHECK (class IN ('ordinary', 'cleanup')),
  epoch INTEGER NOT NULL CHECK (epoch >= 0),
  incarnation TEXT NOT NULL CHECK (length(incarnation) = 32),
  dispatch_from INTEGER NOT NULL CHECK (dispatch_from >= 0),
  dispatch_until INTEGER NOT NULL CHECK (dispatch_until > dispatch_from),
  holds TEXT NOT NULL CHECK (
    json_valid(holds) AND json_type(holds) = 'array' AND json_array_length(holds) <= 2
  ),
  status TEXT NOT NULL CHECK (
    status IN ('reserved', 'dispatched', 'uncertain', 'observing', 'accounted')
  ),
  instance TEXT,
  started_at INTEGER CHECK (started_at IS NULL OR started_at >= 0),
  finished_at INTEGER,
  charged_through INTEGER,
  cursor INTEGER CHECK (cursor IS NULL OR cursor >= 0),
  accounting_mint TEXT,
  admitted_at INTEGER NOT NULL CHECK (admitted_at >= 0),
  CHECK ((status = 'reserved') = (instance IS NULL AND started_at IS NULL)),
  CHECK (
    (finished_at IS NULL AND charged_through IS NULL AND cursor IS NULL)
    OR (finished_at >= started_at AND charged_through >= finished_at AND cursor IS NOT NULL)
  ),
  CHECK ((status IN ('observing', 'accounted')) = (finished_at IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX live_duration_owners_object ON live_duration_owners (object_type, object_id, class);
CREATE INDEX live_duration_owners_class ON live_duration_owners (class, status);
-- One owner a grant, ever (its receipt keeps the one released).
CREATE UNIQUE INDEX live_duration_owners_operation ON live_duration_owners (operation_id);
CREATE INDEX live_duration_owners_parent ON live_duration_owners (parent_id)
  WHERE parent_id IS NOT NULL;

-- The ledger: duration over its holds owed back (separately from cleanup
-- debt), the last day it was served from, the latest owner batch's mint, the
-- reserve each day keeps for duration no hold covered (0: none), and whether
-- ordinary duration is blocked (exposure not established).
ALTER TABLE live_budget_state ADD COLUMN duration_debt_ms INTEGER NOT NULL DEFAULT 0
  CHECK (duration_debt_ms BETWEEN 0 AND 9007199254740991);
ALTER TABLE live_budget_state ADD COLUMN debt_service_day INTEGER NOT NULL DEFAULT 0
  CHECK (debt_service_day >= 0);
ALTER TABLE live_budget_state ADD COLUMN owner_mint TEXT;
ALTER TABLE live_budget_state ADD COLUMN duration_reserve_ms INTEGER NOT NULL DEFAULT 0
  CHECK (duration_reserve_ms BETWEEN 0 AND 9007199254740991);
ALTER TABLE live_budget_state ADD COLUMN ordinary_duration_blocked INTEGER NOT NULL DEFAULT 0
  CHECK (ordinary_duration_blocked IN (0, 1));

-- A day: duration observed past its holds (taken from the reserve), the debt
-- withheld from its ordinary capacity, and whether it went past its
-- allowance (a correction may: what was used is charged).
ALTER TABLE live_budget_days ADD COLUMN reserve_used_ms INTEGER NOT NULL DEFAULT 0
  CHECK (reserve_used_ms BETWEEN 0 AND 9007199254740991);
ALTER TABLE live_budget_days ADD COLUMN debt_withheld_ms INTEGER NOT NULL DEFAULT 0
  CHECK (debt_withheld_ms BETWEEN 0 AND 9007199254740991);
ALTER TABLE live_budget_days ADD COLUMN duration_breach INTEGER NOT NULL DEFAULT 0
  CHECK (duration_breach IN (0, 1));

-- A grant's owner released while its receipt lives: it funds no other.
ALTER TABLE live_budget_receipts ADD COLUMN released_owners TEXT NOT NULL DEFAULT '[]' CHECK (
  json_valid(released_owners) AND json_type(released_owners) = 'array'
    AND json_array_length(released_owners) <= 1
);
