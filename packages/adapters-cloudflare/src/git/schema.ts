/**
 * The git storage tables of a repository Durable Object (`RepoDO`), as one
 * schema migration. The Durable Object's migration list includes this text
 * as one numbered version.
 *
 * Released text never changes: once a build that ran it has shipped, a
 * change is a new migration in the Durable Object's list, never an edit
 * here. The schema-drift test in the API Worker catches an edit.
 *
 * Kinds (pack, job and lease kinds) are checked in code, not with CHECK
 * constraints, so a new kind needs no table rebuild. States are fixed by the
 * state machines and are checked here.
 */
export const GIT_STORAGE_TABLES_V1 = `
  CREATE TABLE git_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    network_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE ref_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    nonff_version INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  INSERT INTO ref_state (id, version, nonff_version, updated_at) VALUES (1, 0, 0, 0);

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
  CREATE INDEX refs_oid ON refs (oid);

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
  CREATE INDEX reflog_ref ON reflog (ref, seq);
  CREATE INDEX reflog_at ON reflog (at);

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
  CREATE INDEX packs_state ON packs (state, created_at);
  CREATE INDEX packs_unit ON packs (unit_id) WHERE unit_id IS NOT NULL;

  CREATE TABLE commits (
    oid BLOB PRIMARY KEY CHECK (length(oid) = 20),
    tree BLOB NOT NULL CHECK (length(tree) = 20),
    parents BLOB NOT NULL CHECK (length(parents) % 20 = 0),
    commit_time INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    level INTEGER NOT NULL,
    signature TEXT
  ) STRICT, WITHOUT ROWID;

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
  CREATE INDEX uploads_expiry ON uploads (state, expires_at);

  CREATE TABLE leases (
    lease_id TEXT NOT NULL,
    pack_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    holder TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (lease_id, pack_id)
  ) STRICT;
  CREATE INDEX leases_pack ON leases (pack_id, expires_at);

  CREATE TABLE locks (
    name TEXT PRIMARY KEY,
    holder TEXT NOT NULL,
    token TEXT NOT NULL,
    acquired_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
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
  CREATE INDEX jobs_due ON jobs (state, next_run_at);
`;
