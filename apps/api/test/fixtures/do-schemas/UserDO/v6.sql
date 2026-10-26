CREATE TABLE feed_cursors (
        id TEXT PRIMARY KEY,
        credential TEXT NOT NULL,
        hash INTEGER NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT, WITHOUT ROWID;
CREATE TABLE feed_evictions (
        repo_id TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        thread_epoch INTEGER NOT NULL,
        version INTEGER NOT NULL,
        event_at INTEGER NOT NULL, subject TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (repo_id, thread_key, kind)
      ) STRICT, WITHOUT ROWID;
CREATE TABLE feed_items (
        repo_id TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        thread_epoch INTEGER NOT NULL,
        version INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
        priority TEXT NOT NULL CHECK (priority IN ('P0', 'P1')),
        reasons TEXT NOT NULL,
        silent INTEGER NOT NULL CHECK (silent IN (0, 1)),
        action TEXT NOT NULL,
        actor TEXT,
        actor_trust TEXT NOT NULL CHECK (actor_trust IN ('write', 'read', 'none')),
        display_member TEXT,
        members TEXT NOT NULL,
        truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
        last_event_key TEXT NOT NULL,
        last_event_at INTEGER NOT NULL,
        acked_epoch INTEGER NOT NULL DEFAULT 0,
        acked_version INTEGER NOT NULL DEFAULT 0,
        feed_seq INTEGER UNIQUE,
        seq_at INTEGER NOT NULL, subject TEXT NOT NULL DEFAULT '', order_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (repo_id, thread_key, kind)
      ) STRICT, WITHOUT ROWID;
CREATE TABLE feed_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        epoch TEXT NOT NULL,
        epoch_gen INTEGER NOT NULL,
        head_seq INTEGER NOT NULL,
        low_watermark INTEGER NOT NULL,
        items INTEGER NOT NULL
      , legacy_head INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE feed_retired (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        at INTEGER NOT NULL
      ) STRICT;
CREATE TABLE feed_streams (
        repo_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        low_watermark INTEGER NOT NULL,
        items INTEGER NOT NULL,
        tombstones INTEGER NOT NULL,
        PRIMARY KEY (repo_id, subject)
      ) STRICT, WITHOUT ROWID;
CREATE TABLE purge_marks (
        repo_id TEXT PRIMARY KEY,
        until_at INTEGER NOT NULL,
        account_id TEXT NOT NULL,
        epoch_gen INTEGER NOT NULL,
        acl_version INTEGER NOT NULL
      ) STRICT, WITHOUT ROWID;
CREATE TABLE user_schedule (
        kind TEXT PRIMARY KEY,
        due_at INTEGER NOT NULL
      ) STRICT, WITHOUT ROWID;
CREATE INDEX feed_cursors_age ON feed_cursors (created_at);
CREATE INDEX feed_cursors_credential ON feed_cursors (credential, hash, created_at);
CREATE INDEX feed_evictions_at ON feed_evictions (event_at);
CREATE INDEX feed_evictions_stream ON feed_evictions (repo_id, subject, event_at);
CREATE INDEX feed_items_age ON feed_items (order_at);
CREATE INDEX feed_items_stream ON feed_items (repo_id, subject, feed_seq)
        WHERE feed_seq IS NOT NULL;
CREATE INDEX feed_streams_live ON feed_streams (repo_id, subject) WHERE items > 0;
CREATE INDEX feed_tombstones_stream ON feed_items (repo_id, subject, order_at)
        WHERE feed_seq IS NULL;
CREATE INDEX purge_marks_until ON purge_marks (until_at);
