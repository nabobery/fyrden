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
];
