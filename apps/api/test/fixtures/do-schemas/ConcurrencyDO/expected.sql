CREATE INDEX concurrency_groups_deadline ON concurrency_groups (release_deadline);
CREATE INDEX concurrency_groups_owner ON concurrency_groups (owner_run);
CREATE INDEX concurrency_groups_pending ON concurrency_groups (pending_run);
CREATE INDEX concurrency_leases_due ON concurrency_leases (lease_expires_at);
CREATE INDEX concurrency_receipts_run ON concurrency_receipts (run_id);
CREATE INDEX concurrency_signals_due ON concurrency_signals (next_at);
CREATE INDEX jobs_due ON jobs (state, next_run_at);
CREATE TABLE ci_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        generation INTEGER NOT NULL
      ) STRICT;
CREATE TABLE concurrency_erasure (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        erased_at INTEGER NOT NULL
      ) STRICT;
CREATE TABLE concurrency_groups (
        group_key TEXT PRIMARY KEY,
        group_name TEXT NOT NULL,
        owner_run TEXT,
        owner_key TEXT,
        generation INTEGER,
        hold_ms INTEGER,
        cancel_requested_at INTEGER,
        release_deadline INTEGER,
        pending_run TEXT,
        pending_key TEXT,
        pending_since INTEGER,
        pending_hold_ms INTEGER,
        updated_at INTEGER NOT NULL,
        CHECK ((owner_run IS NULL) = (owner_key IS NULL) AND (owner_run IS NULL) = (generation IS NULL)),
        CHECK ((pending_run IS NULL) = (pending_key IS NULL)),
        CHECK (owner_run IS NOT NULL OR pending_run IS NULL)
      ) STRICT, WITHOUT ROWID;
CREATE TABLE concurrency_leases (
        run_id TEXT PRIMARY KEY,
        lease_expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT, WITHOUT ROWID;
CREATE TABLE concurrency_receipts (
        group_key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        owner_key TEXT NOT NULL,
        outcome TEXT NOT NULL
          CHECK (outcome IN ('owner', 'pending', 'displaced', 'evicted', 'released')),
        generation INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (group_key, run_id, owner_key)
      ) STRICT, WITHOUT ROWID;
CREATE TABLE concurrency_signals (
        run_id TEXT NOT NULL,
        owner_key TEXT NOT NULL,
        group_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('acquired', 'cancel', 'displaced', 'evicted')),
        generation INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, owner_key, group_key, kind, generation)
      ) STRICT, WITHOUT ROWID;
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