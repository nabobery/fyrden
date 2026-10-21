-- table audit_log
CREATE TABLE audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_id TEXT,
  act_chain TEXT CHECK (act_chain IS NULL OR json_valid(act_chain)),
  action TEXT NOT NULL,
  target_id TEXT,
  details TEXT CHECK (details IS NULL OR json_valid(details)),
  request_id TEXT
, archived_at INTEGER);

-- table audit_segments
CREATE TABLE audit_segments (
  segment_id INTEGER PRIMARY KEY,
  first_at INTEGER NOT NULL,
  from_seq INTEGER NOT NULL,
  to_seq INTEGER NOT NULL CHECK (to_seq >= from_seq),
  r2_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'archived')),
  created_at INTEGER NOT NULL,
  archived_at INTEGER
) STRICT;

-- table dpop_proofs
CREATE TABLE dpop_proofs (
  jkt TEXT NOT NULL,
  jti TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (jkt, jti)
) STRICT;

-- table grants
CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  -- The user acted for (the root grant's grantor, on every grant of its tree).
  grantor_id TEXT NOT NULL REFERENCES principals (id),
  agent_id TEXT NOT NULL REFERENCES principals (id),
  parent_id TEXT REFERENCES grants (id),
  root_id TEXT NOT NULL,
  depth INTEGER NOT NULL CHECK (depth IN (1, 2)),
  -- JSON array of permission names; never empty (a grant is always narrowed).
  scopes TEXT NOT NULL CHECK (json_valid(scopes) AND json_array_length(scopes) > 0),
  -- JSON array of repo ids; NULL means every repo the grantor can reach.
  repo_ids TEXT CHECK (repo_ids IS NULL OR json_valid(repo_ids)),
  expires_at INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK ((depth = 1) = (parent_id IS NULL)),
  CHECK ((depth = 1) = (root_id = id))
) STRICT;

-- table idempotency_keys
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

-- table memberships
CREATE TABLE memberships (
  org_id TEXT NOT NULL REFERENCES principals (id),
  principal_id TEXT NOT NULL REFERENCES principals (id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, principal_id)
) STRICT;

-- table oauth_clients
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

-- table oauth_requests
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

-- table passkeys
CREATE TABLE passkeys (
  -- The credential id, base64url.
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES principals (id),
  public_key TEXT NOT NULL CHECK (json_valid(public_key)),
  alg INTEGER NOT NULL CHECK (alg IN (-7, -8, -257)),
  sign_count INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
) STRICT;

-- table principal_lifecycle
CREATE TABLE principal_lifecycle (
  principal_id TEXT NOT NULL REFERENCES principals (id),
  gen INTEGER NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  at INTEGER NOT NULL,
  actor_id TEXT,
  request_id TEXT,
  PRIMARY KEY (principal_id, gen)
) STRICT, WITHOUT ROWID;

-- table principals
CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('user', 'org', 'agent', 'installation')),
  handle TEXT,
  display_name TEXT,
  -- Agents and installations belong to a user or an org.
  owner_id TEXT REFERENCES principals (id),
  is_instance_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_instance_admin IN (0, 1)),
  created_at INTEGER NOT NULL,
  disabled_at INTEGER, require_dpop INTEGER NOT NULL DEFAULT 0
  CHECK (require_dpop IN (0, 1)), lifecycle TEXT NOT NULL DEFAULT 'active'
  CHECK (lifecycle IN ('active', 'suspended', 'deleting', 'deleted')), lifecycle_gen INTEGER NOT NULL DEFAULT 0, lifecycle_claim TEXT, suspended_at INTEGER, suspended_by TEXT, suspended_reason TEXT
  CHECK (suspended_reason IS NULL OR length(suspended_reason) <= 200),
  CHECK ((type IN ('agent', 'installation')) = (owner_id IS NOT NULL)),
  CHECK (type = 'installation' OR handle IS NOT NULL)
) STRICT;

-- table refresh_tokens
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

-- table repo_deletion_cleanups
CREATE TABLE repo_deletion_cleanups (
  repo_id TEXT NOT NULL REFERENCES repo_deletions (repo_id),
  cleanup TEXT NOT NULL,
  done_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, cleanup)
) STRICT, WITHOUT ROWID;

-- table repo_deletions
CREATE TABLE repo_deletions (
  repo_id TEXT PRIMARY KEY REFERENCES repos (id),
  step TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
, requested_by TEXT, last_error TEXT, act_chain TEXT CHECK (act_chain IS NULL OR json_valid(act_chain)), request_id TEXT, tombstone TEXT CHECK (tombstone IS NULL OR json_valid(tombstone))) STRICT;

-- table repo_redirects
CREATE TABLE repo_redirects (
  owner_id TEXT NOT NULL REFERENCES principals (id),
  name TEXT NOT NULL COLLATE NOCASE,
  repo_id TEXT NOT NULL REFERENCES repos (id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, name)
) STRICT;

-- table repo_transfers
CREATE TABLE repo_transfers (
  repo_id TEXT PRIMARY KEY REFERENCES repos (id),
  transfer_id TEXT NOT NULL,
  from_owner TEXT NOT NULL,
  from_name TEXT NOT NULL,
  to_owner TEXT NOT NULL,
  to_name TEXT NOT NULL,
  step TEXT NOT NULL CHECK (step IN
    ('freeze', 'directory', 'grants', 'fence', 'repo', 'done', 'cancelling', 'failed')),
  requested_by TEXT,
  lease_id TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
, request_id TEXT) STRICT;

-- table repos
CREATE TABLE repos (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES principals (id),
  name TEXT NOT NULL,
  network_id TEXT NOT NULL,
  org_shard TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'internal', 'private')),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'deleting', 'deleted')),
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
, name_gen INTEGER NOT NULL DEFAULT 0, parent_id TEXT, is_template INTEGER NOT NULL DEFAULT 0 CHECK (is_template IN (0, 1)), generating_since INTEGER, created_by TEXT) STRICT;

-- table sessions
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  user_id TEXT NOT NULL REFERENCES principals (id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;

-- table source_epochs
CREATE TABLE source_epochs (
  source_id TEXT PRIMARY KEY,
  epoch_gen INTEGER NOT NULL CHECK (epoch_gen >= 1)
) STRICT;

-- table ssh_signing_keys
CREATE TABLE ssh_signing_keys (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals (id),
  title TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

-- table stars
CREATE TABLE stars (
  user_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, repo_id)
) STRICT;

-- table tokens
CREATE TABLE "tokens" (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  type TEXT NOT NULL CHECK (type IN ('git', 'pat', 'ist', 'run', 'job', 'oat')),
  principal_id TEXT NOT NULL REFERENCES principals (id),
  scopes TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scopes)),
  repo_ids TEXT CHECK (repo_ids IS NULL OR json_valid(repo_ids)),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  grant_id TEXT REFERENCES grants (id),
  act_chain TEXT CHECK (act_chain IS NULL OR json_valid(act_chain)), audience TEXT, client_id TEXT, dpop_jkt TEXT, family_id TEXT, source_id TEXT,
  CHECK ((grant_id IS NULL) = (act_chain IS NULL))
) STRICT;

-- table webauthn_challenges
CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'sign_in')),
  -- The registering user (none for a sign-in, which names its user by the credential).
  user_id TEXT REFERENCES principals (id),
  expires_at INTEGER NOT NULL,
  used_at INTEGER
) STRICT;

-- index audit_log_archived
CREATE INDEX audit_log_archived ON audit_log (archived_at) WHERE archived_at IS NOT NULL;

-- index audit_log_unarchived
CREATE INDEX audit_log_unarchived ON audit_log (seq) WHERE archived_at IS NULL;

-- index audit_segments_archived
CREATE INDEX audit_segments_archived ON audit_segments (archived_at) WHERE state = 'archived';

-- index audit_segments_from
CREATE INDEX audit_segments_from ON audit_segments (from_seq);

-- index audit_segments_pending
CREATE INDEX audit_segments_pending ON audit_segments (from_seq) WHERE state = 'pending';

-- index audit_segments_to
CREATE INDEX audit_segments_to ON audit_segments (to_seq);

-- index dpop_proofs_expiry
CREATE INDEX dpop_proofs_expiry ON dpop_proofs (expires_at);

-- index grants_agent
CREATE INDEX grants_agent ON grants (agent_id);

-- index grants_grantor
CREATE INDEX grants_grantor ON grants (grantor_id);

-- index grants_parent
CREATE INDEX grants_parent ON grants (parent_id) WHERE parent_id IS NOT NULL;

-- index idempotency_keys_expiry
CREATE INDEX idempotency_keys_expiry ON idempotency_keys (expires_at);

-- index memberships_principal
CREATE INDEX memberships_principal ON memberships (principal_id);

-- index oauth_clients_created
CREATE INDEX oauth_clients_created ON oauth_clients (created_at);

-- index oauth_requests_expiry
CREATE INDEX oauth_requests_expiry ON oauth_requests (expires_at);

-- index oauth_requests_pending
CREATE INDEX oauth_requests_pending ON oauth_requests (user_id, expires_at) WHERE code_hash IS NULL;

-- index oauth_requests_unconsumed_user
CREATE INDEX oauth_requests_unconsumed_user ON oauth_requests (user_id) WHERE used_at IS NULL;

-- index passkeys_user
CREATE INDEX passkeys_user ON passkeys (user_id);

-- index principals_handle
CREATE UNIQUE INDEX principals_handle ON principals (handle COLLATE NOCASE) WHERE handle IS NOT NULL;

-- index principals_owner
CREATE INDEX principals_owner ON principals (owner_id) WHERE owner_id IS NOT NULL;

-- index refresh_tokens_family
CREATE INDEX refresh_tokens_family ON refresh_tokens (family_id);

-- index refresh_tokens_family_expiry
CREATE INDEX refresh_tokens_family_expiry ON refresh_tokens (family_expires_at);

-- index refresh_tokens_user
CREATE INDEX refresh_tokens_user ON refresh_tokens (user_id);

-- index repo_deletions_pending
CREATE INDEX repo_deletions_pending ON repo_deletions (updated_at) WHERE step <> 'done';

-- index repo_redirects_repo
CREATE INDEX repo_redirects_repo ON repo_redirects (repo_id);

-- index repo_transfers_leaving
CREATE INDEX repo_transfers_leaving ON repo_transfers (from_owner) WHERE step = 'grants';

-- index repo_transfers_pending
CREATE INDEX repo_transfers_pending ON repo_transfers (updated_at)
  WHERE step NOT IN ('done', 'failed');

-- index repos_created_by
CREATE INDEX repos_created_by ON repos (created_by) WHERE created_by IS NOT NULL AND state = 'active';

-- index repos_expiry
CREATE INDEX repos_expiry ON repos (expires_at) WHERE expires_at IS NOT NULL AND state = 'active';

-- index repos_forks
CREATE INDEX repos_forks ON repos (parent_id, owner_id, created_at, id)
  WHERE parent_id IS NOT NULL AND state = 'active';

-- index repos_generating
CREATE INDEX repos_generating ON repos (generating_since)
  WHERE generating_since IS NOT NULL AND state = 'active';

-- index repos_network
CREATE INDEX repos_network ON repos (network_id);

-- index repos_owner_name
CREATE UNIQUE INDEX repos_owner_name ON repos (owner_id, name COLLATE NOCASE) WHERE state <> 'deleted';

-- index sessions_expiry
CREATE INDEX sessions_expiry ON sessions (expires_at);

-- index sessions_user
CREATE INDEX sessions_user ON sessions (user_id);

-- index ssh_signing_keys_fingerprint
CREATE UNIQUE INDEX ssh_signing_keys_fingerprint ON ssh_signing_keys (fingerprint);

-- index ssh_signing_keys_principal
CREATE INDEX ssh_signing_keys_principal ON ssh_signing_keys (principal_id, created_at, id);

-- index stars_repo
CREATE INDEX stars_repo ON stars (repo_id);

-- index stars_user
CREATE INDEX stars_user ON stars (user_id, created_at, repo_id);

-- index tokens_family
CREATE INDEX tokens_family ON tokens (family_id) WHERE family_id IS NOT NULL;

-- index tokens_grant
CREATE INDEX tokens_grant ON tokens (grant_id) WHERE grant_id IS NOT NULL;

-- index tokens_oat_expiry
CREATE INDEX tokens_oat_expiry ON tokens (expires_at) WHERE type = 'oat';

-- index tokens_principal
CREATE INDEX tokens_principal ON tokens (principal_id);

-- index webauthn_challenges_expiry
CREATE INDEX webauthn_challenges_expiry ON webauthn_challenges (expires_at);

-- trigger principals_lifecycle_insert
CREATE TRIGGER principals_lifecycle_insert BEFORE INSERT ON principals
WHEN (NEW.lifecycle <> 'active' AND NEW.disabled_at IS NULL)
  OR (NEW.type = 'user' AND NEW.lifecycle = 'active' AND NEW.disabled_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'a principal''s lifecycle and disabled_at disagree');
END;

-- trigger principals_lifecycle_update
CREATE TRIGGER principals_lifecycle_update BEFORE UPDATE OF lifecycle, disabled_at ON principals
WHEN (NEW.lifecycle <> 'active' AND NEW.disabled_at IS NULL)
  OR (NEW.type = 'user' AND NEW.lifecycle = 'active' AND NEW.disabled_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'a principal''s lifecycle and disabled_at disagree');
END;
