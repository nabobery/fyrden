import type { DoMigration } from "@fyrden/adapters-cloudflare/migrations";

/**
 * UserDO schema (one user's or agent's object). Released migrations never
 * change; add a new version instead. Every released version gets a fixture
 * in test/fixtures/do-schemas/UserDO/.
 *
 * - `feed_meta`: the feed's epoch (random, made with the object: a cursor
 *   of another epoch is expired), its head (the last sequence number
 *   given), the low watermark (the greatest sequence number retention
 *   deleted) and how many items it holds.
 * - `feed_items`: one item per repository, thread and kind, updated in
 *   place; every change takes the next sequence number (`feed_seq`), so the
 *   feed in sequence order is the order changes arrived in. `members`: the
 *   ids an activity item aggregates (JSON, at most 100), `truncated` once
 *   any was dropped; `excerpt_member`: the member the excerpt was taken
 *   from (a comment's edit or deletion changes it); `acked_version`: the
 *   version the feed's owner last acknowledged (0 for none).
 */
export const userSchema: readonly DoMigration[] = [
  {
    version: 1,
    name: "feed",
    sql: `
      CREATE TABLE feed_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        epoch TEXT NOT NULL,
        head_seq INTEGER NOT NULL,
        low_watermark INTEGER NOT NULL,
        items INTEGER NOT NULL
      ) STRICT;
      INSERT INTO feed_meta (id, epoch, head_seq, low_watermark, items)
        VALUES (1, lower(hex(randomblob(8))), 0, 0, 0);

      CREATE TABLE feed_items (
        repo_id TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        version INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
        priority TEXT NOT NULL CHECK (priority IN ('P0', 'P1')),
        reasons TEXT NOT NULL,
        silent INTEGER NOT NULL CHECK (silent IN (0, 1)),
        action TEXT NOT NULL,
        actor TEXT,
        actor_trust TEXT NOT NULL CHECK (actor_trust IN ('write', 'read', 'none')),
        excerpt TEXT,
        excerpt_member TEXT,
        members TEXT NOT NULL,
        truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
        last_event_key TEXT NOT NULL,
        last_event_at INTEGER NOT NULL,
        acked_version INTEGER NOT NULL DEFAULT 0,
        feed_seq INTEGER NOT NULL UNIQUE,
        seq_at INTEGER NOT NULL,
        PRIMARY KEY (repo_id, thread_key, kind)
      ) STRICT, WITHOUT ROWID;
    `,
  },
];
