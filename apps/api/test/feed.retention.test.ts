// The activity feed's retention: items and tombstones past 7 days are
// deleted in an alarm, a stream's past its caps as it is written, and its
// low watermark expires positions in it below what went.

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it, vi } from "vitest";
import type { UserDO } from "../src/do/UserDO.js";
import { FEED_POLICY } from "../src/do/user/feed.js";
import { DAY, entry, FROM_START, feedIn, ids, inFeed } from "./helpers/feed.js";

/** Retention run to its end, a step at a time, each step its own transaction. */
function retainAll(storage: DurableObjectStorage, feed: { retainStep(): boolean }): void {
  while (storage.transactionSync(() => feed.retainStep()));
}

describe("retention", () => {
  it("deletes items past 7 days in an alarm, and expires positions below the stream's low watermark", async () => {
    const stub = env.USER.getByName(uniqueId("usr"));
    const t0 = Date.now();
    await stub.applyFeed([entry({ thread: 1, version: 1 })]);
    const alarm = await runInDurableObject(stub, (_: UserDO, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThanOrEqual(t0 + FEED_POLICY.retentionMs);
    const before = await stub.listStreams(FROM_START, 50, {});
    if (before.expired) throw new Error("expired");
    vi.setSystemTime(t0 + 3 * DAY);
    await stub.applyFeed([entry({ thread: 2, version: 1 })]);
    vi.setSystemTime(t0 + FEED_POLICY.retentionMs + 1_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const after = await stub.listStreams(FROM_START, 50, {});
    expect(after).toMatchObject({ items: [{ threadKey: "pull/2" }] });
    // A position before what retention deleted has missed it; one after it has not.
    const at = async (seq: number) => {
      const { id } = await stub.saveCursor("crd_test", {
        positions: [["rep_test", "pull", seq]],
        base: null,
      });
      return stub.listStreams(
        { credential: "crd_test", cursor: { epoch: before.epoch, id }, after: null },
        50,
        {},
      );
    };
    const stream = { repoId: "rep_test", subject: "pull" };
    expect(await at(0)).toMatchObject({ expired: false, expiredStreams: [stream] });
    expect(await at(1)).toMatchObject({ expired: false, expiredStreams: [] });
    // So is a cursor of before streams at the start (every stream at 0).
    const legacy = {
      credential: "crd_test",
      cursor: { epoch: before.epoch, base: 0 },
      after: null,
    };
    expect(await stub.listStreams(legacy, 50, {})).toMatchObject({ expiredStreams: [stream] });
    // Retention is next due when the remaining item expires (the snapshots kept above expire
    // sooner: the alarm is theirs first).
    const next = await runInDurableObject(stub, (_: UserDO, state) =>
      state.storage.sql
        .exec<{ kind: string; due_at: number }>(
          "SELECT kind, due_at FROM user_schedule ORDER BY kind",
        )
        .toArray(),
    );
    expect(next).toEqual([
      { kind: "cursors", due_at: expect.any(Number) },
      { kind: "retain", due_at: expect.any(Number) },
    ]);
    expect(next[1]?.due_at).toBeGreaterThanOrEqual(t0 + 3 * DAY + FEED_POLICY.retentionMs);
    expect(next[0]?.due_at).toBeLessThan(next[1]?.due_at ?? 0);
  });

  it("deletes tombstones on the same clock", async () => {
    const stub = env.USER.getByName(uniqueId("usr"));
    const t0 = Date.now();
    await stub.applyFeed([entry({ kind: "approved", version: 2, state: "resolved" })]);
    const tombstones = () =>
      runInDurableObject(stub, (_: UserDO, state) =>
        state.storage.sql.exec("SELECT version FROM feed_items WHERE feed_seq IS NULL").toArray(),
      );
    expect(await tombstones()).toEqual([{ version: 2 }]);
    const alarm = await runInDurableObject(stub, (_: UserDO, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThanOrEqual(t0 + FEED_POLICY.retentionMs);
    vi.setSystemTime(t0 + FEED_POLICY.retentionMs + 1_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await tombstones()).toEqual([]);
    // Nothing shown was deleted: cursors stay good.
    const { epoch } = await stub.syncStreams(null, 1, {});
    expect(
      await stub.listStreams(
        { credential: "crd_test", cursor: { epoch, base: 0 }, after: null },
        50,
        {},
      ),
    ).toMatchObject({ expired: false, expiredStreams: [], items: [] });
    expect(await runInDurableObject(stub, (_: UserDO, state) => state.storage.getAlarm())).toBe(
      null,
    );
  });

  it("keeps a stream within its cap as it is written, the items changed longest ago first, and no other's", async () => {
    await inFeed((storage) => {
      const { apply, rows } = feedIn(storage);
      apply([entry({ repoId: "rep_other", version: 1 })]);
      const count = FEED_POLICY.streamItems + 3;
      apply(Array.from({ length: count }, (_, i) => entry({ thread: i + 1, version: 1 })));
      const stream = (repo: string) =>
        storage.sql
          .exec("SELECT items, low_watermark FROM feed_streams WHERE repo_id = ?", repo)
          .one();
      // Threads 1-3 went (numbers 2-4: the other repository's item took 1), as the stream passed
      // its cap, each fenced; the other repository's item stays, its stream untouched.
      expect(stream("rep_test")).toEqual({ items: FEED_POLICY.streamItems, low_watermark: 4 });
      expect(rows("repo_id = 'rep_test'")).toHaveLength(FEED_POLICY.streamItems);
      expect(rows("repo_id = 'rep_test' AND thread_key IN ('pull/1', 'pull/2', 'pull/3')")).toEqual(
        [],
      );
      expect(
        storage.sql.exec("SELECT thread_key FROM feed_evictions ORDER BY thread_key").toArray(),
      ).toEqual([{ thread_key: "pull/1" }, { thread_key: "pull/2" }, { thread_key: "pull/3" }]);
      expect(stream("rep_other")).toEqual({ items: 1, low_watermark: 0 });
      expect(rows("repo_id = 'rep_other'")).toHaveLength(1);
    });
  });

  it("keeps a stream's tombstones within their cap, fenced", async () => {
    await inFeed((storage) => {
      const { apply, rows } = feedIn(storage);
      const count = FEED_POLICY.streamTombstones + 2;
      apply(
        Array.from({ length: count }, (_, i) =>
          entry({ kind: "approved", thread: i + 1, version: 2, state: "resolved" }),
        ),
      );
      expect(rows("feed_seq IS NULL")).toHaveLength(FEED_POLICY.streamTombstones);
      expect(storage.sql.exec("SELECT items, tombstones FROM feed_streams").one()).toEqual({
        items: 0,
        tombstones: FEED_POLICY.streamTombstones,
      });
      // The tombstones written first went, fenced: their late openings stay out.
      expect(storage.sql.exec("SELECT count(*) AS n FROM feed_evictions").one()).toEqual({ n: 2 });
      apply([entry({ kind: "approved", thread: 1, version: 1 })]);
      expect(rows("thread_key = 'pull/1'")).toEqual([]);
    });
  });
});

describe("an item the cap evicted", () => {
  /** Items of threads `from` on: with the one applied first, a stream past its cap. */
  const filler = (from: number) =>
    Array.from({ length: FEED_POLICY.streamItems }, (_, i) =>
      entry({ thread: from + i, version: 1 }),
    );

  it("stays gone for a late entry of a version it had, its opening or its latest", async () => {
    await inFeed((storage) => {
      const { feed, apply, head, rows } = feedIn(storage);
      const kind = "review_requested";
      const id = { repoId: "rep_test", threadKey: "pull/1", kind } as const;
      const ack = (version: number) =>
        storage.transactionSync(() => feed.ack(id, { epoch: 1, version }));
      apply([entry({ kind, version: 1, priority: "P0" })]);
      expect(ack(1)).toMatchObject({ status: "acked" });
      apply([entry({ kind, version: 2, priority: "P0", state: "resolved" })]);
      apply(filler(2));
      retainAll(storage, feed);
      const thread = () => rows("thread_key = 'pull/1'");
      expect(thread()).toEqual([]);
      const at = head();
      // Delivered again: neither the opening nor the latest version brings it back, open and
      // without its acknowledgement, nor takes a sequence number.
      apply([entry({ kind, version: 1, priority: "P0" })]);
      apply([entry({ kind, version: 2, priority: "P0", state: "resolved" })]);
      expect(thread()).toEqual([]);
      expect(head()).toBe(at);
      expect(ack(2)).toEqual({ status: "missing" });
      // A newer version is news: it shows.
      apply([entry({ kind, version: 3, priority: "P0" })]);
      expect(thread()).toMatchObject([{ version: 3, state: "open", acked_version: 0 }]);
    });
  });

  it("takes a restored repository's versions as newer, and keeps the older generation's out", async () => {
    await inFeed((storage) => {
      const { feed, apply, rows } = feedIn(storage);
      apply([entry({ version: 5 })]);
      apply(filler(2));
      retainAll(storage, feed);
      apply([entry({ version: 1, epochGen: 2 })]);
      apply([entry({ version: 6 })]);
      expect(rows("thread_key = 'pull/1'")).toMatchObject([{ thread_epoch: 2, version: 1 }]);
      expect(ids(rows("thread_key = 'pull/1'")[0]?.members)).toEqual(["1"]);
    });
  });

  it("keeps a late member it had out of the item that took its place", async () => {
    await inFeed((storage) => {
      const { feed, apply, rows } = feedIn(storage);
      apply([entry({ version: 3 })]);
      apply(filler(2));
      retainAll(storage, feed);
      apply([entry({ version: 4 })]);
      // Of the same generation: an activity item would take it as a member, whatever its version.
      apply([entry({ version: 2 })]);
      expect(ids(rows("thread_key = 'pull/1'")[0]?.members)).toEqual(["4"]);
    });
  });

  it("keeps at most so many fences however many items churn, keeping the latest evicted out", async () => {
    await inFeed((storage) => {
      const t0 = Date.now();
      const { feed, apply, head, rows } = feedIn(storage, () => t0);
      const evicted = FEED_POLICY.streamFences + 500;
      // One item a thread, each a millisecond after the one before.
      const history = Array.from({ length: FEED_POLICY.streamItems + evicted }, (_, i) =>
        entry({ thread: i + 1, version: 1, occurredAt: t0 - DAY + i }),
      );
      for (let at = 0; at < history.length; at += 1_000) {
        apply(history.slice(at, at + 1_000));
        retainAll(storage, feed);
      }
      const count = (table: string) =>
        storage.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).one().n;
      expect(count("feed_items")).toBe(FEED_POLICY.streamItems);
      expect(count("feed_evictions")).toBe(FEED_POLICY.streamFences);
      // The items evicted last, delivered again: none comes back.
      const at = head();
      apply(history.slice(evicted - FEED_POLICY.streamFences, evicted));
      expect(head()).toBe(at);
      expect(count("feed_items")).toBe(FEED_POLICY.streamItems);
      // One evicted before them, its fence gone: shown again (the documented limit).
      apply([history[0] ?? entry({ version: 1 })]);
      expect(rows("thread_key = 'pull/1'")).toHaveLength(1);
    });
  });

  it("is fenced until its entries are too old to apply, and retention comes back for the fence", async () => {
    const t0 = Date.now();
    let now = t0;
    await inFeed((storage) => {
      const { feed, apply, rows } = feedIn(storage, () => now);
      apply([entry({ version: 1, occurredAt: t0 - DAY })]);
      apply(filler(2));
      retainAll(storage, feed);
      const fences = () =>
        storage.sql.exec("SELECT thread_key, version FROM feed_evictions").toArray();
      expect(fences()).toEqual([{ thread_key: "pull/1", version: 1 }]);
      // The fence expires first: the items left changed at t0.
      expect(feed.nextRetention()).toBe(t0 - DAY + FEED_POLICY.retentionMs);
      now = t0 - DAY + FEED_POLICY.retentionMs + 1;
      retainAll(storage, feed);
      expect(fences()).toEqual([]);
      expect(rows()).toHaveLength(FEED_POLICY.streamItems);
      // Its entries are dropped for their age now.
      apply([entry({ version: 1, occurredAt: t0 - DAY })]);
      expect(rows("thread_key = 'pull/1'")).toEqual([]);
    });
  });
});
