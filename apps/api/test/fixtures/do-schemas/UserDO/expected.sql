CREATE INDEX email_queue_due ON email_queue (due_at);
CREATE INDEX email_queue_repo ON email_queue (repo_id, conversation);
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
CREATE INDEX inbox_evictions_age ON inbox_evictions (event_at);
CREATE INDEX inbox_evictions_stream ON inbox_evictions (repo_id, subject, event_at);
CREATE UNIQUE INDEX inbox_threads_conversation ON inbox_threads (repo_id, conversation);
CREATE INDEX inbox_threads_open ON inbox_threads (subject, updated_at, id)
        WHERE dn_event IS NULL;
CREATE INDEX inbox_threads_open_stream ON inbox_threads (repo_id, subject, updated_at, id)
        WHERE dn_event IS NULL;
CREATE INDEX inbox_threads_stream ON inbox_threads (repo_id, subject, updated_at, id);
CREATE INDEX inbox_threads_unread ON inbox_threads (subject, unread, updated_at, id);
CREATE INDEX live_budget_balances_budget
        ON live_budget_balances (budget_incarnation, budget_epoch, budget_seq, operation_id, day);
CREATE INDEX live_budget_balances_pool ON live_budget_balances (kind, day, budget_seq);
CREATE INDEX live_budget_completions_budget
        ON live_budget_completions (budget_incarnation, budget_epoch, budget_seq, operation_id);
CREATE INDEX live_budget_pending_budget
        ON live_budget_pending (budget_incarnation, budget_epoch, budget_seq, kind);
CREATE INDEX live_budget_terminal_budget
        ON live_budget_terminal (budget_incarnation, budget_epoch, budget_seq, socket_id, day);
CREATE INDEX live_candidates_budget ON live_candidates (budget_incarnation, budget_epoch, budget_seq, stream, conversation);
CREATE INDEX live_candidates_last ON live_candidates (max(direct_seq, ordinary_seq));
CREATE INDEX live_dirty_budget ON live_dirty (budget_incarnation, budget_epoch, budget_seq, stream);
CREATE INDEX live_dirty_seq ON live_dirty (seq);
CREATE INDEX live_local_budget ON live_local (budget_incarnation, budget_epoch, budget_seq, socket_id);
CREATE INDEX live_local_credential ON live_local (credential_id);
CREATE INDEX live_local_deps_budget ON live_local_deps (budget_incarnation, budget_epoch, budget_seq, socket_id, dependency);
CREATE INDEX live_local_deps_dependency ON live_local_deps (dependency);
CREATE INDEX live_revoked_at ON live_revoked (at);
CREATE INDEX live_revoked_budget ON live_revoked (budget_incarnation, budget_epoch, budget_seq, dependency);
CREATE INDEX live_tickets_budget ON live_tickets (budget_incarnation, budget_epoch, budget_seq, ticket_hash);
CREATE INDEX live_tickets_expiry ON live_tickets (expires_at, ticket_hash);
CREATE INDEX purge_marks_until ON purge_marks (until_at);
CREATE TABLE email_queue (
        event_key TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        conversation TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        member TEXT,
        actor TEXT,
        action TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN ('direct', 'participating')),
        reason TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        arrival INTEGER NOT NULL,
        due_at INTEGER NOT NULL,
        tries INTEGER NOT NULL
      ) STRICT, WITHOUT ROWID;
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
        event_at INTEGER NOT NULL, subject TEXT NOT NULL DEFAULT '', event_key TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (repo_id, thread_key, kind)
      ) STRICT, WITHOUT ROWID;
CREATE TABLE "feed_items" (
        repo_id TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        thread_epoch INTEGER NOT NULL,
        version INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
        priority TEXT NOT NULL CHECK (priority IN ('P0', 'P1', 'P2')),
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
        seq_at INTEGER NOT NULL,
        subject TEXT NOT NULL,
        order_at INTEGER NOT NULL,
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
CREATE TABLE inbox_evictions (
        repo_id TEXT NOT NULL,
        conversation TEXT NOT NULL,
        subject TEXT NOT NULL CHECK (subject IN ('issue', 'pull')),
        nt_epoch INTEGER NOT NULL,
        nt_version INTEGER NOT NULL,
        nt_event TEXT NOT NULL,
        event_at INTEGER NOT NULL,
        PRIMARY KEY (repo_id, conversation)
      ) STRICT, WITHOUT ROWID;
CREATE TABLE inbox_streams (
        repo_id TEXT NOT NULL,
        subject TEXT NOT NULL CHECK (subject IN ('issue', 'pull')),
        threads INTEGER NOT NULL,
        PRIMARY KEY (repo_id, subject)
      ) STRICT, WITHOUT ROWID;
CREATE TABLE inbox_threads (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        conversation TEXT NOT NULL,
        subject TEXT NOT NULL CHECK (subject IN ('issue', 'pull')),
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        reason TEXT NOT NULL,
        unread INTEGER NOT NULL CHECK (unread IN (0, 1)),
        updated_at INTEGER NOT NULL,
        last_read_at INTEGER,
        nt_epoch INTEGER NOT NULL,
        nt_version INTEGER NOT NULL,
        nt_event TEXT NOT NULL,
        rd_epoch INTEGER,
        rd_version INTEGER,
        rd_event TEXT,
        dn_epoch INTEGER,
        dn_version INTEGER,
        dn_event TEXT
      ) STRICT, WITHOUT ROWID;
CREATE TABLE live_budget_balances (
        operation_id TEXT NOT NULL,
        day INTEGER NOT NULL CHECK (day >= 0),
        kind TEXT NOT NULL CHECK (kind IN ('control', 'mark')),
        remaining TEXT NOT NULL CHECK (coalesce(
          json_valid(remaining)
          AND json(remaining) = json_object('do_requests', json_extract(remaining, '$.do_requests'), 'do_rows_read', json_extract(remaining, '$.do_rows_read'), 'do_rows_written', json_extract(remaining, '$.do_rows_written'), 'do_duration_ms', json_extract(remaining, '$.do_duration_ms'), 'd1_rows_read', json_extract(remaining, '$.d1_rows_read'), 'd1_rows_written', json_extract(remaining, '$.d1_rows_written'), 'queue_ops', json_extract(remaining, '$.queue_ops'))
          AND json_type(remaining, '$.do_requests') = 'integer'
          AND json_extract(remaining, '$.do_requests') BETWEEN 0 AND 9007199254740991
          AND json_type(remaining, '$.do_rows_read') = 'integer'
          AND json_extract(remaining, '$.do_rows_read') BETWEEN 0 AND 9007199254740991
          AND json_type(remaining, '$.do_rows_written') = 'integer'
          AND json_extract(remaining, '$.do_rows_written') BETWEEN 0 AND 9007199254740991
          AND json_type(remaining, '$.do_duration_ms') = 'integer'
          AND json_extract(remaining, '$.do_duration_ms') BETWEEN 0 AND 9007199254740991
          AND json_type(remaining, '$.d1_rows_read') = 'integer'
          AND json_extract(remaining, '$.d1_rows_read') BETWEEN 0 AND 9007199254740991
          AND json_type(remaining, '$.d1_rows_written') = 'integer'
          AND json_extract(remaining, '$.d1_rows_written') BETWEEN 0 AND 9007199254740991
          AND json_type(remaining, '$.queue_ops') = 'integer'
          AND json_extract(remaining, '$.queue_ops') BETWEEN 0 AND 9007199254740991
          AND json_extract(remaining, '$.queue_ops') = 0,
          0
        )),
        budget_epoch INTEGER NOT NULL CHECK (budget_epoch >= 0),
        budget_incarnation TEXT NOT NULL,
        budget_seq INTEGER NOT NULL CHECK (budget_seq > 0),
        budget_valid_until INTEGER NOT NULL CHECK (budget_valid_until >= 0),
        PRIMARY KEY (operation_id, day)
      ) STRICT, WITHOUT ROWID;
CREATE TABLE live_budget_completions (
        operation_id TEXT PRIMARY KEY,
        completion TEXT NOT NULL CHECK (json_valid(completion) AND json_type(completion) = 'object'),
        budget_epoch INTEGER NOT NULL CHECK (budget_epoch >= 0),
        budget_incarnation TEXT NOT NULL,
        budget_seq INTEGER NOT NULL CHECK (budget_seq > 0),
        budget_valid_until INTEGER NOT NULL CHECK (budget_valid_until >= 0)
      ) STRICT, WITHOUT ROWID;
CREATE TABLE live_budget_fence (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        epoch INTEGER NOT NULL CHECK (epoch >= 0),
        incarnation TEXT NOT NULL,
        authorization_gen INTEGER NOT NULL CHECK (authorization_gen >= 0),
        cleanup_through INTEGER NOT NULL CHECK (cleanup_through >= 0)
      ) STRICT;
CREATE TABLE live_budget_pending (
        kind TEXT PRIMARY KEY CHECK (kind IN ('install', 'control_refill', 'mark_refill', 'renewal')),
        operation_id TEXT NOT NULL UNIQUE,
        intended_at INTEGER NOT NULL CHECK (intended_at >= 0),
        authorization_gen INTEGER NOT NULL CHECK (authorization_gen >= 0),
        budget_epoch INTEGER NOT NULL CHECK (budget_epoch >= 0),
        budget_incarnation TEXT NOT NULL,
        budget_seq INTEGER NOT NULL CHECK (budget_seq >= 0),
        budget_valid_until INTEGER NOT NULL CHECK (budget_valid_until >= 0)
      , phase TEXT NOT NULL DEFAULT 'queued' CHECK (phase IN ('queued', 'dispatched')), request_json TEXT CHECK (
          request_json IS NULL
          OR (json_valid(request_json) AND json_type(request_json) = 'object')
        ), owner_id TEXT, dispatch_instance TEXT) STRICT, WITHOUT ROWID;
CREATE TABLE live_budget_terminal (
        socket_id TEXT NOT NULL,
        day INTEGER NOT NULL CHECK (day >= 0),
        operation_id TEXT NOT NULL,
        remaining TEXT NOT NULL CHECK (coalesce(
          json_valid(remaining)
          AND json(remaining) = json_object('do_requests', json_extract(remaining, '$.do_requests'), 'do_rows_read', json_extract(remaining, '$.do_rows_read'), 'do_rows_written', json_extract(remaining, '$.do_rows_written'), 'do_duration_ms', json_extract(remaining, '$.do_duration_ms'), 'd1_rows_read', json_extract(remaining, '$.d1_rows_read'), 'd1_rows_written', json_extract(remaining, '$.d1_rows_written'), 'queue_ops', json_extract(remaining, '$.queue_ops'))
          AND json_type(remaining, '$.do_requests') = 'integer'
          AND json_extract(remaining, '$.do_requests') BETWEEN 0 AND 9007199254740991
          AND json_type(remaining, '$.do_rows_read') = 'integer'
          AND json_extract(remaining, '$.do_rows_read') BETWEEN 0 AND 9007199254740991
          AND json_type(remaining, '$.do_rows_written') = 'integer'
          AND json_extract(remaining, '$.do_rows_written') BETWEEN 0 AND 9007199254740991
          AND json_type(remaining, '$.do_duration_ms') = 'integer'
          AND json_extract(remaining, '$.do_duration_ms') BETWEEN 0 AND 9007199254740991
          AND json_type(remaining, '$.d1_rows_read') = 'integer'
          AND json_extract(remaining, '$.d1_rows_read') BETWEEN 0 AND 9007199254740991
          AND json_type(remaining, '$.d1_rows_written') = 'integer'
          AND json_extract(remaining, '$.d1_rows_written') BETWEEN 0 AND 9007199254740991
          AND json_type(remaining, '$.queue_ops') = 'integer'
          AND json_extract(remaining, '$.queue_ops') BETWEEN 0 AND 9007199254740991
          AND json_extract(remaining, '$.queue_ops') = 0,
          0
        )),
        budget_epoch INTEGER NOT NULL CHECK (budget_epoch >= 0),
        budget_incarnation TEXT NOT NULL,
        budget_seq INTEGER NOT NULL CHECK (budget_seq > 0),
        budget_valid_until INTEGER NOT NULL CHECK (budget_valid_until >= 0),
        PRIMARY KEY (socket_id, day)
      ) STRICT, WITHOUT ROWID;
CREATE TABLE live_candidates (
        stream TEXT NOT NULL,
        conversation TEXT NOT NULL,
        direct_seq INTEGER NOT NULL,
        ordinary_seq INTEGER NOT NULL, budget_epoch INTEGER NOT NULL DEFAULT 0 CHECK (budget_epoch >= 0), budget_incarnation TEXT NOT NULL DEFAULT '', budget_seq INTEGER NOT NULL DEFAULT 0 CHECK (budget_seq >= 0), budget_valid_until INTEGER NOT NULL DEFAULT 0 CHECK (budget_valid_until >= 0),
        PRIMARY KEY (stream, conversation)
      ) STRICT, WITHOUT ROWID;
CREATE TABLE live_dirty (
        stream TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        subject TEXT NOT NULL CHECK (subject IN ('issue', 'pull')),
        seq INTEGER NOT NULL,
        explicit_seq INTEGER NOT NULL,
        many_seq INTEGER NOT NULL
      , budget_epoch INTEGER NOT NULL DEFAULT 0 CHECK (budget_epoch >= 0), budget_incarnation TEXT NOT NULL DEFAULT '', budget_seq INTEGER NOT NULL DEFAULT 0 CHECK (budget_seq >= 0), budget_valid_until INTEGER NOT NULL DEFAULT 0 CHECK (budget_valid_until >= 0)) STRICT, WITHOUT ROWID;
CREATE TABLE live_local (
        socket_id TEXT PRIMARY KEY,
        credential_id TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('confirming', 'open')),
        expires_at INTEGER NOT NULL,
        deadline INTEGER NOT NULL,
        sent INTEGER NOT NULL,
        acked INTEGER NOT NULL,
        refresh_pending INTEGER NOT NULL,
        blocked_since INTEGER,
        renew_failures INTEGER NOT NULL,
        controls_used INTEGER NOT NULL,
        minute_start INTEGER NOT NULL,
        minute_count INTEGER NOT NULL,
        delivered_seq INTEGER NOT NULL,
        retry_at INTEGER NOT NULL,
        scopes TEXT NOT NULL,
        repo_ids TEXT
      , budget_epoch INTEGER NOT NULL DEFAULT 0 CHECK (budget_epoch >= 0), budget_incarnation TEXT NOT NULL DEFAULT '', budget_seq INTEGER NOT NULL DEFAULT 0 CHECK (budget_seq >= 0), budget_valid_until INTEGER NOT NULL DEFAULT 0 CHECK (budget_valid_until >= 0), socket_generation INTEGER NOT NULL DEFAULT 0 CHECK (socket_generation >= 0), renewal_nonce TEXT, renewal_intended_at INTEGER
        CHECK (renewal_intended_at IS NULL OR renewal_intended_at >= 0)) STRICT, WITHOUT ROWID;
CREATE TABLE live_local_deps (
        socket_id TEXT NOT NULL,
        dependency TEXT NOT NULL, budget_epoch INTEGER NOT NULL DEFAULT 0 CHECK (budget_epoch >= 0), budget_incarnation TEXT NOT NULL DEFAULT '', budget_seq INTEGER NOT NULL DEFAULT 0 CHECK (budget_seq >= 0), budget_valid_until INTEGER NOT NULL DEFAULT 0 CHECK (budget_valid_until >= 0),
        PRIMARY KEY (socket_id, dependency)
      ) STRICT, WITHOUT ROWID;
CREATE TABLE live_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        seq INTEGER NOT NULL,
        gen INTEGER NOT NULL
      ) STRICT;
CREATE TABLE live_revoked (
        dependency TEXT PRIMARY KEY,
        at INTEGER NOT NULL
      , budget_epoch INTEGER NOT NULL DEFAULT 0 CHECK (budget_epoch >= 0), budget_incarnation TEXT NOT NULL DEFAULT '', budget_seq INTEGER NOT NULL DEFAULT 0 CHECK (budget_seq >= 0), budget_valid_until INTEGER NOT NULL DEFAULT 0 CHECK (budget_valid_until >= 0)) STRICT, WITHOUT ROWID;
CREATE TABLE live_tickets (
        ticket_hash TEXT PRIMARY KEY,
        credential_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      , budget_epoch INTEGER NOT NULL DEFAULT 0 CHECK (budget_epoch >= 0), budget_incarnation TEXT NOT NULL DEFAULT '', budget_seq INTEGER NOT NULL DEFAULT 0 CHECK (budget_seq >= 0), budget_valid_until INTEGER NOT NULL DEFAULT 0 CHECK (budget_valid_until >= 0)) STRICT, WITHOUT ROWID;
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