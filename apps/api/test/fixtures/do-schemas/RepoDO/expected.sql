CREATE INDEX archives_created ON archives (created_at);
CREATE UNIQUE INDEX archives_live ON archives (commit_id, format, prefix)
        WHERE state <> 'deleting';
CREATE INDEX audit_log_archived ON audit_log (archived_at) WHERE archived_at IS NOT NULL;
CREATE INDEX audit_log_unarchived ON audit_log (seq) WHERE archived_at IS NULL;
CREATE INDEX audit_segments_archived ON audit_segments (archived_at) WHERE state = 'archived';
CREATE INDEX audit_segments_from ON audit_segments (from_seq);
CREATE INDEX audit_segments_pending ON audit_segments (from_seq) WHERE state = 'pending';
CREATE INDEX audit_segments_to ON audit_segments (to_seq);
CREATE INDEX comments_number ON comments (number, comment_id);
CREATE INDEX event_payloads_sent ON event_payloads (sent_at) WHERE sent_at IS NOT NULL;
CREATE INDEX import_commits_staged ON import_commits (staged_at);
CREATE INDEX jobs_due ON jobs (state, next_run_at);
CREATE INDEX leases_pack ON leases (pack_id, expires_at);
CREATE INDEX mergeability_jobs_waiting ON mergeability_jobs (requested_at, pr_number);
CREATE INDEX outgoing_pulls_head ON outgoing_pulls (head_ref);
CREATE INDEX packs_state ON packs (state, created_at);
CREATE INDEX packs_unit ON packs (unit_id) WHERE unit_id IS NOT NULL;
CREATE INDEX pull_listings_comparison
        ON pull_listings (pr_number, kind, base_sha, head_sha, created_at);
CREATE INDEX pull_listings_created ON pull_listings (created_at);
CREATE INDEX pull_requests_base ON pull_requests (base_ref, state);
CREATE INDEX pull_requests_head ON pull_requests (head_ref, state);
CREATE INDEX pull_requests_head_repo ON pull_requests (head_repo_id, state, number);
CREATE INDEX pull_requests_state ON pull_requests (state, number);
CREATE INDEX reflog_at ON reflog (at);
CREATE INDEX reflog_ref ON reflog (ref, seq);
CREATE INDEX refollow_bases_due ON refollow_bases (next_at);
CREATE INDEX refs_oid ON refs (oid);
CREATE INDEX review_comments_pr ON review_comments (pr_number, comment_id);
CREATE INDEX review_comments_thread ON review_comments (thread_id, comment_id);
CREATE INDEX review_threads_pr ON review_threads (pr_number, thread_id);
CREATE INDEX reviews_pr ON reviews (pr_number, review_id);
CREATE INDEX reviews_standing
        ON reviews (pr_number, reviewer_root, by_agent, state, review_id)
        WHERE dismissed_at IS NULL;
CREATE INDEX reviews_standing_head
        ON reviews (pr_number, reviewer_root, by_agent, commit_sha, state, review_id)
        WHERE dismissed_at IS NULL;
CREATE INDEX revision_imports_waiting ON revision_imports (requested_at, pr_number);
CREATE UNIQUE INDEX rulesets_name ON rulesets (name);
CREATE INDEX uploads_expiry ON uploads (state, expires_at);
CREATE INDEX view_merged_into ON view_merged (into_pack_id, merged_at);
CREATE TABLE acl_snapshot (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        account_id TEXT NOT NULL DEFAULT '',
        epoch_gen INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 0,
        pulled_at INTEGER NOT NULL DEFAULT 0,
        roles TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(roles)),
        floor_epoch INTEGER NOT NULL DEFAULT 0,
        floor_version INTEGER NOT NULL DEFAULT 0
      ) STRICT;
CREATE TABLE archive_segments (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        key TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        PRIMARY KEY (run_id, seq)
      ) STRICT;
CREATE TABLE archive_zip_records (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        record TEXT NOT NULL CHECK (json_valid(record)),
        PRIMARY KEY (run_id, seq)
      ) STRICT;
CREATE TABLE archives (
        run_id TEXT PRIMARY KEY,
        commit_id TEXT NOT NULL,
        format TEXT NOT NULL CHECK (format IN ('tar.gz', 'zip')),
        prefix TEXT NOT NULL,
        network_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('building', 'ready', 'failed', 'deleting')),
        segments INTEGER NOT NULL DEFAULT 0,
        bytes INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        leased_until INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
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
CREATE TABLE claim_releases (
        pack_id TEXT PRIMARY KEY,
        network_id TEXT NOT NULL
      ) STRICT, WITHOUT ROWID;
CREATE TABLE collect_requests (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        due_at INTEGER NOT NULL
      ) STRICT;
CREATE TABLE comments (
        comment_id INTEGER PRIMARY KEY AUTOINCREMENT,
        number INTEGER NOT NULL,
        author_id TEXT NOT NULL,
        author_root TEXT NOT NULL,
        act_chain TEXT,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
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
CREATE TABLE ended_transfers (
        transfer_id TEXT PRIMARY KEY,
        landed INTEGER NOT NULL CHECK (landed IN (0, 1)),
        owner_gen INTEGER NOT NULL,
        ended_at INTEGER NOT NULL
      ) STRICT;
CREATE TABLE event_payloads (
        event_key TEXT PRIMARY KEY,
        payload TEXT NOT NULL CHECK (json_valid(payload)),
        created_at INTEGER NOT NULL
      , sent_at INTEGER) STRICT;
CREATE TABLE feed_participants (
        number INTEGER NOT NULL,
        principal TEXT NOT NULL,
        -- The root identity it counts as (the user its agents act for).
        root TEXT NOT NULL,
        reason TEXT NOT NULL,
        joined_seq INTEGER NOT NULL,
        PRIMARY KEY (number, principal)
      ) STRICT;
CREATE TABLE feed_threads (
        thread_key TEXT PRIMARY KEY,
        version INTEGER NOT NULL
      ) STRICT;
CREATE TABLE generation (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        template_id TEXT NOT NULL,
        started_at INTEGER NOT NULL
      , abandoned_at INTEGER) STRICT;
CREATE TABLE git_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    network_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
CREATE TABLE head_follows (
        pr_number INTEGER PRIMARY KEY,
        head_repo_id TEXT NOT NULL,
        head_ref TEXT NOT NULL,
        generation INTEGER NOT NULL,
        follow INTEGER NOT NULL CHECK (follow IN (0, 1)),
        known_sha TEXT,
        requested_at INTEGER NOT NULL,
        next_at INTEGER NOT NULL DEFAULT 0
      , revision INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE import_commits (
        import_id TEXT NOT NULL,
        oid BLOB NOT NULL,
        tree BLOB NOT NULL,
        parents BLOB NOT NULL,
        commit_time INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        level INTEGER NOT NULL,
        signature TEXT,
        staged_at INTEGER NOT NULL,
        PRIMARY KEY (import_id, oid)
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
CREATE TABLE merge_saga_objects (
        saga_id TEXT NOT NULL,
        oid BLOB NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('blob', 'tree', 'commit')),
        data BLOB NOT NULL,
        PRIMARY KEY (saga_id, oid)
      ) STRICT;
CREATE TABLE merge_sagas (
        pr_number INTEGER PRIMARY KEY,
        saga_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('running', 'done', 'failed')),
        pull_json TEXT NOT NULL,
        stamps_json TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        base_tip TEXT NOT NULL,
        head TEXT NOT NULL,
        up_to_date INTEGER NOT NULL CHECK (up_to_date IN (0, 1)),
        committer_json TEXT NOT NULL,
        committed_at INTEGER NOT NULL,
        key_id TEXT NOT NULL,
        commits BLOB NOT NULL,
        next INTEGER NOT NULL,
        tip TEXT NOT NULL,
        tip_tree TEXT NOT NULL,
        staged_bytes INTEGER NOT NULL,
        staged_objects INTEGER NOT NULL,
        upload_json TEXT,
        result_sha TEXT,
        error_json TEXT,
        failures INTEGER NOT NULL DEFAULT 0,
        reported INTEGER NOT NULL DEFAULT 0 CHECK (reported IN (0, 1)),
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
CREATE TABLE mergeability (
        pr_number INTEGER PRIMARY KEY,
        base_sha TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('clean', 'conflicts', 'manual', 'unknown', 'error')),
        computed_at INTEGER NOT NULL
      ) STRICT;
CREATE TABLE mergeability_jobs (
        pr_number INTEGER PRIMARY KEY,
        seq INTEGER NOT NULL,
        requested_at INTEGER NOT NULL
      ) STRICT;
CREATE TABLE networks (
        network_id TEXT PRIMARY KEY,
        recorded_at INTEGER NOT NULL
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
CREATE TABLE outgoing_pulls (
        base_repo_id TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        head_ref TEXT NOT NULL,
        generation INTEGER NOT NULL, maintainer_can_modify INTEGER NOT NULL DEFAULT 0, author_root TEXT, consent_version INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (base_repo_id, pr_number)
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
CREATE TABLE pull_heads (
        pr_number INTEGER NOT NULL,
        sha TEXT NOT NULL,
        PRIMARY KEY (pr_number, sha)
      ) STRICT;
CREATE TABLE pull_listings (
        listing_id TEXT PRIMARY KEY,
        pr_number INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('files', 'commits')),
        base_sha TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
CREATE TABLE pull_requests (
        number INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT,
        state TEXT NOT NULL CHECK (state IN ('open', 'closed', 'merged')),
        draft INTEGER NOT NULL CHECK (draft IN (0, 1)),
        author_id TEXT NOT NULL,
        author_root TEXT NOT NULL,
        author_act TEXT,
        base_ref TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        head_ref TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        head_ref_deleted INTEGER NOT NULL DEFAULT 0 CHECK (head_ref_deleted IN (0, 1)),
        generation INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 1,
        closed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      , last_pusher TEXT, last_pusher_grant TEXT, last_push_at INTEGER, merge_commit_sha TEXT, merged_by TEXT, merged_at INTEGER, head_repo_id TEXT, head_ref_version INTEGER, maintainer_can_modify INTEGER NOT NULL DEFAULT 0, approvals_after INTEGER NOT NULL DEFAULT 0, reviews_revision INTEGER NOT NULL DEFAULT 0) STRICT;
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
CREATE TABLE refollow_bases (
        base_repo_id TEXT PRIMARY KEY,
        after INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL DEFAULT 0
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
        CHECK (visibility IS NULL OR visibility IN ('public', 'internal', 'private')), pushed_at INTEGER, description TEXT, name_gen INTEGER NOT NULL DEFAULT 0, deleting_at INTEGER, transfer_id TEXT, transfer_to TEXT, next_number INTEGER NOT NULL DEFAULT 1) STRICT;
CREATE TABLE review_comments (
        comment_id INTEGER PRIMARY KEY AUTOINCREMENT,
        pr_number INTEGER NOT NULL,
        thread_id INTEGER NOT NULL,
        in_reply_to INTEGER,
        author_id TEXT NOT NULL,
        author_root TEXT NOT NULL,
        act_chain TEXT,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      ) STRICT;
CREATE TABLE review_requests (
        pr_number INTEGER NOT NULL,
        reviewer_id TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        requested_at INTEGER NOT NULL, reviewer_root TEXT,
        PRIMARY KEY (pr_number, reviewer_id)
      ) STRICT;
CREATE TABLE review_threads (
        thread_id INTEGER PRIMARY KEY AUTOINCREMENT,
        pr_number INTEGER NOT NULL,
        commit_sha TEXT NOT NULL,
        path TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('LEFT', 'RIGHT')),
        line INTEGER NOT NULL,
        start_line INTEGER,
        resolved_at INTEGER,
        resolved_by TEXT,
        version INTEGER NOT NULL DEFAULT 1
      , merge_base_sha TEXT) STRICT;
CREATE TABLE reviews (
        review_id INTEGER PRIMARY KEY AUTOINCREMENT,
        pr_number INTEGER NOT NULL,
        reviewer_id TEXT NOT NULL,
        reviewer_root TEXT NOT NULL,
        by_agent INTEGER NOT NULL CHECK (by_agent IN (0, 1)),
        act_chain TEXT,
        state TEXT NOT NULL CHECK (state IN ('APPROVED', 'CHANGES_REQUESTED', 'COMMENTED')),
        commit_sha TEXT NOT NULL,
        body TEXT,
        submitted_at INTEGER NOT NULL,
        dismissed_at INTEGER,
        dismissed_by TEXT,
        dismissal_message TEXT,
        version INTEGER NOT NULL DEFAULT 1
      ) STRICT;
CREATE TABLE revision_imports (
        pr_number INTEGER PRIMARY KEY,
        head_repo_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        ref_version INTEGER NOT NULL,
        sha TEXT NOT NULL,
        pusher TEXT,
        pusher_grant TEXT,
        step TEXT NOT NULL CHECK (step IN ('snapshot', 'share', 'adopt', 'graph', 'publish')),
        lease_id TEXT,
        state TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        requested_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
CREATE TABLE revision_notices (
        base_repo_id TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        ref_version INTEGER NOT NULL,
        sha TEXT,
        pusher TEXT,
        pusher_grant TEXT,
        pushed INTEGER NOT NULL CHECK (pushed IN (0, 1)),
        next_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (base_repo_id, pr_number)
      ) STRICT;
CREATE TABLE rule_suites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        upload_id TEXT NOT NULL,
        ref TEXT NOT NULL,
        before_sha TEXT,
        after_sha TEXT,
        actor_id TEXT NOT NULL,
        pushed_at INTEGER NOT NULL,
        refused INTEGER NOT NULL,
        evaluations TEXT NOT NULL,
        UNIQUE (upload_id, ref)
      ) STRICT;
CREATE TABLE ruleset_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL
      ) STRICT;
CREATE TABLE rulesets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        body TEXT NOT NULL CHECK (json_valid(body)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
CREATE TABLE shallow (
    oid BLOB PRIMARY KEY CHECK (length(oid) = 20)
  ) STRICT, WITHOUT ROWID;
CREATE TABLE storage_owed (
        upload_id TEXT PRIMARY KEY,
        bytes INTEGER NOT NULL,
        owed_at INTEGER NOT NULL
      ) STRICT;
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
CREATE TABLE view_merged (
        pack_id TEXT PRIMARY KEY,
        into_pack_id TEXT NOT NULL,
        merged_at INTEGER NOT NULL
      ) STRICT, WITHOUT ROWID;
CREATE TABLE webhook_ids (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last INTEGER NOT NULL
      ) STRICT;
CREATE TABLE webhooks (
        hook_id INTEGER PRIMARY KEY,
        url TEXT NOT NULL,
        events TEXT NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        config_version INTEGER NOT NULL,
        secrets TEXT NOT NULL,
        api_host TEXT NOT NULL,
        disabled_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;