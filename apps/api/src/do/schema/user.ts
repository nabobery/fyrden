import type { DoMigration } from "@fyrden/adapters-cloudflare/migrations";

/**
 * UserDO schema (one user's or agent's object). Released migrations never
 * change; add a new version instead. Every released version gets a fixture
 * in test/fixtures/do-schemas/UserDO/.
 *
 * - `feed_meta`: the feed's epoch (random, made with the object) and the
 *   restore generation it took from the directory (a cursor of another
 *   epoch or generation is expired), its head (the last sequence number
 *   given), the low watermark (the greatest sequence number retention
 *   deleted) and how many items it holds.
 * - `feed_items`: one item per repository, thread and kind, updated in
 *   place; every change takes the next sequence number (`feed_seq`), so the
 *   feed in sequence order is the order changes arrived in. A row without
 *   one is a tombstone: never shown, it keeps what resolved something the
 *   feed has not shown, against older entries arriving later
 *   (`feed_tombstones` finds the oldest for retention). `thread_epoch` and
 *   `version`: the thread's version, in the repository's restore
 *   generation (a newer one's versions are newer). `members`: the ids an
 *   activity item aggregates (JSON, at most 100, each with when and by whom
 *   it was made), `truncated` once any was dropped; `display_member`: the
 *   member the item displays (an activity item's greatest, whose author
 *   `actor` is), its text read from the repository when the item is read;
 *   `acked_epoch` and `acked_version`: the version the feed's owner last
 *   acknowledged (0 for none).
 * - `purge_marks`: repositories the owner lost read access to, with when
 *   (`until_at`: entries of events up to then are dropped on arrival), and
 *   the account that said so at its `(epoch_gen, acl_version)` (an older
 *   one of the same account changes nothing).
 * - `feed_evictions` (v2): items the cap deleted, by the version they were
 *   at, so an entry up to it arriving later does not bring the item back
 *   (unlike a tombstone, which an opening entry shows); kept until entries
 *   that old are dropped for their age (`event_at`: the item's last event),
 *   or past their cap the oldest.
 * - `feed_retired` (v4): the principal was deleted: the feed holds nothing
 *   and takes nothing from then on.
 */
export const userSchema: readonly DoMigration[] = [
  {
    version: 1,
    name: "feed",
    sql: `
      CREATE TABLE feed_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        epoch TEXT NOT NULL,
        epoch_gen INTEGER NOT NULL,
        head_seq INTEGER NOT NULL,
        low_watermark INTEGER NOT NULL,
        items INTEGER NOT NULL
      ) STRICT;
      INSERT INTO feed_meta (id, epoch, epoch_gen, head_seq, low_watermark, items)
        VALUES (1, lower(hex(randomblob(8))), 0, 0, 0, 0);

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
        seq_at INTEGER NOT NULL,
        PRIMARY KEY (repo_id, thread_key, kind)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX feed_tombstones ON feed_items (seq_at) WHERE feed_seq IS NULL;

      CREATE TABLE purge_marks (
        repo_id TEXT PRIMARY KEY,
        until_at INTEGER NOT NULL,
        account_id TEXT NOT NULL,
        epoch_gen INTEGER NOT NULL,
        acl_version INTEGER NOT NULL
      ) STRICT, WITHOUT ROWID;
    `,
  },
  {
    version: 2,
    name: "feed_evictions",
    sql: `
      CREATE TABLE feed_evictions (
        repo_id TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        thread_epoch INTEGER NOT NULL,
        version INTEGER NOT NULL,
        event_at INTEGER NOT NULL,
        PRIMARY KEY (repo_id, thread_key, kind)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX feed_evictions_at ON feed_evictions (event_at);
    `,
  },
  {
    version: 3,
    // A token that reads one kind of thread (issues or pull requests) reads
    // its feed through this index: the other kind's items cost nothing.
    name: "feed_items_subject",
    sql: `
      CREATE INDEX feed_items_subject
        ON feed_items (substr(thread_key, 1, instr(thread_key, '/') - 1), feed_seq)
        WHERE feed_seq IS NOT NULL;
    `,
  },
  {
    version: 4,
    name: "feed_retired",
    sql: `
      CREATE TABLE feed_retired (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        at INTEGER NOT NULL
      ) STRICT;
    `,
  },
];
