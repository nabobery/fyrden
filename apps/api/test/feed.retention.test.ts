// The activity feed's retention: items and tombstones past 7 days and
// items past the cap are deleted in an alarm, and the low watermark
// expires cursors below what went.

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it, vi } from "vitest";
import type { UserDO } from "../src/do/UserDO.js";
import { FEED_POLICY } from "../src/do/user/feed.js";
import { DAY, entry, feedIn, ids, inFeed } from "./helpers/feed.js";

describe("retention", () => {
  it("deletes items past 7 days in an alarm, and expires cursors below the low watermark", async () => {
    const stub = env.USER.getByName(uniqueId("usr"));
    const t0 = Date.now();
    await stub.applyFeed([entry({ thread: 1, version: 1 })]);
    const alarm = await runInDurableObject(stub, (_: UserDO, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThanOrEqual(t0 + FEED_POLICY.retentionMs);
    const before = await stub.listFeed(null, 50, {});
    if (before.expired) throw new Error("expired");
    vi.setSystemTime(t0 + 3 * DAY);
    await stub.applyFeed([entry({ thread: 2, version: 1 })]);
    vi.setSystemTime(t0 + FEED_POLICY.retentionMs + 1_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const after = await stub.listFeed(null, 50, {});
    expect(after).toMatchObject({ items: [{ threadKey: "pull/2" }] });
    // A cursor before what retention deleted has missed it.
    expect(await stub.listFeed({ ...before.head, seq: 0 }, 50, {})).toEqual({ expired: true });
    expect(await stub.listFeed(before.head, 50, {})).toMatchObject({ expired: false });
    // The next alarm is when the remaining item expires.
    const next = await runInDurableObject(stub, (_: UserDO, state) => state.storage.getAlarm());
    expect(next).toBeGreaterThanOrEqual(t0 + 3 * DAY + FEED_POLICY.retentionMs);
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
    expect(
      await stub.listFeed({ epoch: (await stub.syncFeed(null, 1, null)).epoch, seq: 0 }, 50, {}),
    ).toMatchObject({ expired: false, items: [] });
    expect(await runInDurableObject(stub, (_: UserDO, state) => state.storage.getAlarm())).toBe(
      null,
    );
  });

  it("trims a feed past its cap, the items changed longest ago first", async () => {
    const stub = env.USER.getByName(uniqueId("usr"));
    const count = FEED_POLICY.maxItems + 3;
    await runInDurableObject(stub, (_: UserDO, state) => {
      const { apply } = feedIn(state.storage);
      apply(Array.from({ length: count }, (_, i) => entry({ thread: i + 1, version: 1 })));
    });
    await stub.applyFeed([entry({ thread: 1, version: 2 })]);
    // Past the cap: retention is due at once.
    const alarm = await runInDurableObject(stub, (_: UserDO, state) => state.storage.getAlarm());
    expect(alarm).toBeLessThanOrEqual(Date.now());
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const meta = await runInDurableObject(stub, (_: UserDO, state) =>
      state.storage.sql
        .exec<{ items: number; low_watermark: number; n: number }>(
          "SELECT items, low_watermark, (SELECT count(*) FROM feed_items) AS n FROM feed_meta",
        )
        .one(),
    );
    // Threads 2-4 went (thread 1 changed last); the cursor after them is still good.
    expect(meta).toEqual({
      items: FEED_POLICY.maxItems,
      low_watermark: 4,
      n: FEED_POLICY.maxItems,
    });
    const page = await stub.listFeed(null, 1, {});
    expect(page).toMatchObject({ items: [{ threadKey: "pull/5" }] });
  });
});

describe("an item the cap evicted", () => {
  /** Items of threads `from` on: with the one applied first, a feed past its cap. */
  const filler = (from: number) =>
    Array.from({ length: FEED_POLICY.maxItems }, (_, i) => entry({ thread: from + i, version: 1 }));

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
      storage.transactionSync(() => feed.retain());
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
      storage.transactionSync(() => feed.retain());
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
      storage.transactionSync(() => feed.retain());
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
      const evicted = FEED_POLICY.maxFences + 500;
      // One item a thread, each a millisecond after the one before.
      const history = Array.from({ length: FEED_POLICY.maxItems + evicted }, (_, i) =>
        entry({ thread: i + 1, version: 1, occurredAt: t0 - DAY + i }),
      );
      for (let at = 0; at < history.length; at += 1_000) {
        apply(history.slice(at, at + 1_000));
        storage.transactionSync(() => feed.retain());
      }
      const count = (table: string) =>
        storage.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).one().n;
      expect(count("feed_items")).toBe(FEED_POLICY.maxItems);
      expect(count("feed_evictions")).toBe(FEED_POLICY.maxFences);
      // The items evicted last, delivered again: none comes back.
      const at = head();
      apply(history.slice(evicted - FEED_POLICY.maxFences, evicted));
      expect(head()).toBe(at);
      expect(count("feed_items")).toBe(FEED_POLICY.maxItems);
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
      storage.transactionSync(() => feed.retain());
      const fences = () =>
        storage.sql.exec("SELECT thread_key, version FROM feed_evictions").toArray();
      expect(fences()).toEqual([{ thread_key: "pull/1", version: 1 }]);
      // The fence expires first: the items left changed at t0.
      expect(feed.nextRetention()).toBe(t0 - DAY + FEED_POLICY.retentionMs);
      now = t0 - DAY + FEED_POLICY.retentionMs + 1;
      storage.transactionSync(() => feed.retain());
      expect(fences()).toEqual([]);
      expect(rows()).toHaveLength(FEED_POLICY.maxItems);
      // Its entries are dropped for their age now.
      apply([entry({ version: 1, occurredAt: t0 - DAY })]);
      expect(rows("thread_key = 'pull/1'")).toEqual([]);
    });
  });
});
