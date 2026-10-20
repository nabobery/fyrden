CREATE INDEX collaborators_handle ON collaborators (repo_id, handle COLLATE NOCASE);
CREATE UNIQUE INDEX default_labels_name ON default_labels (name COLLATE NOCASE);
CREATE INDEX event_payloads_sent ON event_payloads (sent_at) WHERE sent_at IS NOT NULL;
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
CREATE TABLE default_labels (
        position INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT NOT NULL CHECK (length(color) = 6),
        description TEXT
      ) STRICT;
CREATE TABLE event_payloads (
        event_key TEXT PRIMARY KEY,
        payload TEXT NOT NULL CHECK (json_valid(payload)),
        created_at INTEGER NOT NULL,
        sent_at INTEGER
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
      , source_seq INTEGER NOT NULL DEFAULT 0, default_labels_set INTEGER NOT NULL DEFAULT 0
        CHECK (default_labels_set IN (0, 1))) STRICT;
CREATE TABLE outbox (
        source_seq INTEGER PRIMARY KEY,
        event TEXT NOT NULL CHECK (json_valid(event)),
        bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
CREATE TABLE outbox_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        next_drain_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
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
CREATE TABLE released_repos (
        repo_id TEXT PRIMARY KEY,
        transfer_id TEXT NOT NULL,
        released_at INTEGER NOT NULL
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
CREATE TABLE transfer_arrival_collaborators (
        transfer_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        PRIMARY KEY (transfer_id, principal_id)
      ) STRICT;
CREATE TABLE transfer_arrivals (
        transfer_id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('held', 'done')),
        -- The uploads it owes confirmations of, each charged here under its own id.
        owed TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(owed)),
        expires_at INTEGER NOT NULL
      ) STRICT;
CREATE TABLE transfer_ops (
        transfer_id TEXT NOT NULL,
        op TEXT NOT NULL CHECK (op IN ('adopt', 'release')),
        -- What a release handed over (collaborators, storage usage), answered again on a retry.
        handed_over TEXT CHECK (handed_over IS NULL OR json_valid(handed_over)),
        done_at INTEGER NOT NULL,
        PRIMARY KEY (transfer_id, op)
      ) STRICT;