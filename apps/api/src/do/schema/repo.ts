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
];
