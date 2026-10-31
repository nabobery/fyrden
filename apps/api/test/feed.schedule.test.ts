// A feed's deferred work: retention and a retired feed's cleanup run from
// its alarm in bounded steps (`FEED_POLICY.sliceRows` rows each), resumed
// from storage; what retention has not reached yet is gone to readers and
// writers already; and the alarm follows the earliest scheduled row.

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { applyDoMigrations } from "@fyrden/adapters-cloudflare/migrations";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it, vi } from "vitest";
import { userSchema } from "../src/do/schema/user.js";
import type { UserDO } from "../src/do/UserDO.js";
import { FEED_POLICY, Feed, MAX_GONE_THREADS } from "../src/do/user/feed.js";
import { GONE_IDENTITIES } from "../src/do/user/inbox.js";
import userV4 from "./fixtures/do-schemas/UserDO/v4.sql?raw";
import {
  DAY,
  type EntryInit,
  entry,
  FROM_START,
  feedIn,
  inFeed,
  shownCount,
} from "./helpers/feed.js";

/**
 * `n` items of threads `from` on, 400 a repository (within a stream's cap):
 * `rep_test`'s first, then `rep_test1`, `rep_test2`...
 */
const many = (n: number, from = 1, at?: number, init: Partial<EntryInit> = {}) =>
  Array.from({ length: n }, (_, i) =>
    entry({
      thread: from + i,
      version: 1,
      repoId: i < 400 ? "rep_test" : `rep_test${Math.floor(i / 400)}`,
      ...(at !== undefined && { occurredAt: at }),
      ...init,
    }),
  );

describe("retention, a step at a time", () => {
  it("deletes a backlog in bounded steps, the streams' low watermarks rising with each", async () => {
    const t0 = Date.now();
    let now = t0;
    await inFeed((storage) => {
      const { feed, apply } = feedIn(storage, () => now);
      apply(many(1_200, 1, t0));
      now = t0 + FEED_POLICY.retentionMs + 10_000;
      const counts = () =>
        storage.sql
          .exec<{ n: number; items: number; low: number }>(
            `SELECT (SELECT count(*) FROM feed_items) AS n, sum(items) AS items,
               sum(low_watermark) AS low
             FROM feed_streams`,
          )
          .one();
      const steps: { n: number; items: number; low: number }[] = [];
      while (storage.transactionSync(() => feed.retainStep())) steps.push(counts());
      steps.push(counts());
      expect(steps.map((s) => s.n)).toEqual([700, 200, 0]);
      expect(steps.map((s) => s.items)).toEqual([700, 200, 0]);
      // Each stream's watermark at the greatest of its sequence numbers deleted: all of them
      // in the end (400, 800 and 1,200).
      expect(steps.at(-1)?.low).toBe(400 + 800 + 1_200);
      expect(steps.map((s) => s.low)).toEqual([...steps.map((s) => s.low)].sort((a, b) => a - b));
    });
  });

  it("reads about what it deletes, however large a backlog sharing one time", async () => {
    /** Rows one step reads over a backlog of `n` shown items and `n` tombstones, all of one time. */
    const stepReads = (n: number) =>
      inFeed((storage) => {
        const t0 = Date.now();
        let now = t0;
        let read = 0;
        // The feed's SQL, counting the rows each statement read.
        const sql = new Proxy(storage.sql, {
          get(target, prop) {
            if (prop !== "exec") return Reflect.get(target, prop);
            return (query: string, ...bindings: SqlStorageValue[]) => {
              const cursor = target.exec(query, ...bindings);
              const rows = cursor.toArray();
              read += cursor.rowsRead;
              return Object.assign(rows[Symbol.iterator](), {
                toArray: () => rows,
                one: () => rows[0],
              });
            };
          },
        });
        const { apply } = feedIn(storage, () => now);
        apply(many(n, 1, t0));
        apply(many(n, 100_000, t0, { kind: "approved", state: "resolved" }));
        now = t0 + FEED_POLICY.retentionMs + 10_000;
        const feed = new Feed(sql as SqlStorage, () => now);
        expect(storage.transactionSync(() => feed.retainStep())).toBe(true);
        return read;
      });
    const small = await stepReads(1_000);
    const large = await stepReads(4_000);
    // About its 500 rows (each read through the index and its row, its index entries kept):
    // the same for four times the backlog.
    expect(small).toBeLessThan(6 * FEED_POLICY.sliceRows);
    expect(large).toBeLessThanOrEqual(small * 1.05);
  });

  it("hides expired items from list and sync before their step deletes them", async () => {
    const stub = env.USER.getByName(uniqueId("usr"));
    const t0 = Date.now();
    // An activity item and an open P0 item (which sync shows whatever its age), then a third.
    await stub.applyFeed([
      entry({ thread: 1, version: 1 }),
      entry({ thread: 2, version: 1, kind: "review_requested", priority: "P0" }),
    ]);
    const stored = await runInDurableObject(
      stub,
      (_: UserDO, state) =>
        state.storage.sql.exec<{ at: number }>("SELECT max(order_at) AS at FROM feed_items").one()
          .at,
    );
    vi.setSystemTime(t0 + 3 * DAY);
    await stub.applyFeed([entry({ thread: 3, version: 1 })]);
    vi.setSystemTime(stored + FEED_POLICY.retentionMs + 1);
    // The alarm has not run: both expired items are still stored, and shown to no one.
    const page = await stub.listStreams(FROM_START, 50, {});
    expect(page.expired ? [] : page.items.map((i) => i.threadKey)).toEqual(["pull/3"]);
    const sync = await stub.syncStreams(null, 50, {});
    expect(sync.items.map((i) => i.threadKey)).toEqual(["pull/3"]);
    const kept = await runInDurableObject(
      stub,
      (_: UserDO, state) =>
        state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM feed_items").one().n,
    );
    expect(kept).toBe(3);
  });

  it("lets no acknowledgement bring an expired item back", async () => {
    const t0 = Date.now();
    let now = t0;
    await inFeed((storage) => {
      const { feed, apply, rows } = feedIn(storage, () => now);
      apply([entry({ thread: 1, version: 1, occurredAt: t0 })]);
      const id = { repoId: "rep_test", threadKey: "pull/1", kind: "activity" } as const;
      now = t0 + FEED_POLICY.retentionMs + 10_000;
      expect(storage.transactionSync(() => feed.ack(id, { epoch: 1, version: 1 }))).toEqual({
        status: "missing",
      });
      expect(rows()).toEqual([]);
      expect(storage.sql.exec("SELECT items, low_watermark FROM feed_streams").one()).toEqual({
        items: 0,
        low_watermark: 1,
      });
    });
  });

  it("never merges a new entry into an expired item or tombstone still stored", async () => {
    const t0 = Date.now();
    let now = t0;
    await inFeed((storage) => {
      const { feed, apply, rows } = feedIn(storage, () => now);
      const p0 = { kind: "review_requested", priority: "P0" } as const;
      // A shown activity item (acknowledged) and a tombstone, both of t0.
      apply([entry({ thread: 1, version: 1, occurredAt: t0 })]);
      storage.transactionSync(() =>
        feed.ack(
          { repoId: "rep_test", threadKey: "pull/1", kind: "activity" },
          { epoch: 1, version: 1 },
        ),
      );
      apply([entry({ thread: 2, version: 5, ...p0, state: "resolved", occurredAt: t0 })]);
      expect(rows("feed_seq IS NULL")).toHaveLength(1);
      now = t0 + FEED_POLICY.retentionMs + 10_000;
      // Expired, not deleted yet: both still stored when the entries come.
      expect(rows()).toHaveLength(2);
      apply([
        entry({ thread: 1, version: 2, occurredAt: now }),
        entry({ thread: 1, version: 3, occurredAt: now }),
        entry({ thread: 2, version: 2, ...p0, occurredAt: now }),
      ]);
      const [activity, request] = [
        rows("thread_key = 'pull/1'")[0],
        rows("thread_key = 'pull/2'")[0],
      ];
      // Afresh: the old member and acknowledgement gone, the tombstone's resolution not kept.
      expect(JSON.parse(String(activity?.members)).map((m: { id: string }) => m.id)).toEqual([
        "3",
        "2",
      ]);
      expect(activity).toMatchObject({ acked_version: 0 });
      // Its newer resolved version expired with it: the lower version that came now stands.
      expect(request).toMatchObject({ state: "open", version: 2 });
      expect(shownCount(storage)).toBe(2);
    });
  });
});

describe("a feed's alarm", () => {
  /** The schedule's rows and the alarm. */
  const schedule = (stub: DurableObjectStub<UserDO>) =>
    runInDurableObject(stub, async (_: UserDO, state) => ({
      rows: state.storage.sql
        .exec<{ kind: string; due_at: number }>("SELECT kind, due_at FROM user_schedule")
        .toArray(),
      alarm: await state.storage.getAlarm(),
    }));

  it("runs a backlog over several alarms, each within its steps, until nothing is left", async () => {
    const stub = env.USER.getByName(uniqueId("usr"));
    const t0 = Date.now();
    await runInDurableObject(stub, (_: UserDO, state) => {
      const { apply } = feedIn(state.storage);
      apply(many(2_400, 1, t0));
    });
    await stub.applyFeed([entry({ thread: 1, version: 2 })]);
    const stored = await runInDurableObject(
      stub,
      (_: UserDO, state) =>
        state.storage.sql.exec<{ at: number }>("SELECT max(order_at) AS at FROM feed_items").one()
          .at,
    );
    vi.setSystemTime(stored + FEED_POLICY.retentionMs + 1);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    // Four steps of 500: 400 left, due at once.
    const left = await runInDurableObject(
      stub,
      (_: UserDO, state) =>
        state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM feed_items").one().n,
    );
    expect(left).toBe(400);
    const after = await schedule(stub);
    expect(after.rows).toEqual([{ kind: "retain", due_at: expect.any(Number) }]);
    expect(after.alarm).toBeLessThanOrEqual(Date.now());
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await schedule(stub)).toEqual({ rows: [], alarm: null });
  });

  it("is set earlier when a call needs retention sooner, and never later than its earliest row", async () => {
    const stub = env.USER.getByName(uniqueId("usr"));
    await stub.applyFeed([entry({ thread: 1, version: 1 })]);
    // When the item was stored (the clock may move during the call).
    const stored = await runInDurableObject(
      stub,
      (_: UserDO, state) =>
        state.storage.sql.exec<{ at: number }>("SELECT min(order_at) AS at FROM feed_items").one()
          .at,
    );
    const due = stored + FEED_POLICY.retentionMs;
    expect((await schedule(stub)).alarm).toBe(due);
    // A later alarm than the row (as one left by an earlier version): the next call repairs it.
    await runInDurableObject(stub, (_: UserDO, state) =>
      state.storage.setAlarm(due + FEED_POLICY.retentionMs),
    );
    await stub.applyFeed([entry({ thread: 2, version: 1 })]);
    expect(await schedule(stub)).toEqual({ rows: [{ kind: "retain", due_at: due }], alarm: due });
  });

  it("ends a cold run armed for what is left, not for what it just did", async () => {
    const name = uniqueId("usr");
    const stub = env.USER.getByName(name);
    const t0 = Date.now();
    await stub.applyFeed([entry({ thread: 1, version: 1 })]);
    vi.setSystemTime(t0 + 3 * DAY);
    await stub.applyFeed([entry({ thread: 2, version: 1 })]);
    const later = await runInDurableObject(
      stub,
      (_: UserDO, state) =>
        state.storage.sql.exec<{ at: number }>("SELECT max(order_at) AS at FROM feed_items").one()
          .at,
    );
    const earlier = await runInDurableObject(
      stub,
      (_: UserDO, state) =>
        state.storage.sql.exec<{ at: number }>("SELECT min(order_at) AS at FROM feed_items").one()
          .at,
    );
    // A cold instance whose first call is its alarm, once the first item expired.
    await runInDurableObject(stub, (_: UserDO, state) => state.abort("cold")).catch(() => {});
    vi.setSystemTime(earlier + FEED_POLICY.retentionMs + 1);
    const cold = env.USER.getByName(name);
    expect(await runDurableObjectAlarm(cold)).toBe(true);
    expect((await schedule(cold)).alarm).toBe(later + FEED_POLICY.retentionMs);
  });

  it("tries a failing step again a minute on, and still runs the other kinds", async () => {
    const stub = env.USER.getByName(uniqueId("usr"));
    await stub.applyFeed([entry({ thread: 1, version: 1 })]);
    await stub.retire();
    // The retire step fails once (its table made unreadable), retention stays dropped.
    await runInDurableObject(stub, (_: UserDO, state) => {
      state.storage.sql.exec("ALTER TABLE purge_marks RENAME TO purge_marks_away");
    });
    await runDurableObjectAlarm(stub);
    const failed = await schedule(stub);
    expect(failed.rows).toEqual([{ kind: "retire", due_at: expect.any(Number) }]);
    expect(failed.rows[0]?.due_at).toBeGreaterThan(Date.now());
    await runInDurableObject(stub, (_: UserDO, state) => {
      state.storage.sql.exec("ALTER TABLE purge_marks_away RENAME TO purge_marks");
    });
    vi.setSystemTime(Date.now() + 61_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await schedule(stub)).toEqual({ rows: [], alarm: null });
  });
});

describe("forgetting gone threads", () => {
  it("takes at most a bounded number a call, so a call deletes a bounded number of rows", async () => {
    const stub = env.USER.getByName(uniqueId("usr"));
    const threads = Array.from({ length: MAX_GONE_THREADS + 1 }, (_, i) => ({
      repoId: "rep_test",
      threadKey: `pull/${i + 1}`,
      epoch: 1,
    }));
    // Asked inside the object: a refusal across RPC is also reported as unhandled there.
    await runInDurableObject(stub, async (instance: UserDO) => {
      await expect(instance.forgetGoneThreads(threads)).rejects.toThrow(
        new RegExp(`at most ${MAX_GONE_THREADS}`),
      );
      expect(await instance.forgetGoneThreads(threads.slice(0, MAX_GONE_THREADS))).toEqual({
        deleted: 0,
      });
    });
    // Seven kinds a thread, and its inbox threads: a call deletes fewer rows than a step.
    expect(MAX_GONE_THREADS * (7 + GONE_IDENTITIES)).toBeLessThan(FEED_POLICY.sliceRows);
  });
});

describe("a feed object migrated to the schedule", () => {
  /** The seven days the migration was written with (frozen there, whatever the policy says now). */
  const WEEK = 604_800_000;

  /** An object at v4 holding `fill`'s rows, migrated: its schedule's rows. */
  async function migrated(fill: (sql: SqlStorage) => void) {
    return runInDurableObject(env.USER.getByName(uniqueId("usr")), async (_: UserDO, state) => {
      await state.storage.deleteAll();
      state.storage.sql.exec(userV4);
      state.storage.sql.exec(
        "INSERT INTO feed_meta (id, epoch, epoch_gen, head_seq, low_watermark, items) VALUES (1, 'e', 0, 0, 0, 0)",
      );
      fill(state.storage.sql);
      state.storage.sql.exec(
        "CREATE TABLE _fyrden_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
      );
      state.storage.sql.exec("INSERT INTO _fyrden_schema_version VALUES (1, 4)");
      applyDoMigrations(state.storage, userSchema);
      return state.storage.sql
        .exec<{ kind: string; due_at: number }>("SELECT kind, due_at FROM user_schedule")
        .toArray();
    });
  }
  const item = (sql: SqlStorage, n: number, seqAt: number, seq: number | null) =>
    sql.exec(
      `INSERT INTO feed_items (repo_id, thread_key, kind, number, title, thread_epoch, version,
         state, priority, reasons, silent, action, actor, actor_trust, display_member, members,
         truncated, last_event_key, last_event_at, feed_seq, seq_at)
       VALUES ('rep_m', ?, 'activity', ?, 't', 1, 1, 'open', 'P1', '[]', 0, 'comment', NULL,
         'none', NULL, '[]', 0, 'k', ?, ?, ?)`,
      `pull/${n}`,
      n,
      seqAt,
      seq,
      seqAt,
    );

  it("schedules retention by the oldest item, tombstone, mark or fence, a week on", async () => {
    expect(await migrated(() => {})).toEqual([]);
    expect(await migrated((sql) => item(sql, 1, 1_000, 1))).toEqual([
      { kind: "retain", due_at: 1_000 + WEEK },
    ]);
    expect(await migrated((sql) => item(sql, 1, 2_000, null))).toEqual([
      { kind: "retain", due_at: 2_000 + WEEK },
    ]);
    expect(
      await migrated((sql) =>
        sql.exec(
          "INSERT INTO purge_marks (repo_id, until_at, account_id, epoch_gen, acl_version) VALUES ('rep_m', 3000, '', 0, 0)",
        ),
      ),
    ).toEqual([{ kind: "retain", due_at: 3_000 + WEEK }]);
    expect(
      await migrated((sql) =>
        sql.exec(
          "INSERT INTO feed_evictions (repo_id, thread_key, kind, thread_epoch, version, event_at) VALUES ('rep_m', 'pull/1', 'activity', 1, 1, 4000)",
        ),
      ),
    ).toEqual([{ kind: "retain", due_at: 4_000 + WEEK }]);
  });

  it("is woken by its first call after migrating, its earlier alarm gone", async () => {
    const name = uniqueId("usr");
    const stub = env.USER.getByName(name);
    // Stored now: due a week on (an alarm due in the past would fire on its own here).
    const old = Date.now();
    await runInDurableObject(stub, async (_: UserDO, state) => {
      await state.storage.deleteAll();
      state.storage.sql.exec(userV4);
      state.storage.sql.exec(
        "INSERT INTO feed_meta (id, epoch, epoch_gen, head_seq, low_watermark, items) VALUES (1, 'e', 0, 1, 0, 1)",
      );
      item(state.storage.sql, 1, old, 1);
      state.storage.sql.exec(
        "CREATE TABLE _fyrden_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
      );
      state.storage.sql.exec("INSERT INTO _fyrden_schema_version VALUES (1, 4)");
      // Its retention alarm was given up on (Cloudflare's retries spent): none is set.
      await state.storage.deleteAlarm();
    });
    // A new instance migrates; its first call (a read) sets the alarm by the seeded row.
    await runInDurableObject(stub, (_: UserDO, state) => state.abort("migrate")).catch(() => {});
    const migratedStub = env.USER.getByName(name);
    await migratedStub.listStreams(FROM_START, 10, {});
    const alarm = await runInDurableObject(migratedStub, (_: UserDO, state) =>
      state.storage.getAlarm(),
    );
    expect(alarm).toBe(old + WEEK);
    vi.setSystemTime(old + WEEK + 1);
    expect(await runDurableObjectAlarm(migratedStub)).toBe(true);
    const left = await runInDurableObject(
      migratedStub,
      (_: UserDO, state) =>
        state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM feed_items").one().n,
    );
    expect(left).toBe(0);
  });

  it("takes a cold call, trimmed to its streams' caps when migrated over them", async () => {
    const name = uniqueId("usr");
    const stub = env.USER.getByName(name);
    const now = Date.now();
    const over = 5_010;
    await runInDurableObject(stub, async (_: UserDO, state) => {
      await state.storage.deleteAll();
      state.storage.sql.exec(userV4);
      state.storage.sql.exec(
        "INSERT INTO feed_meta (id, epoch, epoch_gen, head_seq, low_watermark, items) VALUES (1, 'e', 0, ?, 0, ?)",
        over,
        over,
      );
      state.storage.sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
         INSERT INTO feed_items (repo_id, thread_key, kind, number, title, thread_epoch, version,
           state, priority, reasons, silent, action, actor, actor_trust, display_member, members,
           truncated, last_event_key, last_event_at, feed_seq, seq_at)
         SELECT 'rep_m', 'pull/' || i, 'activity', i, 't', 1, 1, 'open', 'P1', '[]', 0, 'comment',
           NULL, 'none', NULL, '[]', 0, 'k', ?1, i, ?1 FROM n`,
        now,
        over,
      );
      state.storage.sql.exec(
        "CREATE TABLE _fyrden_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
      );
      state.storage.sql.exec("INSERT INTO _fyrden_schema_version VALUES (1, 4)");
      await state.storage.deleteAlarm();
    });
    await runInDurableObject(stub, (_: UserDO, state) => state.abort("migrate")).catch(() => {});
    const migratedStub = env.USER.getByName(name);
    // Seeded due at once (0): the cold read still answers, the alarm set to now.
    const page = await migratedStub.listStreams(FROM_START, 1, {});
    expect(page.expired).toBe(false);
    expect(await runDurableObjectAlarm(migratedStub)).toBe(true);
    const n = await runInDurableObject(
      migratedStub,
      (_: UserDO, state) =>
        state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM feed_items").one().n,
    );
    expect(n).toBe(FEED_POLICY.streamItems);
  });

  it("schedules it at once past the cap, and not at all for a retired feed", async () => {
    expect(
      await migrated((sql) => {
        item(sql, 1, 5_000, 1);
        sql.exec("UPDATE feed_meta SET items = 5001");
      }),
    ).toEqual([{ kind: "retain", due_at: 0 }]);
    expect(
      await migrated((sql) => {
        item(sql, 1, 5_000, 1);
        sql.exec("INSERT INTO feed_retired (id, at) VALUES (1, 1)");
      }),
    ).toEqual([]);
  });
});
