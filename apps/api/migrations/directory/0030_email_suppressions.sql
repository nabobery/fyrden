-- The provider's suppression list as Fyrden knows it (src/email/suppressions.ts):
-- one row a mailbox (by `address_key`, the address lower-cased) ever
-- suppressed, holding the provider's latest suppression of it by
-- `(created_at, suppression_id)`, suppressed or (once removed) its
-- tombstone, so a late or replayed callback of an earlier one changes
-- nothing (two created in the same millisecond: suppressed, id '', until a
-- recheck). Kept by the provider's callbacks, rechecked with the provider when
-- due by `email`, the address as the provider gave it; never reaped, and not
-- a user's: it protects the mailbox.
CREATE TABLE email_suppressions (
  address_key TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  suppression_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('bounce', 'complaint', 'manual')),
  suppressed INTEGER NOT NULL CHECK (suppressed IN (0, 1)),
  rev INTEGER NOT NULL,
  next_check_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX email_suppressions_due ON email_suppressions (next_check_at, address_key)
  WHERE suppressed = 1;

-- Messages the deployment's provider allowance has had, a UTC day (days
-- since the epoch) and a UTC month (`year * 12 + month - 1`): reserved before
-- each provider call, given back on a refusal, reaped below the period before.
CREATE TABLE email_spend (
  scope TEXT NOT NULL CHECK (scope IN ('day', 'month')),
  period INTEGER NOT NULL,
  used INTEGER NOT NULL,
  PRIMARY KEY (scope, period)
) STRICT, WITHOUT ROWID;
