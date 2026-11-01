-- A live ticket's transport, found by the Worker before it wakes the feed's object: the ticket's
-- hash (never the ticket), the feed and credential it binds, when it expires, the grant that funds
-- its redemption, and its claim (once: a second redemption finds it claimed). Expired transports
-- are removed by their expiry, in order.
CREATE TABLE live_ticket_transports (
  ticket_hash TEXT PRIMARY KEY CHECK (length(ticket_hash) BETWEEN 1 AND 200),
  feed TEXT NOT NULL CHECK (length(feed) > 0),
  credential_id TEXT NOT NULL CHECK (length(credential_id) > 0),
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 300),
  claimed_at INTEGER CHECK (claimed_at IS NULL OR claimed_at >= 0),
  claim_id TEXT
) STRICT, WITHOUT ROWID;

CREATE INDEX live_ticket_transports_expiry ON live_ticket_transports (expires_at, ticket_hash);
