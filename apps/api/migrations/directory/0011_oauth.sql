-- The OAuth 2.1 authorization server: human sessions (only the SHA-256 of
-- a session cookie is stored), clients (registered, or known by a client
-- ID metadata document), authorization requests (a consent, then its
-- single-use code), and refresh tokens, rotated single use: each one names
-- the token that replaced it, and a family is revoked whole when a used one
-- comes back.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  user_id TEXT NOT NULL REFERENCES principals (id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;

CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expiry ON sessions (expires_at);

CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('registered', 'metadata_document')),
  client_name TEXT,
  -- JSON array of the exact redirect URIs it may use.
  redirect_uris TEXT NOT NULL CHECK (json_valid(redirect_uris)),
  created_at INTEGER NOT NULL,
  -- When a user last authorized it (at most hourly): a registration never or long unused is pruned.
  last_used_at INTEGER,
  -- A metadata document's, when it was last fetched (it is fetched again past its cache time).
  fetched_at INTEGER
) STRICT;

CREATE INDEX oauth_clients_created ON oauth_clients (created_at);

CREATE TABLE oauth_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES principals (id),
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  -- JSON array of permission names.
  scopes TEXT NOT NULL CHECK (json_valid(scopes)),
  resource TEXT NOT NULL,
  state TEXT,
  dpop_jkt TEXT,
  expires_at INTEGER NOT NULL,
  -- Set once the user consents; the code is good once, until code_expires_at.
  code_hash TEXT UNIQUE CHECK (code_hash IS NULL OR length(code_hash) = 64),
  code_expires_at INTEGER,
  -- The redemption that claimed the code (one wins), and the refresh family it began.
  used_at INTEGER,
  used_by TEXT,
  family_id TEXT
) STRICT;

CREATE INDEX oauth_requests_expiry ON oauth_requests (expires_at);
CREATE INDEX oauth_requests_pending ON oauth_requests (user_id, expires_at) WHERE code_hash IS NULL;

CREATE TABLE refresh_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  family_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES principals (id),
  client_id TEXT NOT NULL,
  scopes TEXT NOT NULL CHECK (json_valid(scopes)),
  resource TEXT NOT NULL,
  dpop_jkt TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  -- The family's end, the same on all its tokens (no token outlives it): rows are pruned by it.
  family_expires_at INTEGER NOT NULL,
  used_at INTEGER,
  replaced_by TEXT,
  revoked_at INTEGER
) STRICT;

CREATE INDEX refresh_tokens_family ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family_expiry ON refresh_tokens (family_expires_at);

-- Access tokens the authorization server issues: the resource they are for
-- (RFC 8707; null for any of this deployment's), the client, the key a
-- DPoP-bound one is bound to, and the refresh family it came from (revoked
-- with it).
ALTER TABLE tokens ADD COLUMN audience TEXT;
ALTER TABLE tokens ADD COLUMN client_id TEXT;
ALTER TABLE tokens ADD COLUMN dpop_jkt TEXT;
ALTER TABLE tokens ADD COLUMN family_id TEXT;

CREATE INDEX tokens_family ON tokens (family_id) WHERE family_id IS NOT NULL;
-- Expired access tokens are pruned (their mint stays in the audit log).
CREATE INDEX tokens_oat_expiry ON tokens (expires_at) WHERE type = 'oat';
