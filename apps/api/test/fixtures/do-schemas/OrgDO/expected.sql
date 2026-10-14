CREATE INDEX collaborators_handle ON collaborators (repo_id, handle COLLATE NOCASE);
CREATE INDEX members_handle ON members (handle COLLATE NOCASE);
CREATE INDEX members_owners ON members (principal_id) WHERE role = 'owner';
CREATE INDEX quota_confirmed_at ON quota_confirmed (confirmed_at);
CREATE INDEX quota_holds_expiry ON quota_holds (expires_at);
CREATE INDEX quota_holds_repo ON quota_holds (repo_id);
CREATE INDEX team_members_principal ON team_members (principal_id);
CREATE INDEX team_repos_repo ON team_repos (repo_id);
CREATE TABLE collaborators (
        repo_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        handle TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('read', 'triage', 'write', 'maintain', 'admin')),
        added_at INTEGER NOT NULL,
        PRIMARY KEY (repo_id, principal_id)
      ) STRICT;
CREATE TABLE forgotten_repos (
        repo_id TEXT PRIMARY KEY,
        forgotten_at INTEGER NOT NULL
      ) STRICT;
CREATE TABLE members (
        principal_id TEXT PRIMARY KEY,
        handle TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
        added_at INTEGER NOT NULL
      ) STRICT;
CREATE TABLE org_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        account_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('org', 'user')),
        epoch_gen INTEGER NOT NULL,
        epoch_uuid TEXT NOT NULL,
        acl_version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      ) STRICT;
CREATE TABLE pending_audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        actor_id TEXT,
        action TEXT NOT NULL,
        target_id TEXT NOT NULL,
        details TEXT NOT NULL CHECK (json_valid(details)),
        request_id TEXT
      ) STRICT;
CREATE TABLE quota_confirmed (
        upload_id TEXT PRIMARY KEY,
        confirmed_at INTEGER NOT NULL
      ) STRICT;
CREATE TABLE quota_holds (
        upload_id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('reserved', 'charged')),
        bytes INTEGER NOT NULL CHECK (bytes >= 0),
        expires_at INTEGER NOT NULL
      ) STRICT;
CREATE TABLE quota_limits (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        max_repos INTEGER CHECK (max_repos >= 0),
        max_storage_bytes INTEGER CHECK (max_storage_bytes >= 0),
        updated_at INTEGER NOT NULL
      ) STRICT;
CREATE TABLE quota_usage (
        repo_id TEXT PRIMARY KEY,
        bytes INTEGER NOT NULL CHECK (bytes >= 0)
      ) STRICT;
CREATE TABLE team_members (
        team_id TEXT NOT NULL REFERENCES teams (team_id),
        principal_id TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (team_id, principal_id)
      ) STRICT;
CREATE TABLE team_repos (
        team_id TEXT NOT NULL REFERENCES teams (team_id),
        repo_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('read', 'triage', 'write', 'maintain', 'admin')),
        added_at INTEGER NOT NULL,
        PRIMARY KEY (team_id, repo_id)
      ) STRICT;
CREATE TABLE teams (
        team_id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;