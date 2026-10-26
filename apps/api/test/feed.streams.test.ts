// A feed's streams (a repository's issue threads, or its pull requests'):
// the v6 migration that made them, cursor snapshots, coverage, and the
// scheduling of their cleanup.

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { applyDoMigrations } from "@fyrden/adapters-cloudflare/migrations";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it, vi } from "vitest";
import { userSchema } from "../src/do/schema/user.js";
import type { UserDO } from "../src/do/UserDO.js";
import { FEED_POLICY, Feed, type StreamRead } from "../src/do/user/feed.js";
import userV5 from "./fixtures/do-schemas/UserDO/v5.sql?raw";
import { DAY, entry, FROM_START, feedIn, inFeed } from "./helpers/feed.js";

type V5Row = {
  repo: string;
  thread: string;
  kind?: string;
  seq: number | null;
  seqAt: number;
  acked?: number;
};

/** A v5 feed's rows, as a release before streams wrote them. */
function v5(sql: SqlStorage, head: number, low: number, rows: readonly V5Row[]): void {
  sql.exec(userV5);
  sql.exec(
    `INSERT INTO feed_meta (id, epoch, epoch_gen, head_seq, low_watermark, items)
     VALUES (1, 'e', 0, ?, ?, ?)`,
    head,
    low,
    rows.filter((r) => r.seq !== null).length,
  );
  for (const r of rows)
    sql.exec(
      `INSERT INTO feed_items (repo_id, thread_key, kind, number, title, thread_epoch, version,
         state, priority, reasons, silent, action, actor, actor_trust, display_member, members,
         truncated, last_event_key, last_event_at, acked_epoch, acked_version, feed_seq, seq_at)
       VALUES (?, ?, ?, 1, 't', 1, 2, 'open', 'P1', '[]', 0, 'comment', NULL, 'none', NULL, '[]',
         0, 'k', ?, ?, ?, ?, ?)`,
      r.repo,
      r.thread,
      r.kind ?? "activity",
      r.seqAt,
      r.acked === undefined ? 0 : 1,
      r.acked ?? 0,
      r.seq,
      r.seqAt,
    );
}

/** Migrates storage holding v5 rows to the latest schema. */
function migrate(storage: DurableObjectStorage): void {
  storage.sql.exec(
    "CREATE TABLE _fyrden_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
  );
  storage.sql.exec("INSERT INTO _fyrden_schema_version VALUES (1, 5)");
  applyDoMigrations(storage, userSchema);
}

/**
 * Runs v6's statements one by one on storage holding v5 rows (no
 * statement of it holds a `;` but its end), counting the rows they read
 * and wrote.
 */
function migrateCounting(storage: DurableObjectStorage): { read: number; written: number } {
  const v6 = userSchema[5];
  if (!v6) throw new Error("no v6");
  let read = 0;
  let written = 0;
  storage.transactionSync(() => {
    for (const statement of v6.sql.split(";").filter((part) => part.trim() !== "")) {
      const cursor = storage.sql.exec(statement);
      cursor.toArray();
      read += cursor.rowsRead;
      written += cursor.rowsWritten;
    }
  });
  return { read, written };
}

const count = (sql: SqlStorage, query: string, ...bindings: SqlStorageValue[]) =>
  sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${query}`, ...bindings).one().n;

describe("a feed migrated to streams", () => {
  it("keeps its numbers, orders each stream, trims it to its caps with fences, and reads a cursor of before on", async () => {
    const t0 = Date.now() - 60_000;
    const rows: V5Row[] = [];
    // rep_a's pull requests: 600 shown items, every third stored out of order (an earlier time
    // than the one before it), and 600 tombstones; acknowledgements on the newest.
    for (let i = 1; i <= 600; i++)
      rows.push({
        repo: "rep_a",
        thread: `pull/${i}`,
        seq: 2 * i,
        seqAt: t0 + (i % 3 === 0 ? i - 2 : i),
        ...(i > 590 && { acked: 1 }),
      });
    for (let i = 1; i <= 600; i++)
      rows.push({ repo: "rep_a", thread: `pull/${1_000 + i}`, seq: null, seqAt: t0 + i });
    // rep_a's issues and rep_b's pull requests: a few items, odd numbers.
    for (let i = 1; i <= 3; i++) {
      rows.push({ repo: "rep_a", thread: `issue/${i}`, seq: 2 * i - 1, seqAt: t0 + i });
      rows.push({ repo: "rep_b", thread: `pull/${i}`, seq: 1_201 + 2 * i, seqAt: t0 + 700 + i });
    }
    const head = 1_300;
    await runInDurableObject(env.USER.getByName(uniqueId("usr")), async (_: UserDO, state) => {
      const { storage } = state;
      await storage.deleteAll();
      v5(storage.sql, head, 0, rows);
      // Fences of rep_a's pull requests: 150 (more than a stream keeps).
      for (let i = 1; i <= 150; i++)
        storage.sql.exec(
          `INSERT INTO feed_evictions (repo_id, thread_key, kind, thread_epoch, version, event_at)
           VALUES ('rep_a', ?, 'activity', 1, 1, ?)`,
          `pull/${5_000 + i}`,
          t0 - 1_000 + i,
        );
      migrate(storage);
      const { sql } = storage;
      const streams = sql.exec("SELECT * FROM feed_streams ORDER BY repo_id, subject").toArray();
      // rep_a's pull requests trimmed to their caps, the greatest number trimmed their low
      // watermark.
      expect(streams).toEqual([
        {
          repo_id: "rep_a",
          subject: "issue",
          low_watermark: 0,
          items: 3,
          tombstones: 0,
        },
        {
          repo_id: "rep_a",
          subject: "pull",
          low_watermark: 200,
          items: FEED_POLICY.streamItems,
          tombstones: FEED_POLICY.streamTombstones,
        },
        {
          repo_id: "rep_b",
          subject: "pull",
          low_watermark: 0,
          items: 3,
          tombstones: 0,
        },
      ]);
      // The oldest 100 shown items and tombstones went, each leaving a fence; 100 fences kept,
      // the newest (the trimmed ones' events are later than the older fences').
      expect(
        count(sql, "feed_items WHERE repo_id = 'rep_a' AND subject = 'pull' AND feed_seq <= 200"),
      ).toBe(0);
      expect(
        count(sql, "feed_items WHERE thread_key IN ('pull/1001', 'pull/1100', 'pull/1101')"),
      ).toBe(1);
      expect(count(sql, "feed_evictions WHERE repo_id = 'rep_a' AND subject = 'pull'")).toBe(
        FEED_POLICY.streamFences,
      );
      expect(count(sql, "feed_evictions WHERE thread_key LIKE 'pull/5___'")).toBe(0);
      // Numbers and acknowledgements kept; `order_at` the running greatest `seq_at` in the
      // stream's order, so never decreasing.
      const kept = sql
        .exec<{ feed_seq: number; seq_at: number; order_at: number; acked_version: number }>(
          `SELECT feed_seq, seq_at, order_at, acked_version FROM feed_items
           WHERE repo_id = 'rep_a' AND subject = 'pull' AND feed_seq IS NOT NULL ORDER BY feed_seq`,
        )
        .toArray();
      expect(kept.map((r) => r.feed_seq)).toEqual(
        Array.from({ length: 500 }, (_, i) => 202 + 2 * i),
      );
      expect(kept.filter((r) => r.acked_version === 1)).toHaveLength(10);
      for (const [i, r] of kept.entries()) {
        expect(r.order_at).toBe(Math.max(...kept.slice(0, i + 1).map((k) => k.seq_at)));
        expect(r.order_at).toBeGreaterThanOrEqual(r.seq_at);
      }
      expect(kept.some((r) => r.order_at > r.seq_at)).toBe(true);
    });
  });

  it("reads a cursor of before streams on without a gap, and expires one behind a trimmed stream", async () => {
    const t0 = Date.now() - 60_000;
    const name = uniqueId("usr");
    const stub = env.USER.getByName(name);
    await runInDurableObject(stub, async (_: UserDO, state) => {
      await state.storage.deleteAll();
      v5(state.storage.sql, 10, 2, [
        { repo: "rep_a", thread: "pull/1", seq: 3, seqAt: t0 + 3 },
        { repo: "rep_b", thread: "pull/1", seq: 7, seqAt: t0 + 7 },
        { repo: "rep_a", thread: "issue/1", seq: 10, seqAt: t0 + 10 },
      ]);
      state.storage.sql.exec(
        "CREATE TABLE _fyrden_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
      );
      state.storage.sql.exec("INSERT INTO _fyrden_schema_version VALUES (1, 5)");
    });
    // A new instance migrates it.
    await runInDurableObject(stub, (_: UserDO, state) => state.abort("migrate")).catch(() => {});
    const migrated = env.USER.getByName(name);
    const epoch = (await migrated.syncStreams(null, 1, {})).epoch;
    const legacy = (base: number): StreamRead => ({
      credential: "crd_test",
      cursor: { epoch, base },
      after: null,
    });
    // At 5: the two items after it, in every stream; a new item after them.
    await migrated.applyFeed([entry({ repoId: "rep_c", version: 1 })]);
    const page = await migrated.listStreams(legacy(5), 50, {});
    expect(page).toMatchObject({ expired: false, expiredStreams: [] });
    if (page.expired) throw new Error("expired");
    expect(page.items.map((i) => [i.repoId, i.threadKey, i.seq])).toEqual([
      ["rep_b", "pull/1", 7],
      ["rep_a", "issue/1", 10],
      ["rep_c", "pull/1", 11],
    ]);
    // Below the feed's low watermark of then, or past its head: expired.
    expect(await migrated.listStreams(legacy(1), 50, {})).toEqual({ expired: true });
    // Judged by the head the feed had when it migrated (10), not its head now (11): what the
    // caller may not see moves nothing.
    expect(await migrated.listStreams(legacy(11), 50, {})).toEqual({ expired: true });
    // The old reads are refused, never answered with numbers of streams.
    await runInDurableObject(migrated, async (instance: UserDO) => {
      await expect(instance.listFeed()).rejects.toThrow(/streams/);
      await expect(instance.syncFeed()).rejects.toThrow(/streams/);
    });
  });

  it("migrates a large feed in one pass, linear in its rows", async () => {
    // As large as a v5 feed grows in seven days: 5,400 items (over the old cap of 5,000), 20,000
    // tombstones and 1,000 fences.
    const t0 = Date.now() - 60_000;
    const counted = await runInDurableObject(
      env.USER.getByName(uniqueId("usr")),
      async (_: UserDO, state) => {
        const { storage } = state;
        await storage.deleteAll();
        v5(storage.sql, 5_400, 0, []);
        storage.sql.exec(
          `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 25400)
           INSERT INTO feed_items (repo_id, thread_key, kind, number, title, thread_epoch, version,
             state, priority, reasons, silent, action, actor, actor_trust, display_member, members,
             truncated, last_event_key, last_event_at, feed_seq, seq_at)
           SELECT 'rep_' || (i % 20), 'pull/' || i, 'activity', i, 't', 1, 1, 'open', 'P1', '[]', 0,
             'comment', NULL, 'none', NULL, '[]', 0, 'k', ?1 + i,
             CASE WHEN i <= 5400 THEN i END, ?1 + i FROM n`,
          t0,
        );
        storage.sql.exec(
          `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
           INSERT INTO feed_evictions (repo_id, thread_key, kind, thread_epoch, version, event_at)
           SELECT 'rep_' || (i % 20), 'pull/' || (100000 + i), 'activity', 1, 1, ?1 + i FROM n`,
          t0,
        );
        const work = migrateCounting(storage);
        expect(count(storage.sql, "feed_streams")).toBe(20);
        // 20 streams of 270 items (within the cap) and 1,000 tombstones (trimmed to 500).
        expect(count(storage.sql, "feed_items WHERE feed_seq IS NOT NULL")).toBe(5_400);
        expect(count(storage.sql, "feed_items WHERE feed_seq IS NULL")).toBe(20 * 500);
        expect(count(storage.sql, "feed_evictions")).toBe(20 * FEED_POLICY.streamFences);
        return work;
      },
    );
    // A few passes over its 26,400 rows (counted locally: about 22 rows read and 6 written a
    // row; a statement matching rows one by one read 462 million). About 0.2 seconds locally.
    const rows = 26_400;
    expect(counted.read).toBeLessThan(25 * rows);
    expect(counted.written).toBeLessThan(8 * rows);
  });
});

describe("a cursor's snapshot", () => {
  const state = (seq: number) => ({ positions: [["rep_test", "pull", seq] as const], base: null });

  it("is the credential's own, kept once for the same positions, and lasts a day", async () => {
    const stub = env.USER.getByName(uniqueId("usr"));
    await stub.applyFeed([entry({ version: 1 }), entry({ thread: 2, version: 1 })]);
    const { epoch } = await stub.syncStreams(null, 1, {});
    const first = await stub.saveCursor("crd_a", state(1));
    // The same positions again: the same snapshot, nothing written.
    expect(await stub.saveCursor("crd_a", state(1))).toEqual(first);
    const other = await stub.saveCursor("crd_b", state(1));
    expect(other.id).not.toBe(first.id);
    const read = (credential: string, id: string): StreamRead => ({
      credential,
      cursor: { epoch, id },
      after: null,
    });
    const page = await stub.listStreams(read("crd_a", first.id), 50, {});
    expect(page).toMatchObject({ expired: false, items: [{ threadKey: "pull/2" }] });
    // Another credential's: expired, as one of another epoch.
    expect(await stub.listStreams(read("crd_b", first.id), 50, {})).toEqual({ expired: true });
    expect(
      await stub.listStreams(
        { ...read("crd_a", first.id), cursor: { epoch: "x", id: first.id } },
        50,
        {},
      ),
    ).toEqual({ expired: true });
    // Half its lifetime on, the same positions make a new one (a cursor read on is renewed).
    const t0 = Date.now();
    vi.setSystemTime(t0 + FEED_POLICY.cursorTtlMs / 2 + 1);
    const renewed = await stub.saveCursor("crd_a", state(1));
    expect(renewed.id).not.toBe(first.id);
    // Its lifetime on: the first expired, the renewed one still read.
    vi.setSystemTime(t0 + FEED_POLICY.cursorTtlMs);
    expect(await stub.listStreams(read("crd_a", first.id), 50, {})).toEqual({ expired: true });
    expect(await stub.listStreams(read("crd_a", renewed.id), 50, {})).toMatchObject({
      expired: false,
    });
  });

  it("keeps a credential's latest 50, and is deleted by the alarm when it expires", async () => {
    const stub = env.USER.getByName(uniqueId("usr"));
    await stub.applyFeed([entry({ version: 1 })]);
    const { epoch } = await stub.syncStreams(null, 1, {});
    const ids: string[] = [];
    // Each a millisecond after the one before (at the same time, which goes first is the ids').
    for (let seq = 0; seq <= FEED_POLICY.cursorsPerCredential; seq++) {
      vi.setSystemTime(Date.now() + 1);
      ids.push((await stub.saveCursor("crd_a", state(seq))).id);
    }
    await stub.saveCursor("crd_b", state(0));
    const stored = () =>
      runInDurableObject(stub, (_: UserDO, s) =>
        s.storage.sql
          .exec<{ credential: string; n: number }>(
            "SELECT credential, count(*) AS n FROM feed_cursors GROUP BY credential ORDER BY 1",
          )
          .toArray(),
      );
    expect(await stored()).toEqual([
      { credential: "crd_a", n: FEED_POLICY.cursorsPerCredential },
      { credential: "crd_b", n: 1 },
    ]);
    // The oldest went: its cursor expired.
    const read = (id: string): StreamRead => ({
      credential: "crd_a",
      cursor: { epoch, id },
      after: null,
    });
    expect(await stub.listStreams(read(ids[0] as string), 50, {})).toEqual({ expired: true });
    expect(await stub.listStreams(read(ids[1] as string), 50, {})).toMatchObject({
      expired: false,
    });
    // Their lifetime on, the alarm deletes them all, and is set for nothing more of theirs.
    vi.setSystemTime(Date.now() + FEED_POLICY.cursorTtlMs + 1);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stored()).toEqual([]);
    const kinds = await runInDurableObject(stub, (_: UserDO, s) =>
      s.storage.sql.exec<{ kind: string }>("SELECT kind FROM user_schedule").toArray(),
    );
    expect(kinds.map((k) => k.kind)).not.toContain("cursors");
  });

  it("is refused past the positions a snapshot holds", async () => {
    await inFeed((storage) => {
      const { feed } = feedIn(storage);
      const positions = Array.from(
        { length: FEED_POLICY.coverage + 1 },
        (_, i) => [`rep_${i}`, "pull", 1] as const,
      );
      expect(() => feed.saveCursor("crd_a", { positions, base: null })).toThrow(/at most 1000/);
    });
  });
});

describe("a snapshot's coverage", () => {
  it("reads only the streams it has positions in once it has its full count", async () => {
    await inFeed((storage) => {
      const { feed, apply } = feedIn(storage);
      apply([
        entry({ repoId: "rep_covered", version: 1 }),
        entry({ repoId: "rep_covered", thread: 2, version: 1 }),
        entry({ repoId: "rep_uncovered", version: 1 }),
      ]);
      // Positions in the full count of streams (all but one of them have no items).
      const positions = [
        ["rep_covered", "pull", 1] as const,
        ...Array.from(
          { length: FEED_POLICY.coverage - 1 },
          (_, i) => [`rep_x${String(i).padStart(4, "0")}`, "pull", 0] as const,
        ),
      ];
      const { id } = storage.transactionSync(() =>
        feed.saveCursor("crd_a", { positions, base: null }),
      );
      const epoch = (feed.sync(null, 1, {}) as { epoch: string }).epoch;
      const page = feed.read({ credential: "crd_a", cursor: { epoch, id }, after: null }, 50);
      expect(page.expired ? [] : page.items.map((i) => [i.repoId, i.threadKey])).toEqual([
        ["rep_covered", "pull/2"],
      ]);
      // With room, every stream reads.
      const open = feed.read(FROM_START, 50);
      expect(open.expired ? 0 : open.items.length).toBe(3);
    });
  });
});

describe("a feed's alarm, with several kinds due", () => {
  it("runs a step of each due kind before a second of any", async () => {
    const stub = env.USER.getByName(uniqueId("usr"));
    const t0 = Date.now();
    // Retention with more than four steps of backlog (in streams within their caps), and more
    // than a step of expired snapshots.
    await runInDurableObject(stub, (_: UserDO, state) => {
      const { apply } = feedIn(state.storage);
      apply(
        Array.from({ length: 2_500 }, (_, i) =>
          entry({ repoId: `rep_${i % 10}`, thread: i + 1, version: 1, occurredAt: t0 }),
        ),
      );
      state.storage.sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600)
         INSERT INTO feed_cursors (id, credential, hash, state, created_at)
         SELECT printf('%032x', i), 'crd_a', 0, '{}', ?1 FROM n`,
        t0,
      );
      state.storage.sql.exec(
        "INSERT INTO user_schedule (kind, due_at) VALUES ('cursors', ?), ('retain', ?)",
        t0 + FEED_POLICY.cursorTtlMs,
        t0 + FEED_POLICY.retentionMs,
      );
      return state.storage.setAlarm(t0 + FEED_POLICY.cursorTtlMs);
    });
    vi.setSystemTime(t0 + FEED_POLICY.retentionMs + 10_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    // Four steps: two of retention (1,000 items) and two of snapshots (all 600).
    const left = await runInDurableObject(stub, (_: UserDO, state) => ({
      items: count(state.storage.sql, "feed_items"),
      cursors: count(state.storage.sql, "feed_cursors"),
    }));
    expect(left).toEqual({ items: 1_500, cursors: 0 });
  });
});

describe("reading a feed's streams", () => {
  it("reads about a row a stream for a quiet poll, not the items already given", async () => {
    const read = await inFeed((storage) => {
      const { feed, apply } = feedIn(storage);
      // 20 streams of 100 items each.
      apply(
        Array.from({ length: 2_000 }, (_, i) =>
          entry({ repoId: `rep_${i % 20}`, thread: i + 1, version: 1 }),
        ),
      );
      const all = feed.read(FROM_START, 2_000);
      if (all.expired) throw new Error("expired");
      expect(all.items).toHaveLength(2_000);
      // Each stream at the last item of it given.
      const last = new Map(all.items.map((i) => [i.repoId, i.seq]));
      const positions = [...last].map(([repoId, seq]) => [repoId, "pull", seq] as const);
      const { id } = storage.transactionSync(() =>
        feed.saveCursor("crd_a", { positions, base: null }),
      );
      // The feed's SQL, counting the rows each statement read.
      let rows = 0;
      const sql = new Proxy(storage.sql, {
        get(target, prop) {
          if (prop !== "exec") return Reflect.get(target, prop);
          return (query: string, ...bindings: SqlStorageValue[]) => {
            const cursor = target.exec(query, ...bindings);
            const out = cursor.toArray();
            rows += cursor.rowsRead;
            return Object.assign(out[Symbol.iterator](), { toArray: () => out, one: () => out[0] });
          };
        },
      });
      const counted = feedIn({ ...storage, sql } as unknown as DurableObjectStorage).feed;
      const page = counted.read(
        { credential: "crd_a", cursor: { epoch: all.epoch, id }, after: null },
        50,
      );
      expect(page).toMatchObject({ expired: false, items: [], expiredStreams: [] });
      return rows;
    });
    // The snapshot, each stream's row and its seeks: not its 2,000 items.
    expect(read).toBeLessThan(200);
  });
});

describe("an answer's pages", () => {
  it("never pass a change made between them, at the same millisecond or with the clock gone back", async () => {
    await inFeed((storage) => {
      let now = Date.now();
      const { feed, apply } = feedIn(storage, () => now);
      apply([
        entry({ repoId: "rep_b", version: 1 }),
        entry({ repoId: "rep_b", thread: 2, version: 1 }),
      ]);
      const first = feed.read(FROM_START, 1);
      if (first.expired) throw new Error("expired");
      const [last] = first.items;
      if (!last) throw new Error("no item");
      // Two items of another repository written between the pages: at the page's millisecond,
      // then a millisecond earlier.
      apply([entry({ repoId: "rep_a", version: 1 })]);
      now -= 1;
      apply([entry({ repoId: "rep_a", thread: 2, version: 1 })]);
      const next = feed.read({ ...FROM_START, after: { seq: last.seq, cutoff: first.cutoff } }, 50);
      expect(next.expired ? [] : next.items.map((i) => [i.repoId, i.threadKey])).toEqual([
        ["rep_b", "pull/2"],
        ["rep_a", "pull/1"],
        ["rep_a", "pull/2"],
      ]);
      // Their retention clock never goes back.
      const kept = storage.sql
        .exec<{ order_at: number }>(
          "SELECT order_at FROM feed_items WHERE feed_seq IS NOT NULL ORDER BY feed_seq",
        )
        .toArray()
        .map((r) => r.order_at);
      expect(kept).toEqual([...kept].sort((a, b) => a - b));
    });
  });
});

describe("a stream a snapshot is behind", () => {
  it("is found with a seek, its unread items expired and not deleted yet", async () => {
    const t0 = Date.now();
    let now = t0;
    const found = await inFeed((storage) => {
      const { feed, apply } = feedIn(storage, () => now);
      // 20 streams of 25 items each; everything expires.
      apply(
        Array.from({ length: 500 }, (_, i) =>
          entry({ repoId: `rep_${i % 20}`, thread: i + 1, version: 1, occurredAt: t0 }),
        ),
      );
      now = t0 + FEED_POLICY.retentionMs + 10_000;
      const positions = Array.from({ length: 20 }, (_, i) => [`rep_${i}`, "pull", 0] as const);
      const { id } = storage.transactionSync(() =>
        feed.saveCursor("crd_a", { positions, base: null }),
      );
      let rows = 0;
      const sql = new Proxy(storage.sql, {
        get(target, prop) {
          if (prop !== "exec") return Reflect.get(target, prop);
          return (query: string, ...bindings: SqlStorageValue[]) => {
            const cursor = target.exec(query, ...bindings);
            const out = cursor.toArray();
            rows += cursor.rowsRead;
            return Object.assign(out[Symbol.iterator](), { toArray: () => out, one: () => out[0] });
          };
        },
      });
      const counted = new Feed(sql as SqlStorage, () => now);
      const epoch = feed.sync(null, 1, {}).epoch;
      const page = counted.read({ credential: "crd_a", cursor: { epoch, id }, after: null }, 50);
      if (page.expired) throw new Error("expired");
      return { behind: page.expiredStreams, rows };
    });
    expect(found.behind).toHaveLength(20);
    // A seek a stream for each check, and one pass over the expired items not deleted yet (the
    // retention alarm, due when they expired, deletes them): not a pass a stream.
    expect(found.rows).toBeLessThan(500 + 200);
  });
});

describe("a sync's cursor", () => {
  it("has the streams it gave items of at their heads as of its first page, and no others", async () => {
    await inFeed((storage) => {
      const { feed, apply } = feedIn(storage);
      apply([
        entry({ repoId: "rep_a", kind: "review_requested", version: 1, priority: "P0" }),
        entry({ repoId: "rep_a", thread: 2, kind: "approved", version: 1, priority: "P0" }),
        entry({ repoId: "rep_b", kind: "approved", version: 1, priority: "P0" }),
      ]);
      // Resolved since: not synced, and rep_b has nothing a sync shows.
      apply([
        entry({
          repoId: "rep_a",
          thread: 2,
          kind: "approved",
          version: 2,
          priority: "P0",
          state: "resolved",
        }),
        entry({ repoId: "rep_b", kind: "approved", version: 2, priority: "P0", state: "resolved" }),
      ]);
      const page = feed.sync(null, 50, {});
      expect(page.items.map((i) => [i.repoId, i.threadKey])).toEqual([["rep_a", "pull/1"]]);
      // A change after the sync began: after its cursor.
      apply([entry({ repoId: "rep_a", thread: 3, version: 1 })]);
      const { id } = storage.transactionSync(() =>
        feed.syncCursor("crd_a", [{ repoId: "rep_a", subject: "pull" }], page.bound),
      );
      const state = storage.sql
        .exec<{ state: string }>("SELECT state FROM feed_cursors WHERE id = ?", id)
        .one().state;
      // rep_a's head then (the resolved approval's change, 4), not the change after (6).
      expect(JSON.parse(state)).toEqual({ positions: [["rep_a", "pull", 4]], base: null });
      const next = feed.read(
        { credential: "crd_a", cursor: { epoch: page.epoch, id }, after: null },
        50,
      );
      expect(next.expired ? [] : next.items.map((i) => [i.repoId, i.threadKey])).toEqual([
        // rep_b's resolved item, of a stream the sync gave nothing of, and rep_a's new one.
        ["rep_b", "pull/1"],
        ["rep_a", "pull/3"],
      ]);
    });
  });
});

describe("keeping a credential's snapshots", () => {
  it("never drops the one it keeps, made at the same time as the others or earlier", async () => {
    await inFeed((storage) => {
      let now = Date.now();
      const { feed } = feedIn(storage, () => now);
      const keep = (seq: number) =>
        storage.transactionSync(() =>
          feed.saveCursor("crd_a", { positions: [["rep_a", "pull", seq]], base: null }),
        );
      for (let seq = 0; seq < FEED_POLICY.cursorsPerCredential; seq++) keep(seq);
      const ids = () =>
        storage.sql
          .exec<{ id: string }>("SELECT id FROM feed_cursors WHERE credential = 'crd_a'")
          .toArray()
          .map((r) => r.id);
      // At the same millisecond as the others, then with the clock gone back: each kept.
      const same = keep(1_000);
      expect(ids()).toHaveLength(FEED_POLICY.cursorsPerCredential);
      expect(ids()).toContain(same.id);
      now -= 1_000;
      const earlier = keep(1_001);
      expect(ids()).toHaveLength(FEED_POLICY.cursorsPerCredential);
      expect(ids()).toContain(earlier.id);
    });
  });
});

describe("an item's retention clock", () => {
  it("is moved by nothing of another stream, with the clock gone back too", async () => {
    const t0 = Date.now();
    const clocks = await Promise.all(
      [false, true].map((busy) =>
        inFeed((storage) => {
          let now = t0;
          const { apply, rows } = feedIn(storage, () => now);
          if (busy) apply([entry({ repoId: "rep_hidden", version: 1 })]);
          now = t0 - 1_000;
          apply([entry({ repoId: "rep_a", version: 1 })]);
          return rows("repo_id = 'rep_a'")[0]?.order_at;
        }),
      ),
    );
    expect(clocks).toEqual([t0 - 1_000, t0 - 1_000]);
  });

  it("schedules retention by the item that expires first, whatever the order of their numbers", async () => {
    await inFeed((storage) => {
      const t0 = Date.now();
      let now = t0 + 2 * DAY;
      const { feed, apply } = feedIn(storage, () => now);
      // Numbered 1, 2, 3, timed two days, one day and none after t0 (the clock gone back).
      apply([entry({ repoId: "rep_a", version: 1 })]);
      now = t0 + DAY;
      apply([entry({ repoId: "rep_b", version: 1 })]);
      now = t0;
      apply([entry({ repoId: "rep_c", version: 1 })]);
      expect(feed.nextRetention()).toBe(t0 + FEED_POLICY.retentionMs);
      now = t0 + FEED_POLICY.retentionMs + 1;
      storage.transactionSync(() => feed.retainStep());
      expect(feed.nextRetention()).toBe(t0 + DAY + FEED_POLICY.retentionMs);
    });
  });

  it("deletes expired items reading about them, not the live ones after them", async () => {
    const rows = await inFeed((storage) => {
      const t0 = Date.now();
      let now = t0;
      const { apply } = feedIn(storage, () => now);
      apply([entry({ repoId: "rep_old", version: 1 })]);
      now = t0 + DAY;
      apply(
        Array.from({ length: 2_000 }, (_, i) =>
          entry({ repoId: `rep_${i % 10}`, thread: i + 1, version: 1 }),
        ),
      );
      now = t0 + FEED_POLICY.retentionMs + 1;
      let read = 0;
      const sql = new Proxy(storage.sql, {
        get(target, prop) {
          if (prop !== "exec") return Reflect.get(target, prop);
          return (query: string, ...bindings: SqlStorageValue[]) => {
            const cursor = target.exec(query, ...bindings);
            const out = cursor.toArray();
            read += cursor.rowsRead;
            return Object.assign(out[Symbol.iterator](), { toArray: () => out, one: () => out[0] });
          };
        },
      });
      const counted = new Feed(sql as SqlStorage, () => now);
      expect(storage.transactionSync(() => counted.retainStep())).toBe(false);
      expect(count(storage.sql, "feed_items WHERE repo_id = 'rep_old'")).toBe(0);
      return read;
    });
    // The one expired item, its stream and the next one's index entry: not the 2,000 live.
    expect(rows).toBeLessThan(50);
  });
});

describe("a snapshot of before streams", () => {
  it("is expired once the feed has more streams than a snapshot can follow", async () => {
    await inFeed((storage) => {
      const { feed, apply } = feedIn(storage);
      apply([entry({ version: 1 })]);
      const { id } = storage.transactionSync(() =>
        feed.saveCursor("crd_a", { positions: [], base: 0 }),
      );
      const epoch = feed.sync(null, 1, {}).epoch;
      const read = () => feed.read({ credential: "crd_a", cursor: { epoch, id }, after: null }, 50);
      expect(read()).toMatchObject({ expired: false });
      storage.sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
         INSERT INTO feed_streams (repo_id, subject, low_watermark, items, tombstones)
         SELECT 'rep_many' || i, 'pull', 0, 0, 0 FROM n`,
        FEED_POLICY.coverage,
      );
      expect(read()).toEqual({ expired: true });
    });
  });
});
