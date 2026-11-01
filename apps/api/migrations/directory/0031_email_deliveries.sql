-- Each notification email's outcome, by its recipient and event
-- (src/email/notifications.ts): written by the send's fence before the
-- provider call, so an email goes at most once whichever copy of the
-- recipient's object holds it. `sending`, `sent`, `unknown`, `refused` and
-- `exhausted` are final; `retry` (a transient refusal) admits another
-- attempt to the same address from `next_attempt_at`, at most four in all.
-- Kept 30 days from the event (`at`), past any candidate's life.
CREATE TABLE email_deliveries (
  principal_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('sending', 'sent', 'unknown', 'refused', 'retry', 'exhausted')),
  attempts INTEGER NOT NULL,
  address_id TEXT NOT NULL,
  provider_id TEXT,
  next_attempt_at INTEGER,
  at INTEGER NOT NULL,
  PRIMARY KEY (principal_id, event_key)
) STRICT, WITHOUT ROWID;
CREATE INDEX email_deliveries_at ON email_deliveries (at);

-- Notification send attempts a UTC day (days since the epoch), whatever
-- their outcome: what bounds a day's sender work.
CREATE TABLE email_attempts (
  day INTEGER PRIMARY KEY,
  used INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
