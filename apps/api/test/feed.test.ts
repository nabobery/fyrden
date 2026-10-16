// The activity feed of a user or agent: entries applied idempotently in any
// order (version-guarded items, activity as a capped set of members), every
// change sequenced so a cursor never skips one, retention with a low
// watermark, acknowledgements, and the feed operations: whose feed a token
// reads, and items of repositories the caller cannot read now left out.

import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import type { FeedEntry, FeedKind, FeedPriority } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import fc from "fast-check";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OrgDO } from "../src/do/OrgDO.js";
import type { UserDO } from "../src/do/UserDO.js";
import { FEED_POLICY, Feed } from "../src/do/user/feed.js";
import { encodeFeedCursor, FEED_POLL_AFTER_MS } from "../src/feed/operations.js";
import { ACCESS_TOKEN_TYPE, TOKEN_EXCHANGE } from "../src/oauth/exchange.js";
import { SESSION_COOKIE, startSession } from "../src/oauth/session.js";
import { agentFor } from "./helpers/agents.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { ORIGIN } from "./helpers/git-http.js";
import { scopedToken } from "./helpers/principals.js";

const DAY = 24 * 60 * 60 * 1000;

interface EntryInit {
  repoId?: string;
  thread?: number;
  kind?: FeedKind;
  version: number;
  state?: "open" | "resolved";
  priority?: FeedPriority;
  member?: string | null;
  silent?: boolean;
  occurredAt?: number;
  principal?: string;
  action?: string;
  excerpt?: string | null;
  actor?: string;
  threadKey?: string;
}

/** One recipient's entry, built by hand as the repository would send it. */
function entry(init: EntryInit): FeedEntry {
  const thread = init.thread ?? 1;
  const kind = init.kind ?? "activity";
  return {
    eventKey: `rep_test:1:${init.version}`,
    repoId: init.repoId ?? "rep_test",
    occurredAt: init.occurredAt ?? Date.now(),
    actor: init.actor ?? "usr_actor",
    feed: {
      threadKey: init.threadKey ?? `pull/${thread}`,
      subject: { kind: "pull", number: thread, title: `Pull ${thread}`, version: init.version },
      action: init.action ?? (kind === "activity" ? "comment" : kind),
      actorRoot: "usr_actor",
      actorTrust: "write",
      member:
        init.member === undefined
          ? kind === "activity"
            ? String(init.version)
            : null
          : init.member,
      excerpt: init.excerpt === undefined ? `at version ${init.version}` : init.excerpt,
    },
    recipient: {
      principal: init.principal ?? "usr_reader",
      kind,
      reasons: ["commenter"],
      priority: init.priority ?? "P1",
      state: init.state ?? "open",
      silent: init.silent ?? false,
    },
  };
}

type Storage = DurableObjectState["storage"];

/** A feed on a fresh object's storage, with what the tests read from it. */
function feedIn(storage: Storage, now: () => number = Date.now) {
  const feed = new Feed(storage.sql, now);
  const apply = (entries: readonly FeedEntry[]) =>
    storage.transactionSync(() => feed.apply(entries));
  const head = () =>
    storage.sql.exec<{ head_seq: number }>("SELECT head_seq FROM feed_meta").one().head_seq;
  const rows = (where = "true") =>
    storage.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT * FROM feed_items WHERE ${where} ORDER BY repo_id, thread_key, kind`,
      )
      .toArray();
  /** The shown items without their sequence numbers (which depend on arrival order). */
  const items = () =>
    rows("feed_seq IS NOT NULL").map(({ feed_seq: _, seq_at: __, ...rest }) => rest);
  /**
   * Every row as it bears on what is shown: an item whole (but its
   * sequence number), a tombstone by what it guards against.
   */
  const state = () =>
    rows().map(({ feed_seq, seq_at: _, deleted, ...rest }) => {
      const gone = (JSON.parse(deleted as string) as string[]).sort();
      return feed_seq === null
        ? { tombstone: [rest.repo_id, rest.thread_key, rest.kind, rest.version, rest.state], gone }
        : { ...rest, gone };
    });
  const reset = () => {
    storage.sql.exec("DELETE FROM feed_items");
    storage.sql.exec("UPDATE feed_meta SET head_seq = 0, low_watermark = 0, items = 0");
  };
  return { feed, apply, head, rows, items, state, reset };
}

const inFeed = <T>(fn: (storage: Storage) => T) =>
  runInDurableObject(env.USER.getByName(uniqueId("usr")), (_: UserDO, state) => fn(state.storage));

describe("applying entries", () => {
  it("converges on the same items under any order, duplicates and batch splits", async () => {
    const step = fc.record({
      thread: fc.integer({ min: 1, max: 2 }),
      kind: fc.constantFrom<FeedKind | "deletion" | "edit">(
        "activity",
        "review_requested",
        "mention",
        "deletion",
        "edit",
      ),
      member: fc.option(fc.integer({ min: 1, max: 40 }).map(String), { nil: null }),
      // Action items open and resolve in any interleaving.
      state: fc.constantFrom<"open" | "resolved">("open", "resolved"),
      priority: fc.constantFrom<FeedPriority>("P0", "P1"),
      silent: fc.boolean(),
    });
    // One event per version of a thread, as the repository numbers them.
    const history = fc.array(step, { minLength: 1, maxLength: 30 }).map((steps) => {
      const versions = new Map<number, number>();
      return steps.map(({ kind, state, ...s }) => {
        const version = (versions.get(s.thread) ?? 0) + 1;
        versions.set(s.thread, version);
        if (kind === "deletion")
          return entry({ ...s, version, member: s.member ?? "1", action: "comment_deleted" });
        if (kind === "edit")
          return entry({
            ...s,
            version,
            member: s.member ?? "1",
            action: "comment_edited",
            excerpt: `edited at ${version}`,
          });
        return entry({ ...s, kind, version, state: kind === "activity" ? "open" : state });
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
        feedIn(storage).feed.ack({ repoId: "rep_test", threadKey: "pull/1", kind: "approved" }, 5),
      ).toEqual({ status: "missing" });
    });
  });

  it("never adds a comment whose deletion arrived first", async () => {
    await inFeed((storage) => {
      const { apply, head, items, rows } = feedIn(storage);
      const deletion = (member: string) =>
        entry({ version: 7, member, excerpt: null, silent: true, action: "comment_deleted" });
      expect(apply([deletion("comment/1")])).toEqual({ changed: 0, notified: 0 });
      expect(rows()).toMatchObject([{ feed_seq: null, deleted: JSON.stringify(["comment/1"]) }]);
      expect(head()).toBe(0);
      // The comment arrives: the item is shown, without it or its excerpt.
      apply([entry({ version: 3, member: "comment/1", excerpt: "gone" })]);
      expect(items()).toMatchObject([{ version: 3, members: "[]", excerpt: null }]);
      apply([entry({ version: 4, member: "comment/2", excerpt: "kept" })]);
      expect(items()).toMatchObject([{ members: JSON.stringify(["comment/2"]), excerpt: "kept" }]);
      // Its edit, late too: nothing.
      const edited = entry({ version: 8, member: "comment/1", action: "comment_edited" });
      expect(apply([edited]).changed).toBe(0);
      expect(head()).toBe(2);
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

  it("updates or clears the excerpt of an edited or deleted comment, and drops a deleted one from the members", async () => {
    await inFeed((storage) => {
      const { apply, head, items, rows } = feedIn(storage);
      const edit = (version: number, member: string, excerpt: string | null, deleted = false) =>
        entry({
          version,
          member,
          excerpt,
          silent: true,
          action: deleted ? "comment_deleted" : "comment_edited",
        });
      // An edit for a thread the feed has nothing of shows nothing (a tombstone keeps it).
      const elsewhere = entry({
        version: 9,
        member: "comment/1",
        threadKey: "pull/9",
        action: "comment_edited",
      });
      expect(apply([elsewhere]).changed).toBe(0);
      expect(head()).toBe(0);
      expect(rows()).toMatchObject([{ thread_key: "pull/9", feed_seq: null }]);
      apply([
        entry({ version: 1, member: "comment/1", excerpt: "first" }),
        entry({ version: 2, member: "comment/2", excerpt: "second" }),
      ]);
      apply([entry({ kind: "review_requested", version: 2, state: "resolved", priority: "P0" })]);
      expect(head()).toBe(2);
      // A member the item does not display (comment/2 is the greatest): nothing changes.
      expect(apply([edit(3, "comment/1", "first, edited")])).toEqual({ changed: 0, notified: 0 });
      expect(head()).toBe(2);
      // The displayed member's edit, whatever the thread's state: replaced, nothing else.
      expect(apply([edit(4, "comment/2", "second, edited")])).toEqual({ changed: 1, notified: 0 });
      expect(apply([edit(4, "comment/2", "second, edited")]).changed).toBe(0);
      // An older edit arriving late changes nothing.
      expect(apply([edit(3, "comment/2", "second, stale")]).changed).toBe(0);
      expect(head()).toBe(3);
      expect(items()).toMatchObject([
        {
          kind: "activity",
          version: 2,
          state: "open",
          silent: 0,
          action: "comment",
          excerpt: "second, edited",
          members: JSON.stringify(["comment/2", "comment/1"]),
        },
      ]);
      // Deleting another member drops it and keeps the excerpt; deleting the excerpt's clears it.
      expect(apply([edit(5, "comment/1", null, true)])).toEqual({ changed: 1, notified: 0 });
      expect(items()).toMatchObject([
        { excerpt: "second, edited", members: JSON.stringify(["comment/2"]) },
      ]);
      expect(apply([edit(6, "comment/2", null, true)])).toEqual({ changed: 1, notified: 0 });
      expect(items()).toMatchObject([{ excerpt: null, members: "[]", version: 2 }]);
      expect(apply([edit(6, "comment/2", null, true)]).changed).toBe(0);
      expect(head()).toBe(5);
    });
  });

  it("displays the greatest member, whatever the order its creation and edits arrive in", async () => {
    const edited = (version: number, excerpt: string) =>
      entry({
        version,
        member: "comment/20",
        excerpt,
        action: "comment_edited",
        actor: "usr_d",
        silent: true,
      });
    const history = [
      entry({ version: 1, member: "comment/20", excerpt: "twenty", actor: "usr_a" }),
      entry({ version: 2, member: "comment/3", excerpt: "three", actor: "usr_b" }),
      entry({ version: 3, member: "review/1", excerpt: "review", actor: "usr_c" }),
      edited(4, "twenty, again"),
      edited(5, "twenty, last"),
      entry({ version: 6, member: null, action: "closed", actor: "usr_e" }),
    ];
    await inFeed((storage) => {
      const { apply, items, reset } = feedIn(storage);
      fc.assert(
        fc.property(fc.shuffledSubarray(history, { minLength: history.length }), (shuffled) => {
          reset();
          for (const one of shuffled) apply([one]);
          // "comment/20" is the greatest (longest) id: its author, its newest edit.
          expect(items()).toMatchObject([
            {
              display_member: "comment/20",
              excerpt: "twenty, last",
              actor: "usr_a",
              display_version: 5,
              version: 6,
              action: "closed",
              members: JSON.stringify(["comment/20", "comment/3", "review/1"]),
            },
          ]);
        }),
        { numRuns: 60 },
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
            expect(JSON.parse(item?.members ?? "[]")).toEqual(
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
    expect(await stub.ackFeed(id, 3)).toEqual({ status: "ahead" });
    expect(await stub.ackFeed({ ...id, threadKey: "pull/9" }, 1)).toEqual({ status: "missing" });
    const acked = await stub.ackFeed(id, 2);
    expect(acked).toMatchObject({ status: "acked", item: { ackedVersion: 2, seq: 2 } });
    // An older or the same version again: unchanged, not sequenced again.
    expect(await stub.ackFeed(id, 1)).toMatchObject({ item: { ackedVersion: 2, seq: 2 } });
    expect(await stub.ackFeed(id, 2)).toMatchObject({ item: { ackedVersion: 2, seq: 2 } });
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

/** An entry for `repoId`, put straight into `principal`'s feed. */
async function deliverTo(principal: string, init: EntryInit & { repoId: string }) {
  await env.USER.getByName(principal).applyFeed([entry({ ...init, principal })]);
}

async function repoOf(owner: Who): Promise<{ id: string; name: string; fullName: string }> {
  const made = await json<{ id: string; name: string }>(
    api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
  );
  expect(made.status).toBe(201);
  return { ...made.body, fullName: `${owner.handle}/${made.body.name}` };
}

type FeedOut = {
  items: {
    item_key: string;
    repo: { full_name: string };
    version: number;
    acked_version: number;
  }[];
  next_cursor: string;
  head_cursor: string;
  poll_after_ms: number;
  code?: string;
  resync?: string;
};

const feedNames = (body: FeedOut) => body.items.map((i) => i.repo.full_name);

describe("the feed operations", () => {
  let owner: Who;
  let repo: Awaited<ReturnType<typeof repoOf>>;
  let other: Awaited<ReturnType<typeof repoOf>>;

  beforeAll(async () => {
    owner = await user();
    repo = await repoOf(owner);
    other = await repoOf(owner);
    await deliverTo(owner.principalId, { repoId: repo.id, version: 1 });
    await deliverTo(owner.principalId, { repoId: other.id, version: 1 });
  });

  it("read the user's own feed with its token or its signed-in session", async () => {
    const res = await json<FeedOut>(api("GET", "/feed", owner.token));
    expect(res.status).toBe(200);
    expect(feedNames(res.body)).toEqual([repo.fullName, other.fullName]);
    expect(res.body.next_cursor).toBe(res.body.head_cursor);
    expect(res.body.poll_after_ms).toBeGreaterThan(0);
    const { cookie } = await startSession(env, owner.principalId, { via: "test" });
    const session = await exports.default.fetch(`${ORIGIN}/api/feed`, {
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}`, "X-Fyrden-Session": "1" },
    });
    expect(feedNames(await session.json<FeedOut>())).toEqual([repo.fullName, other.fullName]);
  });

  it("read the represented user's feed with a delegated token, limited to the grant's repositories", async () => {
    const agent = await agentFor(owner, ["pull_requests:read"], [repo.fullName]);
    const res = await json<FeedOut>(api("GET", "/feed", agent.delegated));
    expect(feedNames(res.body)).toEqual([repo.fullName]);
    // Its cursors name only what it was shown.
    const mine = await json<FeedOut>(api("GET", "/feed", owner.token));
    expect(res.body.head_cursor).not.toBe(mine.body.head_cursor);

    // A sub-agent under a narrower grant reads the same user's feed.
    const second = await json<{ id: string; handle: string }>(
      api("POST", "/agents", owner.token, { handle: uniqueId("bot").slice(0, 39) }),
    );
    const secondOwn = await json<{ token: string }>(
      api("POST", `/agents/${second.body.handle}/tokens`, owner.token, {}),
    );
    const sub = await json<{ id: string }>(
      api("POST", "/grants", agent.own, {
        agent: second.body.handle,
        scopes: ["pull_requests:read"],
        parent: agent.grantId,
      }),
    );
    expect(sub.status).toBe(201);
    const exchanged = await exports.default.fetch(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: TOKEN_EXCHANGE,
        subject_token: secondOwn.body.token,
        subject_token_type: ACCESS_TOKEN_TYPE,
        grant_id: sub.body.id,
      }).toString(),
    });
    const { access_token } = await exchanged.json<{ access_token: string }>();
    expect(feedNames((await json<FeedOut>(api("GET", "/feed", access_token))).body)).toEqual([
      repo.fullName,
    ]);
    // A grant without pull request reads shows nothing.
    const narrow = await agentFor(owner, ["metadata:read"]);
    expect((await json<FeedOut>(api("GET", "/feed", narrow.delegated))).body.items).toEqual([]);
  });

  it("read the agent's own feed with the agent's own token", async () => {
    const agent = await agentFor(owner, ["pull_requests:read"]);
    // The agent reads the repository: a role for it in the account's access list.
    const bystander = await user();
    await api("PUT", `/repos/${repo.fullName}/collaborators/${bystander.handle}`, owner.token, {
      permission: "pull",
    });
    await runInDurableObject(env.ORG.getByName(owner.principalId), (_: OrgDO, state) => {
      state.storage.sql.exec(
        "INSERT INTO collaborators (repo_id, principal_id, handle, role, added_at) VALUES (?, ?, ?, 'read', 0)",
        repo.id,
        agent.id,
        uniqueId("bot"),
      );
      state.storage.sql.exec("UPDATE org_meta SET acl_version = acl_version + 1");
    });
    await deliverTo(agent.id, { repoId: repo.id, thread: 7, version: 1 });
    const own = await json<FeedOut>(api("GET", "/feed", agent.own));
    expect(own.body.items.map((i) => i.item_key)).toEqual([`${repo.id}:pull/7:activity`]);
    // The delegated token reads the user's feed instead.
    const delegated = await json<FeedOut>(api("GET", "/feed", agent.delegated));
    expect(delegated.body.items.map((i) => i.item_key)).toEqual([
      `${repo.id}:pull/1:activity`,
      `${other.id}:pull/1:activity`,
    ]);
  });

  it("leave out, in lists, syncs and acknowledgements, items of a repository the caller lost access to", async () => {
    const reader = await user();
    const path = `/repos/${repo.fullName}/collaborators/${reader.handle}`;
    await api("PUT", path, owner.token, { permission: "pull" });
    await deliverTo(reader.principalId, {
      repoId: repo.id,
      kind: "review_requested",
      version: 2,
      priority: "P0",
    });
    const key = `${repo.id}:pull/1:review_requested`;
    expect(feedNames((await json<FeedOut>(api("GET", "/feed", reader.token))).body)).toEqual([
      repo.fullName,
    ]);
    expect(
      (await api("POST", "/feed/ack", reader.token, { item_key: key, version: 1 })).status,
    ).toBe(200);
    expect((await api("DELETE", path, owner.token)).status).toBe(200);
    const list = await json<FeedOut>(api("GET", "/feed", reader.token));
    expect(list.body.items).toEqual([]);
    expect((await json<FeedOut>(api("GET", "/feed/sync", reader.token))).body.items).toEqual([]);
    expect(
      await json(api("POST", "/feed/ack", reader.token, { item_key: key, version: 2 })),
    ).toMatchObject({ status: 404, body: { code: "feed_item_not_found" } });
  });

  it("acknowledge an item at a version it has", async () => {
    const key = `${repo.id}:pull/1:activity`;
    const ack = (version: number, item_key = key) =>
      json<{ acked_version: number; code?: string }>(
        api("POST", "/feed/ack", owner.token, { item_key, version }),
      );
    expect(await ack(2)).toMatchObject({ status: 409, body: { code: "version_ahead" } });
    expect(await ack(1)).toMatchObject({
      status: 200,
      body: { item_key: key, version: 1, acked_version: 1 },
    });
    expect((await ack(1, `${repo.id}:pull/1:nonsense`)).status).toBe(404);
    expect((await ack(1, "no-key")).status).toBe(404);
    // Every reader of the feed sees it: the item comes again with the acknowledgement.
    const res = await json<FeedOut>(api("GET", "/feed", owner.token));
    expect(res.body.items.at(-1)).toMatchObject({ item_key: key, acked_version: 1 });
  });

  it("answer an unchanged page 304 by its ETag, and a changed one in full", async () => {
    const first = await api("GET", "/feed", owner.token);
    const etag = first.headers.get("ETag") as string;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(first.headers.get("Cache-Control")).toBe("private, no-cache");
    const again = (tag: string) =>
      exports.default.fetch(`${ORIGIN}/api/feed`, {
        headers: { Authorization: `Bearer ${owner.token}`, "If-None-Match": tag },
      });
    const unchanged = await again(etag);
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("ETag")).toBe(etag);
    await deliverTo(owner.principalId, { repoId: repo.id, thread: 2, version: 1 });
    const changed = await again(etag);
    expect(changed.status).toBe(200);
    expect(changed.headers.get("ETag")).not.toBe(etag);
  });

  it("refuse a cursor below the low watermark or of another epoch with 410 and where to resync", async () => {
    const head = await json<FeedOut>(api("GET", "/feed", owner.token));
    const { e } = JSON.parse(
      atob(head.body.head_cursor.replaceAll("-", "+").replaceAll("_", "/")),
    ) as { e: string };
    for (const since of [
      encodeFeedCursor({ epoch: "another", seq: 1 }),
      encodeFeedCursor({ epoch: e, seq: 1_000_000 }),
    ]) {
      const res = await json<FeedOut>(api("GET", `/feed?since=${since}`, owner.token));
      expect(res).toMatchObject({
        status: 410,
        body: { code: "cursor_expired", resync: "/api/feed/sync" },
      });
    }
    expect(await json<FeedOut>(api("GET", "/feed?since=not-a-cursor", owner.token))).toMatchObject({
      status: 422,
      body: { code: "invalid_cursor" },
    });
    // Following the cursor: nothing new.
    const next = await json<FeedOut>(
      api("GET", `/feed?since=${head.body.next_cursor}`, owner.token),
    );
    expect(next.body.items).toEqual([]);
    // Sync gives the cursor to follow from.
    const synced = await json<FeedOut>(api("GET", "/feed/sync", owner.token));
    expect(synced.body.head_cursor).toBe(head.body.head_cursor);
  });

  it("show a token limited to some repositories nothing of the others: no item, cursor or ETag changes", async () => {
    const someone = await user();
    const shown = await repoOf(someone);
    const hidden = await repoOf(someone);
    await deliverTo(someone.principalId, {
      repoId: shown.id,
      kind: "review_requested",
      version: 1,
      priority: "P0",
    });
    await deliverTo(someone.principalId, {
      repoId: hidden.id,
      kind: "review_requested",
      version: 1,
      priority: "P0",
    });
    const limited = await scopedToken(someone.principalId, [], "pat", [shown.id]);
    const read = async (path: string) => {
      const res = await api("GET", path, limited);
      return {
        etag: res.headers.get("ETag"),
        body: await res.json<FeedOut & { complete?: boolean }>(),
      };
    };
    const before = { list: await read("/feed"), sync: await read("/feed/sync") };
    expect(feedNames(before.list.body)).toEqual([shown.fullName]);
    expect(feedNames(before.sync.body)).toEqual([shown.fullName]);
    expect(before.sync.body.complete).toBe(true);
    // Activity in the other repository only: the limited token's answers stay the same.
    await deliverTo(someone.principalId, { repoId: hidden.id, version: 1 });
    await deliverTo(someone.principalId, { repoId: hidden.id, thread: 2, version: 1 });
    const after = { list: await read("/feed"), sync: await read("/feed/sync") };
    expect(after.list).toEqual(before.list);
    expect(after.sync.body).toEqual(before.sync.body);
    const since = await read(`/feed?since=${before.list.body.next_cursor}`);
    expect(since.body.items).toEqual([]);
    expect(since.body.head_cursor).toBe(before.list.body.next_cursor);
    expect(since.body.poll_after_ms).toBe(FEED_POLL_AFTER_MS);
    // Its own repository's items are acknowledged; the other's are not found.
    const ack = (repoId: string) =>
      api("POST", "/feed/ack", limited, {
        item_key: `${repoId}:pull/1:review_requested`,
        version: 1,
      });
    expect((await ack(shown.id)).status).toBe(200);
    expect((await ack(hidden.id)).status).toBe(404);
    // The owner's own token sees both.
    expect(feedNames((await json<FeedOut>(api("GET", "/feed", someone.token))).body)).toHaveLength(
      4,
    );
  });

  it("continue past their budget of repository checks with a cursor", async () => {
    const someone = await user();
    const repoIds = Array.from({ length: 105 }, () => uniqueId("rep_"));
    await env.DIRECTORY.batch(
      repoIds.map((id) =>
        env.DIRECTORY.prepare(
          `INSERT INTO repos (id, owner_id, name, network_id, org_shard, visibility, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'default', 'private', 0, 0)`,
        ).bind(id, someone.principalId, id.toLowerCase(), uniqueId("net")),
      ),
    );
    await env.USER.getByName(someone.principalId).applyFeed(
      repoIds.map((repoId) => entry({ repoId, version: 1, principal: someone.principalId })),
    );
    const first = await json<FeedOut>(api("GET", "/feed?limit=100", someone.token));
    // 100 repositories checked: the rest is the next page's.
    expect(first.body.items).toHaveLength(100);
    expect(first.body.poll_after_ms).toBe(0);
    const second = await json<FeedOut>(
      api("GET", `/feed?limit=100&since=${first.body.next_cursor}`, someone.token),
    );
    expect(second.body.items.map((i) => i.repo.full_name.split("/")[1])).toEqual(
      repoIds.slice(100).map((id) => id.toLowerCase()),
    );
    expect(second.body.poll_after_ms).toBe(FEED_POLL_AFTER_MS);
  });

  it("expire cursors made before the feed's object was restored", async () => {
    const someone = await user();
    const made = await repoOf(someone);
    await deliverTo(someone.principalId, { repoId: made.id, version: 1 });
    const before = await json<FeedOut>(api("GET", "/feed", someone.token));
    // A restore: the directory allocates the feed's next generation, and the object starts again.
    await env.DIRECTORY.prepare("INSERT INTO source_epochs (source_id, epoch_gen) VALUES (?, 1)")
      .bind(`feed:${someone.principalId}`)
      .run();
    await evictDurableObject(env.USER.getByName(someone.principalId));
    const stale = await json<FeedOut>(
      api("GET", `/feed?since=${before.body.next_cursor}`, someone.token),
    );
    expect(stale).toMatchObject({ status: 410, body: { code: "cursor_expired" } });
    const fresh = await json<FeedOut>(api("GET", "/feed", someone.token));
    expect(fresh.body.items).toHaveLength(1);
    expect(fresh.body.head_cursor).not.toBe(before.body.head_cursor);
  });
});
