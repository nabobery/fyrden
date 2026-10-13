CREATE INDEX audit_log_archived ON audit_log (archived_at) WHERE archived_at IS NOT NULL;
CREATE INDEX audit_log_unarchived ON audit_log (seq) WHERE archived_at IS NULL;
CREATE INDEX audit_segments_archived ON audit_segments (archived_at) WHERE state = 'archived';
CREATE INDEX audit_segments_from ON audit_segments (from_seq);
CREATE INDEX audit_segments_pending ON audit_segments (from_seq) WHERE state = 'pending';
CREATE INDEX audit_segments_to ON audit_segments (to_seq);
CREATE INDEX jobs_due ON jobs (state, next_run_at);
CREATE INDEX leases_pack ON leases (pack_id, expires_at);
CREATE INDEX packs_state ON packs (state, created_at);
CREATE INDEX packs_unit ON packs (unit_id) WHERE unit_id IS NOT NULL;
CREATE INDEX reflog_at ON reflog (at);
CREATE INDEX reflog_ref ON reflog (ref, seq);
CREATE INDEX refs_oid ON refs (oid);
CREATE INDEX uploads_expiry ON uploads (state, expires_at);
CREATE TABLE audit_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        epoch_gen INTEGER NOT NULL,
        at INTEGER NOT NULL,
        actor_id TEXT,
        on_behalf_of TEXT,
        act_chain TEXT CHECK (act_chain IS NULL OR json_valid(act_chain)),
        token_id TEXT,
        grant_id TEXT,
        action TEXT NOT NULL,
        target_id TEXT,
        result TEXT NOT NULL,
        details TEXT CHECK (details IS NULL OR json_valid(details)),
        request_id TEXT,
        archived_at INTEGER
      ) STRICT;
CREATE TABLE audit_segments (
        segment_id INTEGER PRIMARY KEY,
        epoch_gen INTEGER NOT NULL,
        from_seq INTEGER NOT NULL,
        to_seq INTEGER NOT NULL CHECK (to_seq >= from_seq),
        r2_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('pending', 'archived')),
        created_at INTEGER NOT NULL,
        archived_at INTEGER
      ) STRICT;
CREATE TABLE commits (
    oid BLOB PRIMARY KEY CHECK (length(oid) = 20),
    tree BLOB NOT NULL CHECK (length(tree) = 20),
    parents BLOB NOT NULL CHECK (length(parents) % 20 = 0),
    commit_time INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    level INTEGER NOT NULL,
    signature TEXT
  ) STRICT, WITHOUT ROWID;
CREATE TABLE event_payloads (
        event_key TEXT PRIMARY KEY,
        payload TEXT NOT NULL CHECK (json_valid(payload)),
        created_at INTEGER NOT NULL
      ) STRICT;
CREATE TABLE git_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    network_id TEXT NOT NULL,
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
CREATE TABLE leases (
    lease_id TEXT NOT NULL,
    pack_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    holder TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (lease_id, pack_id)
  ) STRICT;
CREATE TABLE locks (
    name TEXT PRIMARY KEY,
    holder TEXT NOT NULL,
    token TEXT NOT NULL,
    acquired_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT;
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
CREATE TABLE packs (
    pack_id TEXT PRIMARY KEY,
    network_id TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    trailer_sha BLOB CHECK (trailer_sha IS NULL OR length(trailer_sha) = 20),
    origin TEXT NOT NULL DEFAULT 'own' CHECK (origin IN ('own', 'borrowed')),
    kind TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'indexing', 'indexed', 'live',
      'superseded', 'garbage', 'condemned', 'discarded', 'deleted')),
    object_count INTEGER,
    bytes INTEGER,
    fanout BLOB,
    all_reachable INTEGER NOT NULL DEFAULT 0 CHECK (all_reachable IN (0, 1)),
    reachable_as_of INTEGER,
    unit_id TEXT,
    upload_id TEXT,
    created_at INTEGER NOT NULL,
    last_touched_at INTEGER NOT NULL,
    superseded_at INTEGER,
    condemned_at INTEGER
  ) STRICT;
CREATE TABLE pending_commits (
    upload_id TEXT NOT NULL,
    oid BLOB NOT NULL CHECK (length(oid) = 20),
    tree BLOB NOT NULL CHECK (length(tree) = 20),
    parents BLOB NOT NULL CHECK (length(parents) % 20 = 0),
    commit_time INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    level INTEGER NOT NULL,
    signature TEXT,
    PRIMARY KEY (upload_id, oid)
  ) STRICT, WITHOUT ROWID;
CREATE TABLE ref_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    nonff_version INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
CREATE TABLE reflog (
    seq INTEGER PRIMARY KEY,
    ref TEXT NOT NULL,
    version INTEGER NOT NULL,
    old_oid BLOB,
    new_oid BLOB,
    actor TEXT,
    on_behalf_of TEXT,
    grant_id TEXT,
    token_id TEXT,
    via TEXT CHECK (via IS NULL OR via IN ('push', 'merge', 'api', 'import')),
    upload_id TEXT,
    at INTEGER NOT NULL
  ) STRICT;
CREATE TABLE refs (
    name TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('direct', 'symbolic')),
    oid BLOB CHECK (oid IS NULL OR length(oid) = 20),
    peeled_oid BLOB CHECK (peeled_oid IS NULL OR length(peeled_oid) = 20),
    target TEXT,
    version INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK ((kind = 'direct' AND oid IS NOT NULL AND target IS NULL)
        OR (kind = 'symbolic' AND oid IS NULL AND target IS NOT NULL))
  ) STRICT;
CREATE TABLE repo_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        repo_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        owner_gen INTEGER NOT NULL DEFAULT 1,
        epoch_gen INTEGER NOT NULL,
        write_frozen INTEGER NOT NULL DEFAULT 0 CHECK (write_frozen IN (0, 1)),
        created_at INTEGER NOT NULL
      , epoch_uuid TEXT, source_seq INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 0, owner_id TEXT, name TEXT, visibility TEXT
        CHECK (visibility IS NULL OR visibility IN ('public', 'internal', 'private')), pushed_at INTEGER) STRICT;
CREATE TABLE shallow (
    oid BLOB PRIMARY KEY CHECK (length(oid) = 20)
  ) STRICT, WITHOUT ROWID;
CREATE TABLE uploads (
    upload_id TEXT PRIMARY KEY,
    pack_id TEXT,
    r2_key TEXT,
    multipart_id TEXT,
    principal TEXT NOT NULL,
    grant_id TEXT,
    token_id TEXT,
    quota_reservation_id TEXT,
    commands TEXT NOT NULL,
    atomic INTEGER NOT NULL DEFAULT 0 CHECK (atomic IN (0, 1)),
    state TEXT NOT NULL CHECK (state IN ('open', 'indexing', 'indexed', 'committed',
      'rejected', 'expired')),
    trailer_sha BLOB CHECK (trailer_sha IS NULL OR length(trailer_sha) = 20),
    cursor BLOB,
    deps TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT;