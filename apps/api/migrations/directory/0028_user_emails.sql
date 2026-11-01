-- A user's notification addresses (src/accounts/emails.ts). A row is one
-- address added once: added again after its removal, it is a new row, and
-- its id is its generation (what unsubscribe links, senders and provider
-- callbacks bind to later), so nothing of an earlier one applies to it.
-- `address_key` is the address lower-cased: the mailbox, compared across
-- accounts (a mailbox is verified on one account at a time).
CREATE TABLE user_emails (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals (id),
  address TEXT NOT NULL CHECK (length(address) <= 254),
  address_key TEXT NOT NULL,
  verified_at INTEGER,
  created_at INTEGER NOT NULL,
  removed_at INTEGER
) STRICT;
CREATE UNIQUE INDEX user_emails_live ON user_emails (principal_id, address_key)
  WHERE removed_at IS NULL;
CREATE INDEX user_emails_principal ON user_emails (principal_id);
CREATE INDEX user_emails_mailbox ON user_emails (address_key);
CREATE INDEX user_emails_removed ON user_emails (removed_at, id) WHERE removed_at IS NOT NULL;

-- A mailbox's current claim: a fresh random value whenever its row is made
-- and whenever its verified owner changes (a verification, or the removal
-- of a verified address), so every proof issued before is stale. A row
-- without live addresses is idle and reaped after a day; one made again
-- gets a fresh claim, so no old proof becomes current.
CREATE TABLE email_mailboxes (
  address_key TEXT PRIMARY KEY,
  claim TEXT NOT NULL,
  idle_since INTEGER
) STRICT, WITHOUT ROWID;
CREATE INDEX email_mailboxes_idle ON email_mailboxes (idle_since) WHERE idle_since IS NOT NULL;

-- Confirmation links: a token's SHA-256, its address row and the mailbox's
-- claim when issued; good for a day, once. `reap_at` is when the row goes
-- (a day after its expiry or use).
CREATE TABLE email_confirmations (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  email_id TEXT NOT NULL,
  address_key TEXT NOT NULL,
  claim TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  reap_at INTEGER NOT NULL
) STRICT;
CREATE INDEX email_confirmations_email ON email_confirmations (email_id);
CREATE INDEX email_confirmations_reap ON email_confirmations (reap_at);

-- Confirmation mails sent, per user an hour and per mailbox a day.
CREATE TABLE email_counters (
  scope TEXT NOT NULL CHECK (scope IN ('user_hour', 'mailbox_day')),
  key TEXT NOT NULL,
  period INTEGER NOT NULL,
  sent INTEGER NOT NULL,
  PRIMARY KEY (scope, key, period)
) STRICT, WITHOUT ROWID;
CREATE INDEX email_counters_period ON email_counters (scope, period);

-- One row per admitted batch, by a nonce the server makes: every other
-- statement of the batch holds only when its row was inserted.
CREATE TABLE email_admissions (
  nonce TEXT PRIMARY KEY,
  at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX email_admissions_at ON email_admissions (at);
