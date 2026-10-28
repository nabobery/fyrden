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
 *   (`feed_items_age`, since v6, finds the oldest for retention). `thread_epoch` and
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
 * - `feed_streams` (v6): the feed's streams, one per repository and what
 *   its threads are about (`subject`: `issue`, `pull`), each with its low
 *   watermark (the greatest sequence number retention or the stream's cap
 *   deleted from it) and counts of shown items and tombstones. An item's
 *   `order_at` (v6) is its retention clock: when it last changed, never
 *   before its stream's last change, so a stream's expired items are a
 *   prefix of its sequence. `feed_meta.legacy_head` (v6) and
 *   `low_watermark` are the feed's head and low watermark as v6 found them,
 *   only to judge cursors of before; `feed_meta.items` is no longer kept.
 * - `feed_cursors` (v6): cursor snapshots, by random id: a credential's
 *   positions in the streams it was shown (`state`, canonical JSON, with
 *   `hash` for finding an equal one), kept a day from `created_at`.
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
  {
    version: 5,
    // The object's deferred work, by kind, each due at its time: the alarm is
    // the earliest. Retention's row is seeded from what the feed holds (its
    // alarm, set before, stays): due when the oldest item, tombstone, mark or
    // fence expires (7 days, the retention then), at once past the 5,000 cap;
    // none for an empty feed, or one retired (cleaned when it was).
    name: "user_schedule",
    sql: `
      CREATE TABLE user_schedule (
        kind TEXT PRIMARY KEY,
        due_at INTEGER NOT NULL
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX feed_items_seq_at ON feed_items (seq_at, feed_seq);
      CREATE INDEX purge_marks_until ON purge_marks (until_at);
      INSERT INTO user_schedule (kind, due_at)
        SELECT 'retain',
          CASE WHEN (SELECT items FROM feed_meta WHERE id = 1) > 5000 THEN 0
            ELSE oldest + 604800000 END
        FROM (SELECT min(at) AS oldest FROM (
          SELECT min(seq_at) AS at FROM feed_items
          UNION ALL SELECT min(until_at) FROM purge_marks
          UNION ALL SELECT min(event_at) FROM feed_evictions))
        WHERE oldest IS NOT NULL AND NOT EXISTS (SELECT 1 FROM feed_retired);
    `,
  },
  {
    version: 6,
    // Streams: a repository's issue threads, or its pull requests', each with
    // its own cap and low watermark, and a reader's positions kept per stream,
    // so activity in one never evicts, expires or moves another's. Sequence
    // numbers stay the feed's (a reader's position in a stream is the number
    // of the last item of it given). Items get their stream (`subject`) and
    // `order_at`, the retention clock: the running greatest `seq_at` in their
    // stream's order (so a stream's expired items are a prefix of it; a
    // tombstone's is its `seq_at`), later changes taking now or their
    // stream's last, whichever is later. Each stream is trimmed
    // to its caps at once (500 shown items and 500 tombstones, the oldest
    // going, each leaving a fence; 100 fences a stream), its low watermark the
    // greatest sequence number trimmed. Indexes are kept to what a write must,
    // each being a row written on Workers Free's daily allowance.
    name: "feed_streams",
    // Rebuilds `feed_items` (a CHECK cannot be altered: priorities gain P2,
    // watched activity), dropping its indexes by time and kind with it: only
    // this object's code reads them, the object migrates before it answers
    // anything, and earlier code refuses a newer schema rather than reading it.
    contract: {
      safeSince: "the release adding feed streams",
      reason: "feed_items is rebuilt under its own name; only UserDO code reads it",
    },
    sql: `
      CREATE TABLE feed_items_v6 (
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
      INSERT INTO feed_items_v6
        SELECT repo_id, thread_key, kind, number, title, thread_epoch, version, state, priority,
          reasons, silent, action, actor, actor_trust, display_member, members, truncated,
          last_event_key, last_event_at, acked_epoch, acked_version, feed_seq, seq_at, subject,
          CASE WHEN feed_seq IS NULL THEN seq_at
            ELSE max(seq_at) OVER (PARTITION BY repo_id, subject, feed_seq IS NULL
              ORDER BY feed_seq ROWS UNBOUNDED PRECEDING) END
        FROM (SELECT *, substr(thread_key, 1, instr(thread_key, '/') - 1) AS subject
          FROM feed_items);
      DROP TABLE feed_items;
      ALTER TABLE feed_items_v6 RENAME TO feed_items;

      ALTER TABLE feed_evictions ADD COLUMN subject TEXT NOT NULL DEFAULT '';
      UPDATE feed_evictions SET subject = substr(thread_key, 1, instr(thread_key, '/') - 1);

      CREATE TABLE feed_v6_trimmed (
        repo_id TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        PRIMARY KEY (repo_id, thread_key, kind)
      ) STRICT, WITHOUT ROWID;
      INSERT INTO feed_v6_trimmed
        SELECT repo_id, thread_key, kind FROM (
          SELECT repo_id, thread_key, kind, row_number() OVER (
            PARTITION BY repo_id, subject, feed_seq IS NULL
            ORDER BY feed_seq DESC, order_at DESC, thread_key DESC, kind DESC) AS r
          FROM feed_items)
        WHERE r > 500;
      INSERT INTO feed_evictions (repo_id, thread_key, kind, thread_epoch, version, event_at, subject)
        SELECT repo_id, thread_key, kind, thread_epoch, version, last_event_at, subject
        FROM feed_items WHERE (repo_id, thread_key, kind) IN (SELECT * FROM feed_v6_trimmed)
        ON CONFLICT (repo_id, thread_key, kind) DO UPDATE SET thread_epoch = excluded.thread_epoch,
          version = excluded.version, event_at = excluded.event_at;
      DELETE FROM feed_evictions WHERE (repo_id, thread_key, kind) IN (
        SELECT repo_id, thread_key, kind FROM (
          SELECT repo_id, thread_key, kind, row_number() OVER (
            PARTITION BY repo_id, subject ORDER BY event_at DESC, thread_key DESC, kind DESC) AS r
          FROM feed_evictions)
        WHERE r > 100);

      CREATE TABLE feed_streams (
        repo_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        low_watermark INTEGER NOT NULL,
        items INTEGER NOT NULL,
        tombstones INTEGER NOT NULL,
        PRIMARY KEY (repo_id, subject)
      ) STRICT, WITHOUT ROWID;
      INSERT INTO feed_streams
        SELECT repo_id, subject,
          coalesce(max(CASE WHEN trimmed THEN feed_seq END), 0),
          count(CASE WHEN NOT trimmed THEN feed_seq END),
          count(CASE WHEN NOT trimmed AND feed_seq IS NULL THEN 1 END)
        FROM (SELECT i.repo_id, i.subject, i.feed_seq, t.repo_id IS NOT NULL AS trimmed
          FROM feed_items i LEFT JOIN feed_v6_trimmed t
            ON t.repo_id = i.repo_id AND t.thread_key = i.thread_key AND t.kind = i.kind)
        GROUP BY repo_id, subject;
      DELETE FROM feed_items WHERE (repo_id, thread_key, kind) IN (SELECT * FROM feed_v6_trimmed);
      DROP TABLE feed_v6_trimmed;
      ALTER TABLE feed_meta ADD COLUMN legacy_head INTEGER NOT NULL DEFAULT 0;
      UPDATE feed_meta SET legacy_head = head_seq;

      CREATE INDEX feed_items_stream ON feed_items (repo_id, subject, feed_seq)
        WHERE feed_seq IS NOT NULL;
      CREATE INDEX feed_items_age ON feed_items (order_at);
      CREATE INDEX feed_tombstones_stream ON feed_items (repo_id, subject, order_at)
        WHERE feed_seq IS NULL;
      CREATE INDEX feed_evictions_stream ON feed_evictions (repo_id, subject, event_at);
      CREATE INDEX feed_streams_live ON feed_streams (repo_id, subject) WHERE items > 0;

      CREATE TABLE feed_cursors (
        id TEXT PRIMARY KEY,
        credential TEXT NOT NULL,
        hash INTEGER NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX feed_cursors_credential ON feed_cursors (credential, hash, created_at);
      CREATE INDEX feed_cursors_age ON feed_cursors (created_at);
    `,
  },
  {
    version: 7,
    name: "inbox",
    // The thread inbox: one row a repository and conversation that notified
    // the principal, apart from feed items and agents' acknowledgements. Its
    // id names the repository and conversation (the GitHub thread id); its
    // frontiers are (epoch, version, event) of the feed's thread: the event
    // that last notified (`nt_`), and where it was read (`rd_`) and marked
    // done (`dn_`, null while not done). What a thread has seen is the
    // feed's (its items and fences, a fence now keeping the event that
    // made it), kept by the feed's own rules. At most
    // 250 a repository and kind (counted in `inbox_streams`); an evicted one
    // leaves the event that last notified it as a fence, at most 100 a
    // stream, so another contribution of that event does not make it again.
    sql: `
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
      CREATE UNIQUE INDEX inbox_threads_conversation ON inbox_threads (repo_id, conversation);
      CREATE INDEX inbox_threads_stream ON inbox_threads (repo_id, subject, updated_at, id);
      CREATE INDEX inbox_threads_unread ON inbox_threads (subject, unread, updated_at, id);
      -- Lists read threads not done only.
      CREATE INDEX inbox_threads_open ON inbox_threads (subject, updated_at, id)
        WHERE dn_event IS NULL;
      CREATE INDEX inbox_threads_open_stream ON inbox_threads (repo_id, subject, updated_at, id)
        WHERE dn_event IS NULL;

      CREATE TABLE inbox_streams (
        repo_id TEXT NOT NULL,
        subject TEXT NOT NULL CHECK (subject IN ('issue', 'pull')),
        threads INTEGER NOT NULL,
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
      CREATE INDEX inbox_evictions_stream ON inbox_evictions (repo_id, subject, event_at);
      CREATE INDEX inbox_evictions_age ON inbox_evictions (event_at);

      ALTER TABLE feed_evictions ADD COLUMN event_key TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    version: 8,
    name: "email_queue",
    // Notification emails waiting to be sent (src/email/notifications.ts): one an event, made
    // from the entry the repository marked, what the message says of the event kept, what can
    // change read again when it is sent. At most 200; due by `due_at` (the alarm's `email` kind).
    sql: `
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
      CREATE INDEX email_queue_due ON email_queue (due_at);
      CREATE INDEX email_queue_repo ON email_queue (repo_id, conversation);
    `,
  },
];
