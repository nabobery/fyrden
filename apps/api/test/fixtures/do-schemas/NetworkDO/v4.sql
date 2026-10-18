CREATE TABLE deletions (
        pack_id TEXT PRIMARY KEY,
        condemned_at INTEGER NOT NULL,
        acks_pending TEXT NOT NULL,
        leases_until INTEGER NOT NULL DEFAULT 0,
        not_before INTEGER NOT NULL
      , deleting_since INTEGER) STRICT;
CREATE TABLE gc_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        epoch INTEGER NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('idle', 'mark', 'sweep')),
        fence INTEGER NOT NULL CHECK (fence IN (0, 1)),
        fence_since INTEGER,
        updated_at INTEGER NOT NULL
      ) STRICT;
CREATE TABLE jobs (
        job_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed')),
        cursor BLOB,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_run_at INTEGER NOT NULL,
        lease_expires_at INTEGER,
        claim INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
CREATE TABLE members (
        repo_id TEXT PRIMARY KEY,
        parent_repo_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('joining', 'active', 'detaching', 'detached')),
        joined_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
CREATE TABLE network_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        network_id TEXT NOT NULL,
        membership_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      , claim_seq INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE network_packs (
        pack_id TEXT PRIMARY KEY,
        writer_repo_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('shared', 'condemned', 'deleted')),
        bytes INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
CREATE TABLE pack_claims (
        pack_id TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        claimed_at INTEGER NOT NULL, seq INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (pack_id, repo_id)
      ) STRICT, WITHOUT ROWID;
CREATE INDEX jobs_due ON jobs (state, next_run_at);
CREATE INDEX members_joined ON members (joined_at, repo_id);
CREATE INDEX network_packs_state ON network_packs (state);
CREATE INDEX pack_claims_repo ON pack_claims (repo_id);
INSERT INTO gc_state (id, epoch, phase, fence, fence_since, updated_at) VALUES (1, 0, 'idle', 0, NULL, 0);
