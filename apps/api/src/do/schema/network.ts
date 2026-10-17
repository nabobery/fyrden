import type { DoMigration } from "@fyrden/adapters-cloudflare/migrations";

/**
 * NetworkDO schema. Released migrations never change;
 * add a new version instead. Every released version gets a fixture in
 * test/fixtures/do-schemas/NetworkDO/.
 *
 * - `network_meta`: the network's id and its membership version (bumped
 *   whenever a member joins, starts detaching or leaves).
 * - `members`: the repositories of the network and the parent each was
 *   forked from. A fork is `joining` until it is published. Members are
 *   walked in the order they joined (`members_joined`, v3).
 * - `network_packs`: packs the network shares, for which this object is the
 *   lifetime authority; `pack_claims`: which members' views hold them, each
 *   claim with the sequence it was last made at (`seq`, v4: a pull request's
 *   share, a restored member's claim and the claim of what a member's view
 *   holds take one of the network's sequences, the last answered in
 *   `network_meta.claim_seq`; other claims 0), so a member's release
 *   removes only a claim no newer than it knew.
 * - `gc_state`: the network collection's epoch, phase and fence (the
 *   collection's cursor is its job's cursor, in `jobs`).
 * - `deletions`: shared packs condemned and waiting for every member's
 *   acknowledgement, their leases and the retention; `deleting_since` (v2)
 *   is the deletion fence: set before the bytes are deleted, after which
 *   nothing takes the pack back.
 * - `jobs`: this object's background work (the same table the repository
 *   objects use, so the same job queue runs it).
 */
export const networkSchema: readonly DoMigration[] = [
  {
    version: 1,
    name: "network_core",
    sql: `
      CREATE TABLE network_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        network_id TEXT NOT NULL,
        membership_version INTEGER NOT NULL,
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

      CREATE TABLE network_packs (
        pack_id TEXT PRIMARY KEY,
        writer_repo_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('shared', 'condemned', 'deleted')),
        bytes INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX network_packs_state ON network_packs (state);

      CREATE TABLE pack_claims (
        pack_id TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        claimed_at INTEGER NOT NULL,
        PRIMARY KEY (pack_id, repo_id)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX pack_claims_repo ON pack_claims (repo_id);

      CREATE TABLE gc_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        epoch INTEGER NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('idle', 'mark', 'sweep')),
        fence INTEGER NOT NULL CHECK (fence IN (0, 1)),
        fence_since INTEGER,
        updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO gc_state (id, epoch, phase, fence, updated_at) VALUES (1, 0, 'idle', 0, 0);

      CREATE TABLE deletions (
        pack_id TEXT PRIMARY KEY,
        condemned_at INTEGER NOT NULL,
        acks_pending TEXT NOT NULL,
        leases_until INTEGER NOT NULL DEFAULT 0,
        not_before INTEGER NOT NULL
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
    `,
  },
  {
    version: 2,
    name: "deletion_fence",
    sql: `
      ALTER TABLE deletions ADD COLUMN deleting_since INTEGER;
    `,
  },
  {
    version: 3,
    name: "members_joined",
    sql: `
      CREATE INDEX members_joined ON members (joined_at, repo_id);
    `,
  },
  {
    version: 4,
    name: "claim_seq",
    sql: `
      ALTER TABLE network_meta ADD COLUMN claim_seq INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE pack_claims ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
    `,
  },
];
