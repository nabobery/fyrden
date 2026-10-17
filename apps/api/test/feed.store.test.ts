// The activity feed's storage: entries applied idempotently in any order
// (version-guarded items, activity as a capped set of members), every
// change sequenced so a cursor never skips one, and acknowledgements.

import { env } from "cloudflare:workers";
import type { FeedEntry, FeedKind, FeedPriority } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FEED_POLICY } from "../src/do/user/feed.js";
import { entry, feedIn, ids, inFeed } from "./helpers/feed.js";

describe("applying entries", () => {
  it("converges on the same items under any order, duplicates and batch splits", async () => {
    const step = fc.record({
      thread: fc.integer({ min: 1, max: 2 }),
      kind: fc.constantFrom<FeedKind>("activity", "review_requested", "mention"),
      // A comment of its own (its id from the version: a restore's ids repeat older ones).
      comment: fc.boolean(),
      // Authors and times differ from event to event.
      actor: fc.constantFrom("usr_a", "usr_b", "usr_c"),
      ago: fc.integer({ min: 0, max: 60 * 60 * 1000 }),
      // Action items open and resolve in any interleaving.
      state: fc.constantFrom<"open" | "resolved">("open", "resolved"),
      priority: fc.constantFrom<FeedPriority>("P0", "P1"),
      silent: fc.boolean(),
    });
    // One event per version of a thread, as the repository numbers them.
    // A restore of the repository from some event on: its versions start again, in epoch 2.
    const history = fc
      .tuple(fc.array(step, { minLength: 1, maxLength: 30 }), fc.nat(40))
      .map(([steps, restore]) => {
        const versions = new Map<string, number>();
        const now = Date.now();
        return steps.map(({ kind, state, comment, ago, ...s }, index) => {
          const epochGen = index >= restore ? 2 : 1;
          const key = `${s.thread}:${epochGen}`;
          const version = (versions.get(key) ?? 0) + 1;
          versions.set(key, version);
          return entry({
            ...s,
            kind,
            epochGen,
            version,
            member: comment ? `comment/${version}` : null,
            occurredAt: now - ago,
            state: kind === "activity" ? "open" : state,
          });
        });
      });
    const delivery = history.chain((entries) =>
      fc.tuple(
        fc.constant(entries),
        fc.shuffledSubarray(entries, { minLength: entries.length }),
        fc.array(fc.integer({ min: 0, max: entries.length - 1 }), { maxLength: 10 }),
        fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 10 }),
      ),
    );
    await inFeed((storage) => {
      const { apply, state, reset } = feedIn(storage);
      fc.assert(
        fc.property(delivery, ([entries, shuffled, duplicates, sizes]) => {
          reset();
          apply(entries);
          const expected = state();
          reset();
          const arrivals = [...shuffled, ...duplicates.map((i) => entries[i] as FeedEntry)];
          for (let at = 0, n = 0; at < arrivals.length; n++) {
            const size = sizes[n % sizes.length] as number;
            apply(arrivals.slice(at, at + size));
            at += size;
          }
          expect(state()).toEqual(expected);
        }),
        { numRuns: 1_000 },
      );
    });
  });

  it("applies an action item only from a newer version, and writes nothing for a duplicate", async () => {
    await inFeed((storage) => {
      const { apply, head, items } = feedIn(storage);
      const kind = "review_requested";
      expect(apply([entry({ kind, version: 2, priority: "P0" })])).toEqual({
        changed: 1,
        notified: 1,
      });
      expect(head()).toBe(1);
      // Older, then the same again: nothing written, nothing sequenced.
      expect(apply([entry({ kind, version: 1, state: "resolved" })]).changed).toBe(0);
      expect(apply([entry({ kind, version: 2, priority: "P0" })]).changed).toBe(0);
      expect(head()).toBe(1);
      expect(items()).toMatchObject([{ version: 2, state: "open", priority: "P0" }]);
      // Newer: replaces the item and takes the next sequence number.
      expect(apply([entry({ kind, version: 3, state: "resolved" })]).changed).toBe(1);
      expect(head()).toBe(2);
      expect(items()).toMatchObject([{ version: 3, state: "resolved" }]);
    });
  });

  it("shows nothing for an entry that only resolves an item the feed does not have, and keeps it from older entries", async () => {
    await inFeed((storage) => {
      const { apply, head, items, rows } = feedIn(storage);
      for (const kind of ["review_requested", "approved", "merge_conflict"] as const)
        expect(
          apply([entry({ kind, version: 4, state: "resolved", silent: true, priority: "P0" })]),
        ).toEqual({
          changed: 0,
          notified: 0,
        });
      expect(items()).toEqual([]);
      expect(head()).toBe(0);
      expect(storage.sql.exec("SELECT items FROM feed_meta").one()).toEqual({ items: 0 });
      // A newer resolution updates the tombstone, still unseen.
      apply([entry({ kind: "approved", version: 5, state: "resolved", priority: "P0" })]);
      expect(rows("kind = 'approved'")).toMatchObject([{ version: 5, feed_seq: null }]);
      expect(head()).toBe(0);
      // The request it resolved arrives late: shown as resolved, as in arrival order.
      expect(apply([entry({ kind: "review_requested", version: 3, priority: "P0" })])).toEqual({
        changed: 1,
        notified: 1,
      });
      expect(items()).toMatchObject([{ kind: "review_requested", version: 4, state: "resolved" }]);
      // A newer opening opens it again.
      apply([entry({ kind: "merge_conflict", version: 6, priority: "P0" })]);
      expect(items()).toMatchObject([
        { kind: "merge_conflict", version: 6, state: "open" },
        { kind: "review_requested", version: 4, state: "resolved" },
      ]);
      expect(head()).toBe(2);
      // Neither listed, synced nor acknowledged.
      expect(
        feedIn(storage)
          .feed.sync(null, 50, null)
          .items.map((i) => i.kind),
      ).toEqual(["merge_conflict"]);
      expect(
        feedIn(storage).feed.ack(
          { repoId: "rep_test", threadKey: "pull/1", kind: "approved" },
          { epoch: 1, version: 5 },
        ),
      ).toEqual({ status: "missing" });
    });
  });

  it("takes a restored repository's versions as newer, and keeps a delayed one from before out", async () => {
    await inFeed((storage) => {
      const { feed, apply, items, reset } = feedIn(storage);
      const kind = "review_requested";
      const before = entry({ kind, version: 20, priority: "P0" });
      // Restored: the thread's versions start again, in epoch 2.
      const restored = entry({ kind, epochGen: 2, version: 1, state: "resolved", priority: "P0" });
      // Delivered late, from before the restore (the restored repository never had it).
      const delayed = entry({ kind, version: 21, priority: "P0" });
      apply([before]);
      expect(apply([restored])).toEqual({ changed: 1, notified: 1 });
      expect(apply([delayed])).toEqual({ changed: 0, notified: 0 });
      expect(items()).toMatchObject([{ thread_epoch: 2, version: 1, state: "resolved" }]);
      // In one call, in any order, the same.
      reset();
      apply([delayed, restored, before]);
      expect(items()).toMatchObject([{ thread_epoch: 2, version: 1, state: "resolved" }]);
      // Acknowledgements order by epoch, then version.
      const id = { repoId: "rep_test", threadKey: "pull/1", kind } as const;
      const ack = (epoch: number, version: number) =>
        storage.transactionSync(() => feed.ack(id, { epoch, version }));
      expect(ack(2, 2)).toEqual({ status: "ahead" });
      expect(ack(1, 20)).toMatchObject({ item: { ackedEpoch: 1, ackedVersion: 20 } });
      expect(ack(2, 1)).toMatchObject({ item: { ackedEpoch: 2, ackedVersion: 1 } });
      expect(ack(1, 30)).toMatchObject({ item: { ackedEpoch: 2, ackedVersion: 1 } });
    });
  });

  it("keeps on an activity item only the members of the repository's newest restore generation", async () => {
    await inFeed((storage) => {
      const { apply, items, reset } = feedIn(storage);
      const t = Date.now();
      const old = entry({ version: 5, member: "comment/99", actor: "usr_old", occurredAt: t - 9 });
      const reused = entry({
        version: 1,
        member: "comment/1",
        actor: "usr_old",
        occurredAt: t - 8,
      });
      const restored = entry({
        epochGen: 2,
        version: 1,
        member: "comment/1",
        actor: "usr_new",
        occurredAt: t,
      });
      for (const order of [
        [old, reused, restored],
        [restored, old, reused],
        [reused, restored, old],
      ]) {
        reset();
        for (const one of order) apply([one]);
        expect(items()).toMatchObject([
          { thread_epoch: 2, version: 1, display_member: "comment/1", actor: "usr_new" },
        ]);
        expect(JSON.parse(items()[0]?.members as string)).toEqual([
          { id: "comment/1", at: t, actor: "usr_new", trust: "write" },
        ]);
      }
      // A newer generation's entry with no member shows no one, whatever came before it.
      const reader = entry({ version: 2, member: "comment/2", actorTrust: "read" });
      const closed = entry({ epochGen: 3, version: 1, member: null, actorTrust: "write" });
      for (const order of [
        [reader, closed],
        [closed, reader],
      ]) {
        reset();
        for (const one of order) apply([one]);
        expect(items()).toMatchObject([
          { thread_epoch: 3, display_member: null, actor: null, actor_trust: "none" },
        ]);
      }
      reset();
      for (const one of [old, reused, restored]) apply([one]);
      // A delayed older generation's comment changes nothing.
      expect(apply([entry({ version: 30, member: "comment/500" })])).toEqual({
        changed: 0,
        notified: 0,
      });
    });
  });

  it("sequences a silent change without counting a notification", async () => {
    await inFeed((storage) => {
      const { apply, head, items } = feedIn(storage);
      const kind = "review_requested";
      apply([entry({ kind, version: 1, priority: "P0" })]);
      // The reviewer's own review resolves its request.
      expect(apply([entry({ kind, version: 2, state: "resolved", silent: true })])).toEqual({
        changed: 1,
        notified: 0,
      });
      expect(head()).toBe(2);
      expect(items()).toMatchObject([{ state: "resolved", silent: 1 }]);
    });
  });

  it("lets the owner's own action reopen its item, version-guarded, without a notification", async () => {
    await inFeed((storage) => {
      const { apply, head, items } = feedIn(storage);
      const kind = "approved";
      apply([entry({ kind, version: 1, priority: "P0" })]);
      apply([entry({ kind, version: 2, priority: "P0", state: "resolved" })]);
      // The author dismisses the later review: the approval stands again.
      expect(apply([entry({ kind, version: 3, priority: "P0", silent: true })])).toEqual({
        changed: 1,
        notified: 0,
      });
      expect(items()).toMatchObject([{ state: "open", version: 3, silent: 1 }]);
      // An older silent entry is still refused.
      expect(
        apply([entry({ kind, version: 2, priority: "P0", state: "resolved", silent: true })]),
      ).toEqual({ changed: 0, notified: 0 });
      expect(head()).toBe(3);
    });
  });

  it("displays the greatest member, whatever the order its comments arrive in", async () => {
    const history = [
      entry({ version: 1, member: "comment/20", actor: "usr_a" }),
      entry({ version: 2, member: "comment/3", actor: "usr_b" }),
      entry({ version: 3, member: "review/1", actor: "usr_c" }),
      entry({ version: 4, member: null, action: "closed", actor: "usr_e" }),
    ];
    await inFeed((storage) => {
      const { apply, items, reset } = feedIn(storage);
      fc.assert(
        fc.property(fc.shuffledSubarray(history, { minLength: history.length }), (shuffled) => {
          reset();
          for (const one of shuffled) apply([one]);
          // "comment/20" is the greatest (longest) id: it and its author are displayed.
          expect(items()).toMatchObject([
            {
              display_member: "comment/20",
              actor: "usr_a",
              version: 4,
              action: "closed",
            },
          ]);
          expect(ids(items()[0]?.members)).toEqual(["comment/20", "comment/3", "review/1"]);
        }),
        { numRuns: 30 },
      );
    });
  });

  it("keeps the greatest 100 members of an activity item, whatever the order, and says some were dropped", async () => {
    const entries = Array.from({ length: 130 }, (_, i) => entry({ version: i + 1 }));
    await inFeed((storage) => {
      const { apply, items, reset } = feedIn(storage);
      fc.assert(
        fc.property(
          fc.shuffledSubarray(entries, { minLength: entries.length }),
          fc.integer({ min: 1, max: 40 }),
          (shuffled, size) => {
            reset();
            for (let at = 0; at < shuffled.length; at += size) apply(shuffled.slice(at, at + size));
            const [item] = items() as { members: string; truncated: number; version: number }[];
            // Ids order as numbers: 31 to 130 are the greatest.
            expect(ids(item?.members)).toEqual(
              Array.from({ length: 100 }, (_, i) => String(130 - i)),
            );
            expect(item).toMatchObject({ truncated: 1, version: 130 });
          },
        ),
        { numRuns: 30 },
      );
    });
  });

  it("drops entries older than the retention", async () => {
    await inFeed((storage) => {
      const now = Date.now();
      const { apply, items } = feedIn(storage, () => now);
      apply([entry({ version: 1, occurredAt: now - FEED_POLICY.retentionMs - 1 })]);
      expect(items()).toEqual([]);
      apply([entry({ version: 2, occurredAt: now - FEED_POLICY.retentionMs })]);
      expect(items()).toHaveLength(1);
    });
  });
});

describe("reading the feed", () => {
  it("never lets a cursor skip a change that arrives late", async () => {
    const stub = env.USER.getByName(uniqueId("usr"));
    await stub.applyFeed([entry({ version: 3 })]);
    const first = await stub.listFeed(null, 50, {});
    if (first.expired) throw new Error("expired");
    expect(first.items.map((i) => i.members)).toEqual([["3"]]);
    // An older comment arrives after the reader caught up: the item comes again, after the head.
    await stub.applyFeed([entry({ version: 2 })]);
    const next = await stub.listFeed(first.head, 50, {});
    if (next.expired) throw new Error("expired");
    expect(next.items).toMatchObject([{ members: ["3", "2"], version: 3 }]);
    expect(next.items[0]?.seq).toBeGreaterThan(first.head.seq);
    // A late action entry older than the item changes nothing: nothing new after the head.
    await stub.applyFeed([entry({ kind: "mention", version: 5 })]);
    await stub.applyFeed([entry({ kind: "mention", version: 4 })]);
    const after = await stub.listFeed(next.head, 50, {});
    if (after.expired) throw new Error("expired");
    expect(after.items.map((i) => [i.kind, i.version])).toEqual([["mention", 5]]);
    const last = await stub.listFeed(after.head, 50, {});
    expect(last).toMatchObject({ expired: false, items: [], more: false });
  });

  it("pages in sequence order, with filters", async () => {
    const stub = env.USER.getByName(uniqueId("usr"));
    await stub.applyFeed([
      entry({ thread: 1, version: 1 }),
      entry({ thread: 2, kind: "mention", version: 1, priority: "P0" }),
      entry({ thread: 3, version: 1 }),
    ]);
    const page = await stub.listFeed(null, 2, {});
    if (page.expired) throw new Error("expired");
    expect(page.items.map((i) => i.threadKey)).toEqual(["pull/1", "pull/2"]);
    expect(page.more).toBe(true);
    const mentions = await stub.listFeed(null, 50, { kind: "mention" });
    expect(mentions).toMatchObject({ items: [{ threadKey: "pull/2" }], more: false });
    const p0 = await stub.listFeed(null, 50, { priority: "P0" });
    expect(p0).toMatchObject({ items: [{ threadKey: "pull/2" }] });
  });

  it("guards acknowledgements by version, and sequences each one", async () => {
    const stub = env.USER.getByName(uniqueId("usr"));
    const kind = "review_requested";
    await stub.applyFeed([entry({ kind, version: 2, priority: "P0" })]);
    const id = { repoId: "rep_test", threadKey: "pull/1", kind } as const;
    expect(await stub.ackFeed(id, { epoch: 1, version: 3 })).toEqual({ status: "ahead" });
    expect(await stub.ackFeed({ ...id, threadKey: "pull/9" }, { epoch: 1, version: 1 })).toEqual({
      status: "missing",
    });
    const acked = await stub.ackFeed(id, { epoch: 1, version: 2 });
    expect(acked).toMatchObject({ status: "acked", item: { ackedVersion: 2, seq: 2 } });
    // An older or the same version again: unchanged, not sequenced again.
    expect(await stub.ackFeed(id, { epoch: 1, version: 1 })).toMatchObject({
      item: { ackedVersion: 2, seq: 2 },
    });
    expect(await stub.ackFeed(id, { epoch: 1, version: 2 })).toMatchObject({
      item: { ackedVersion: 2, seq: 2 },
    });
    // A newer version of the item keeps the acknowledgement of the older one.
    await stub.applyFeed([entry({ kind, version: 3, priority: "P0" })]);
    const page = await stub.listFeed(null, 50, {});
    expect(page).toMatchObject({ items: [{ version: 3, ackedVersion: 2 }] });
  });

  it("syncs open P0 items first, then recent P1 items, a page at a time", async () => {
    const stub = env.USER.getByName(uniqueId("usr"));
    await stub.applyFeed([
      entry({ thread: 1, kind: "review_requested", version: 1, priority: "P0" }),
      entry({ thread: 2, version: 1 }),
      entry({ thread: 3, kind: "approved", version: 1, priority: "P0" }),
    ]);
    await stub.applyFeed([
      entry({ thread: 3, kind: "approved", version: 2, priority: "P0", state: "resolved" }),
    ]);
    const synced = await stub.syncFeed(null, 50, null);
    expect(synced.items.map((i) => [i.threadKey, i.kind])).toEqual([
      ["pull/1", "review_requested"],
      ["pull/2", "activity"],
    ]);
    expect(synced.more).toBe(false);
    const first = await stub.syncFeed(null, 1, null);
    expect(first).toMatchObject({ items: [{ threadKey: "pull/1" }], more: true });
    const next = await stub.syncFeed({ open: true, seq: first.items[0]?.seq ?? 0 }, 1, null);
    expect(next).toMatchObject({ items: [{ threadKey: "pull/2" }], more: false });
    // Limited to some repositories: the others are not read at all.
    expect((await stub.syncFeed(null, 50, ["rep_other"])).items).toEqual([]);
  });
});
