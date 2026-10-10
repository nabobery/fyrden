-- D1 `directory`: identities, tokens and the repo directory.
-- Forward-only: later changes add new numbered files, expand then contract.

-- Users, orgs, agents and installations share one namespace of handles, as on
-- GitHub. Ids are prefixed ULIDs (usr_, org_, agt_, ins_) and never reused.
CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('user', 'org', 'agent', 'installation')),
  handle TEXT,
  display_name TEXT,
  -- Agents and installations belong to a user or an org.
  owner_id TEXT REFERENCES principals (id),
  is_instance_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_instance_admin IN (0, 1)),
  created_at INTEGER NOT NULL,
  disabled_at INTEGER,
  CHECK ((type IN ('agent', 'installation')) = (owner_id IS NOT NULL)),
  CHECK (type = 'installation' OR handle IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX principals_handle ON principals (handle COLLATE NOCASE) WHERE handle IS NOT NULL;
CREATE INDEX principals_owner ON principals (owner_id) WHERE owner_id IS NOT NULL;

CREATE TABLE memberships (
  org_id TEXT NOT NULL REFERENCES principals (id),
  principal_id TEXT NOT NULL REFERENCES principals (id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, principal_id)
) STRICT;

CREATE INDEX memberships_principal ON memberships (principal_id);

-- Only the SHA-256 of a token is stored.
CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  type TEXT NOT NULL CHECK (type IN ('git', 'pat', 'ist', 'run', 'job')),
  principal_id TEXT NOT NULL REFERENCES principals (id),
  -- JSON array of scope strings.
  scopes TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scopes)),
  -- JSON array of repo ids the token is limited to; NULL means all the principal can reach.
  repo_ids TEXT CHECK (repo_ids IS NULL OR json_valid(repo_ids)),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  -- Written at most once per 10 minutes per token.
  last_used_at INTEGER,
  revoked_at INTEGER
) STRICT;

CREATE INDEX tokens_principal ON tokens (principal_id);

-- The repo directory: immutable id <-> owner/name. A deleted repo keeps its
-- row as a tombstone so its id is never reused and its name can be freed.
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
) STRICT;

CREATE UNIQUE INDEX repos_owner_name ON repos (owner_id, name COLLATE NOCASE) WHERE state <> 'deleted';
CREATE INDEX repos_network ON repos (network_id);
CREATE INDEX repos_expiry ON repos (expires_at) WHERE expires_at IS NOT NULL AND state = 'active';

-- Monotonic epoch generation per source (RepoDO, OrgDO). Lives here because
-- D1 is never restored together with a Durable Object.
CREATE TABLE source_epochs (
  source_id TEXT PRIMARY KEY,
  epoch_gen INTEGER NOT NULL CHECK (epoch_gen >= 1)
) STRICT;

-- Resumable repo deletion jobs, outside the storage being erased.
CREATE TABLE repo_deletions (
  repo_id TEXT PRIMARY KEY REFERENCES repos (id),
  step TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
) STRICT;

-- Auth events (login, token mint and revoke), written in the same batch as the
-- change they record.
CREATE TABLE audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_id TEXT,
  act_chain TEXT CHECK (act_chain IS NULL OR json_valid(act_chain)),
  action TEXT NOT NULL,
  target_id TEXT,
  details TEXT CHECK (details IS NULL OR json_valid(details)),
  request_id TEXT
);
