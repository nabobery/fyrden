-- Delegation grants: a user lets an agent act for it, with scopes, a
-- repository list and an expiry. An agent holding a grant may pass a
-- narrower one to a sub-agent of its owner: one hop more at most.
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

CREATE INDEX grants_grantor ON grants (grantor_id);
CREATE INDEX grants_agent ON grants (agent_id);
CREATE INDEX grants_parent ON grants (parent_id) WHERE parent_id IS NOT NULL;

-- Tokens take the `oat` type (access tokens the authorization server
-- issues) and, for a delegated token, its grant and act chain (the agents
-- acting, the current one first). SQLite cannot change a CHECK in place:
-- the table is rebuilt. No table references it.
CREATE TABLE tokens_next (
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
  act_chain TEXT CHECK (act_chain IS NULL OR json_valid(act_chain)),
  CHECK ((grant_id IS NULL) = (act_chain IS NULL))
) STRICT;

INSERT INTO tokens_next (id, token_hash, type, principal_id, scopes, repo_ids, expires_at,
  created_at, last_used_at, revoked_at)
SELECT id, token_hash, type, principal_id, scopes, repo_ids, expires_at, created_at,
  last_used_at, revoked_at
FROM tokens;

DROP TABLE tokens;
ALTER TABLE tokens_next RENAME TO tokens;

CREATE INDEX tokens_principal ON tokens (principal_id);
CREATE INDEX tokens_grant ON tokens (grant_id) WHERE grant_id IS NOT NULL;
