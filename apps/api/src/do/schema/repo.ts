import { GIT_STORAGE_TABLES_V1 } from "@fyrden/adapters-cloudflare/git";
import type { DoMigration } from "@fyrden/adapters-cloudflare/migrations";

/**
 * RepoDO schema. Released migrations never change; add a new version instead.
 * Every released version gets a fixture in test/fixtures/do-schemas/RepoDO/.
 */
export const repoSchema: readonly DoMigration[] = [
  {
    version: 1,
    name: "repo_meta",
    sql: `
      CREATE TABLE repo_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        repo_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        owner_gen INTEGER NOT NULL DEFAULT 1,
        epoch_gen INTEGER NOT NULL,
        write_frozen INTEGER NOT NULL DEFAULT 0 CHECK (write_frozen IN (0, 1)),
        created_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 2,
    // Refs, reflog, pack registry, commit graph, uploads, leases, locks and
    // jobs. The SQL lives with the adapters that query it and is frozen.
    name: "git_storage",
    sql: GIT_STORAGE_TABLES_V1,
  },
  {
    version: 3,
    // The repository entity that events snapshot, the event sequence, the
    // outbox and its drain state, payloads too large for a queue message,
    // and the append-only audit log.
    name: "events",
    sql: `
      ALTER TABLE repo_meta ADD COLUMN epoch_uuid TEXT;
      ALTER TABLE repo_meta ADD COLUMN source_seq INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE repo_meta ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE repo_meta ADD COLUMN owner_id TEXT;
      ALTER TABLE repo_meta ADD COLUMN name TEXT;
      ALTER TABLE repo_meta ADD COLUMN visibility TEXT
        CHECK (visibility IS NULL OR visibility IN ('public', 'internal', 'private'));
      ALTER TABLE repo_meta ADD COLUMN pushed_at INTEGER;

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

      CREATE TABLE event_payloads (
        event_key TEXT PRIMARY KEY,
        payload TEXT NOT NULL CHECK (json_valid(payload)),
        created_at INTEGER NOT NULL
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
    `,
  },
  {
    version: 4,
    // Audit archive segments: which rows go into which R2 object, recorded
    // before the object is written, so a retried write is the same object.
    name: "audit_archive",
    sql: `
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

      CREATE INDEX audit_log_archived ON audit_log (archived_at) WHERE archived_at IS NOT NULL;
      CREATE INDEX audit_log_unarchived ON audit_log (seq) WHERE archived_at IS NULL;
      CREATE INDEX audit_segments_archived ON audit_segments (archived_at) WHERE state = 'archived';
      CREATE INDEX audit_segments_pending ON audit_segments (from_seq) WHERE state = 'pending';
      CREATE INDEX audit_segments_to ON audit_segments (to_seq);
      CREATE INDEX audit_segments_from ON audit_segments (from_seq);
    `,
  },
  {
    version: 5,
    // Repository settings: the description, and the directory's rename
    // count of the name recorded (renames can arrive out of order).
    name: "repo_settings",
    sql: `
      ALTER TABLE repo_meta ADD COLUMN description TEXT;
      ALTER TABLE repo_meta ADD COLUMN name_gen INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 6,
    // When the repository's deletion froze it (its tombstone was emitted),
    // and every fork network it was ever in (a detach moves it to a new
    // one), for its deletion to leave them all.
    name: "repo_deletion",
    sql: `
      ALTER TABLE repo_meta ADD COLUMN deleting_at INTEGER;

      CREATE TABLE networks (
        network_id TEXT PRIMARY KEY,
        recorded_at INTEGER NOT NULL
      ) STRICT;

      INSERT OR IGNORE INTO networks (network_id, recorded_at)
        SELECT network_id, updated_at FROM git_meta
        UNION ALL SELECT DISTINCT network_id, 0 FROM packs
        UNION ALL SELECT json_extract(CAST(cursor AS TEXT), '$.oldNetworkId'), 0 FROM jobs
          WHERE kind = 'detach' AND cursor IS NOT NULL AND json_valid(CAST(cursor AS TEXT))
            AND json_extract(CAST(cursor AS TEXT), '$.oldNetworkId') IS NOT NULL;
    `,
  },
  {
    version: 7,
    // The ACL snapshot this repository decides access from: pulled from its
    // account's object, with when it was pulled (its age bounds staleness;
    // 0: none), and the floor no snapshot may be below: the newest
    // (epoch_gen, version) seen, from a pull or an invalidation.
    name: "acl_snapshot",
    sql: `
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
    `,
  },
  {
    version: 8,
    // Archives of a commit (tar.gz or zip, under a top directory), built by
    // the `archive` job: one segment per slice, each attempt under its own
    // key below the run's scratch prefix in its network
    // (`net/<network_id>/scratch/<run_id>/<seq>-<attempt>`), the published
    // one recorded in `archive_segments`, served in order. A download
    // leases its archive; pruning marks an archive `deleting` (no longer
    // found) before it deletes its objects. A zip's central directory
    // records wait in `archive_zip_records` until the last segment.
    name: "archives",
    sql: `
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
      CREATE UNIQUE INDEX archives_live ON archives (commit_id, format, prefix)
        WHERE state <> 'deleting';
      CREATE INDEX archives_created ON archives (created_at);

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
    `,
  },
  {
    version: 9,
    // A repository generated from a template: it takes no write but the
    // generation's own first commit until that commit is made, so a failed
    // generation can be deleted without losing anyone's push.
    name: "generation",
    sql: `
      CREATE TABLE generation (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        template_id TEXT NOT NULL,
        started_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 10,
    // Rulesets on the repository's refs, as JSON; `ruleset_version` counts
    // every change, so a push checked against one version is refused when
    // another is current at its commit.
    name: "rulesets",
    sql: `
      CREATE TABLE rulesets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        body TEXT NOT NULL CHECK (json_valid(body)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX rulesets_name ON rulesets (name);

      CREATE TABLE ruleset_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL
      ) STRICT;

    `,
  },
  {
    version: 11,
    // The transfer moving the repository (its id and the account it goes
    // to), set with `write_frozen` while it moves; transfers that ended
    // (landed, in owner generation `owner_gen`, or called off), so a step
    // run again or late is recognized and changes nothing.
    name: "repo_transfer",
    sql: `
      ALTER TABLE repo_meta ADD COLUMN transfer_id TEXT;
      ALTER TABLE repo_meta ADD COLUMN transfer_to TEXT;

      CREATE TABLE ended_transfers (
        transfer_id TEXT PRIMARY KEY,
        landed INTEGER NOT NULL CHECK (landed IN (0, 1)),
        owner_gen INTEGER NOT NULL,
        ended_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 12,
    // A generation settled as abandoned (its request could not confirm it,
    // and no first commit was made): its commit is refused from then on, so
    // the repository can be deleted without losing a late one.
    name: "generation_abandoned",
    sql: `
      ALTER TABLE generation ADD COLUMN abandoned_at INTEGER;
    `,
  },
  {
    version: 13,
    // When a stored payload's event was sent: the payload is kept for a
    // retention from then (consumers fetch it by the event's id), and
    // never deleted before. Payloads stored before this version whose event
    // is no longer in the outbox (matched by its id) count as sent when
    // they were stored.
    name: "event_payloads_sent_at",
    sql: `
      ALTER TABLE event_payloads ADD COLUMN sent_at INTEGER;
      UPDATE event_payloads SET sent_at = created_at
        WHERE event_key NOT IN (
          SELECT json_extract(event, '$.id.sourceId') || ':' ||
            json_extract(event, '$.id.epochGen') || ':' ||
            json_extract(event, '$.id.sourceSeq')
          FROM outbox);
      CREATE INDEX event_payloads_sent ON event_payloads (sent_at) WHERE sent_at IS NOT NULL;
    `,
  },
  {
    version: 14,
    // What `evaluate` rulesets would have refused of a push's ref updates
    // (one row per upload and ref, its rules' findings as JSON), the newest kept.
    name: "rule_suites",
    sql: `
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
    `,
  },
  {
    version: 15,
    // Committed uploads whose bytes the account has not been told of yet:
    // written in the commit's transaction, removed once it confirms them.
    name: "storage_owed",
    sql: `
      CREATE TABLE storage_owed (
        upload_id TEXT PRIMARY KEY,
        bytes INTEGER NOT NULL,
        owed_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 16,
    // Pull requests between branches of the repository. Numbers come from
    // `next_number` (shared with issues), allocated in the transaction that
    // opens one; `refs/pull/<number>/head` follows the head branch while
    // the pull request is open.
    name: "pull_requests",
    sql: `
      ALTER TABLE repo_meta ADD COLUMN next_number INTEGER NOT NULL DEFAULT 1;

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
      ) STRICT;
      CREATE INDEX pull_requests_head ON pull_requests (head_ref, state);
      CREATE INDEX pull_requests_state ON pull_requests (state, number);
    `,
  },
  {
    version: 17,
    // Reviews of pull requests (each bound to the head commit it reviewed;
    // a dismissal keeps the review and records who dismissed it and why),
    // the reviews requested of people and agents, and every head each pull
    // request has had (a review may name an earlier one; kept with the pull
    // request, unlike the reflog).
    name: "pull_request_reviews",
    sql: `
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
      CREATE INDEX reviews_pr ON reviews (pr_number, review_id);

      CREATE TABLE pull_heads (
        pr_number INTEGER NOT NULL,
        sha TEXT NOT NULL,
        PRIMARY KEY (pr_number, sha)
      ) STRICT;

      INSERT INTO pull_heads (pr_number, sha) SELECT number, head_sha FROM pull_requests;

      CREATE TABLE review_requests (
        pr_number INTEGER NOT NULL,
        reviewer_id TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        requested_at INTEGER NOT NULL,
        PRIMARY KEY (pr_number, reviewer_id)
      ) STRICT;
    `,
  },
  {
    version: 18,
    // Conversation comments on pull requests (issues share them once they
    // exist), numbered across the repository as GitHub's comment ids are.
    name: "comments",
    sql: `
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
      CREATE INDEX comments_number ON comments (number, comment_id);
    `,
  },
  {
    version: 19,
    // Comparisons a pull request's file or commit listing was started on,
    // so its later pages compare the same commits: a page's cursor names
    // one by a random id the server made (a cursor cannot name commits of
    // its own choosing). Kept a day; a listing of the same comparison is
    // reused, and the repository keeps a bounded number.
    name: "pull_listings",
    sql: `
      CREATE TABLE pull_listings (
        listing_id TEXT PRIMARY KEY,
        pr_number INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('files', 'commits')),
        base_sha TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX pull_listings_created ON pull_listings (created_at);
      CREATE INDEX pull_listings_comparison
        ON pull_listings (pr_number, kind, base_sha, head_sha, created_at);
    `,
  },
  {
    version: 20,
    // Merging pull requests: who made each head what it is (its opening, a
    // push to its branch, or a reopening that took a newer head), so a
    // merge can ask for an approval from someone else after it (unknown for
    // pull requests opened before this, which no approval comes after), and
    // the merge itself once made.
    name: "pull_request_merges",
    sql: `
      ALTER TABLE pull_requests ADD COLUMN last_pusher TEXT;
      ALTER TABLE pull_requests ADD COLUMN last_pusher_grant TEXT;
      ALTER TABLE pull_requests ADD COLUMN last_push_at INTEGER;
      ALTER TABLE pull_requests ADD COLUMN merge_commit_sha TEXT;
      ALTER TABLE pull_requests ADD COLUMN merged_by TEXT;
      ALTER TABLE pull_requests ADD COLUMN merged_at INTEGER;
    `,
  },
  {
    version: 21,
    // Whether each open pull request merges cleanly, for the pair of base
    // tip and head it was worked out for, and the pull requests waiting for
    // it (one row each: a newer request replaces an older one, keeping its
    // place in the queue).
    name: "mergeability",
    sql: `
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
      CREATE INDEX mergeability_jobs_waiting ON mergeability_jobs (requested_at, pr_number);
      -- Each branch update finds the open pull requests it is the base of.
      CREATE INDEX pull_requests_base ON pull_requests (base_ref, state);
    `,
  },
  {
    version: 22,
    // Comments on pull requests' diffs: each thread is anchored to lines of
    // one file, on one side, at a head the pull request has had (kept when
    // its comments are deleted, until the last one is), and is resolved or
    // not as a whole; its comments are the first and the replies.
    name: "review_comments",
    sql: `
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
      ) STRICT;
      CREATE INDEX review_threads_pr ON review_threads (pr_number, thread_id);

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
      CREATE INDEX review_comments_pr ON review_comments (pr_number, comment_id);
      CREATE INDEX review_comments_thread ON review_comments (thread_id, comment_id);
    `,
  },
  {
    version: 23,
    // Pull requests between repositories of a fork network.
    //
    // In the base: the repository a pull request's head branch is in (null:
    // this one) and the last revision of it applied (its ref-state version
    // there), the imports of a head's revision (its packs borrowed, its
    // commit graph copied, then published as the pull request's head), and
    // the commit rows an import has copied so far (kept apart until the
    // import publishes, so the commit graph only ever holds whole histories).
    //
    // The base tells the head's repository to follow the branch (opened,
    // reopened) or not (closed, merged), from the transaction of the change
    // until it is told.
    //
    // In the head's repository: the pull requests its branches are heads
    // of, and the revisions of them still to be told to the base.
    name: "fork_pulls",
    sql: `
      ALTER TABLE pull_requests ADD COLUMN head_repo_id TEXT;
      ALTER TABLE pull_requests ADD COLUMN head_ref_version INTEGER;

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
      CREATE INDEX revision_imports_waiting ON revision_imports (requested_at, pr_number);

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
      CREATE INDEX import_commits_staged ON import_commits (staged_at);

      CREATE TABLE collect_requests (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        due_at INTEGER NOT NULL
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
      ) STRICT;

      CREATE TABLE outgoing_pulls (
        base_repo_id TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        head_ref TEXT NOT NULL,
        generation INTEGER NOT NULL,
        PRIMARY KEY (base_repo_id, pr_number)
      ) STRICT;
      CREATE INDEX outgoing_pulls_head ON outgoing_pulls (head_ref);

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
    `,
  },
  {
    version: 24,
    // Rebase merges: one saga per pull request (the latest kept), with
    // everything that decides its commits' bytes fixed when it starts, and
    // the objects it has made so far, published together as one push at
    // its end.
    name: "merge_sagas",
    sql: `
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

      CREATE TABLE merge_saga_objects (
        saga_id TEXT NOT NULL,
        oid BLOB NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('blob', 'tree', 'commit')),
        data BLOB NOT NULL,
        PRIMARY KEY (saga_id, oid)
      ) STRICT;
    `,
  },
  {
    version: 25,
    // The repository's webhooks: where events go, which, whether they are
    // on, the version of that configuration (each change bumps it), and
    // their signing secrets, sealed (one, or two while one is replaced).
    name: "webhooks",
    sql: `
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

      CREATE TABLE webhook_ids (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 26,
    // Maintainer edits: whether a pull request's author lets the base's
    // maintainers write its head branch (in another repository). The head's
    // repository keeps its own copy with the registration, with the author's
    // root identity and the pull request's version it was told at (a copy
    // told late never replaces a newer one). A request to tell the head's
    // repository is told apart from the one replacing it by its revision
    // (the pull request's version when it was made).
    name: "maintainer_edits",
    sql: `
      ALTER TABLE pull_requests ADD COLUMN maintainer_can_modify INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE outgoing_pulls ADD COLUMN maintainer_can_modify INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE outgoing_pulls ADD COLUMN author_root TEXT;
      ALTER TABLE outgoing_pulls ADD COLUMN consent_version INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE head_follows ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
    `,
  },
];
