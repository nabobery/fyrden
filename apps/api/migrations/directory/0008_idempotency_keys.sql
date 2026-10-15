-- REST writes made with an Idempotency-Key, per token: what the first
-- request asked (operation and input hash) and, once it finished, what it
-- answered, so a retry with the same key gets the same answer and nothing
-- runs twice. `claim_id` names the execution that holds the key; a
-- finished row with no status is one whose outcome is unknown.
CREATE TABLE idempotency_keys (
  token_id TEXT NOT NULL,
  key TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  op_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'done')),
  status INTEGER,
  response TEXT,
  -- For an answer that carried a secret: the resource it made, not the secret.
  resource_id TEXT,
  started_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (token_id, key)
) STRICT;
CREATE INDEX idempotency_keys_expiry ON idempotency_keys (expires_at);
