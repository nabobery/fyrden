// The thread inbox: a row a repository and conversation that notified the
// principal, made unread once per event, reopened by a later one, its
// reason only moving to a stronger one; notifying gated by the principal's
// acknowledged preferences; kept within a stream's cap, with fences; and
// cleaned up with the feed.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { FEED_HORIZON_MS } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it, vi } from "vitest";
import { EPOCH_READ, feedHooks, PREFERENCE_GATE, type UserDO } from "../src/do/UserDO.js";
import { FEED_POLICY, Feed, feedEpochSource, MAX_GONE_THREADS } from "../src/do/user/feed.js";
import {
  type Gate,
  INBOX_POLICY,
  OPEN_GATE,
  parseThreadId,
  threadId,
} from "../src/do/user/inbox.js";
import { WATCH_PRICE } from "../src/feed/sink.js";
import { countingExec, entry, feedIn, inFeed } from "./helpers/feed.js";

const REPO = "rep_test";
const conv = (n: number) => `conv-${n}`;

/** The inbox's rows, as the tests read them. */
const threads = (storage: DurableObjectStorage) =>
  storage.sql
    .exec<{
      id: string;
      conversation: string;
      subject: string;
      reason: string;
      unread: number;
      done: number;
    }>(
      `SELECT id, conversation, subject, reason, unread, dn_event IS NOT NULL AS done
       FROM inbox_threads ORDER BY repo_id, conversation`,
    )
    .toArray();

/** Whether every stream's counted threads are its threads (none counted for an empty one). */
const countsExact = (storage: DurableObjectStorage) =>
  storage.sql
    .exec<{ n: number }>(
      `SELECT count(*) AS n FROM (
         SELECT * FROM (
           SELECT repo_id, subject, count(*) AS threads FROM inbox_threads GROUP BY repo_id, subject
           EXCEPT SELECT repo_id, subject, threads FROM inbox_streams)
         UNION ALL
         SELECT * FROM (
           SELECT repo_id, subject, threads FROM inbox_streams
           EXCEPT SELECT repo_id, subject, count(*) FROM inbox_threads GROUP BY repo_id, subject))`,
    )
    .one().n === 0;

const comment = (n: number, version: number, extra: Parameters<typeof entry>[0] | object = {}) =>
  entry({ version, thread: n, conversation: conv(n), ...extra } as Parameters<typeof entry>[0]);

describe("the inbox", () => {
  it("makes a thread unread once per event, and keeps it read until a later event", async () => {
    await inFeed((storage) => {
      const { feed, apply } = feedIn(storage);
      apply([comment(1, 1)]);
      expect(threads(storage)).toEqual([
        {
          id: threadId(REPO, conv(1)),
          conversation: conv(1),
          subject: "pull",
          reason: "comment",
          unread: 1,
          done: 0,
        },
      ]);
      storage.transactionSync(() => feed.inbox.markRead(threadId(REPO, conv(1))));
      // The same event again, and another of its kinds: nothing new.
      apply([comment(1, 1), comment(1, 1, { kind: "mention", eventKey: "rep_test:1:1" })]);
      expect(threads(storage)[0]).toMatchObject({ unread: 0, reason: "mention" });
      // A later event: unread again.
      apply([comment(1, 2)]);
      expect(threads(storage)[0]).toMatchObject({ unread: 1, reason: "mention" });
    });
  });

  it("notifies of one event once, whichever of its contributions comes first (a settlement and its main block)", async () => {
    for (const order of ["settlement first", "main first"]) {
      await inFeed((storage) => {
        const { feed, apply } = feedIn(storage);
        apply([comment(1, 1)]);
        const id = threadId(REPO, conv(1));
        // One event: its settlement at version 2, its main block at version 3.
        const settlement = comment(1, 2, {
          eventKey: "rep_test:1:9",
          kind: "review_requested",
          state: "resolved",
        });
        const main = comment(1, 3, { eventKey: "rep_test:1:9" });
        const [first, second] =
          order === "settlement first" ? [settlement, main] : [main, settlement];
        apply([first]);
        storage.transactionSync(() => feed.inbox.markDone(id));
        apply([second]);
        expect(threads(storage)[0], order).toMatchObject({ unread: 0, done: 1 });
        // A later event reopens it.
        apply([comment(1, 4)]);
        expect(threads(storage)[0], order).toMatchObject({ unread: 1, done: 0 });
      });
    }
  });

  it("moves a thread's reason only to a stronger one", async () => {
    await inFeed((storage) => {
      const { apply } = feedIn(storage);
      apply([comment(1, 1, { reasons: ["watching"], priority: "P2" })]);
      expect(threads(storage)[0]?.reason).toBe("subscribed");
      apply([comment(1, 2)]);
      expect(threads(storage)[0]?.reason).toBe("comment");
      apply([comment(1, 3, { kind: "mention" })]);
      apply([comment(1, 4)]);
      apply([comment(1, 5, { reasons: ["watching"], priority: "P2" })]);
      expect(threads(storage)[0]?.reason).toBe("mention");
    });
  });

  it("lets a silent entry move what a thread has seen, so another event's older entry does not notify", async () => {
    await inFeed((storage) => {
      const { feed, apply } = feedIn(storage);
      apply([comment(1, 5)]);
      storage.transactionSync(() => feed.inbox.markRead(threadId(REPO, conv(1))));
      // A restore's newer generation, silent (the principal's own state change).
      apply([comment(1, 1, { epochGen: 2, silent: true })]);
      // A late entry of the older generation.
      apply([comment(1, 6, { epochGen: 1 })]);
      expect(threads(storage)[0]).toMatchObject({ unread: 0 });
    });
  });

  it("makes no thread of a silent entry, nor of one made before conversations were stamped", async () => {
    await inFeed((storage) => {
      const { apply } = feedIn(storage);
      apply([comment(1, 1, { silent: true }), entry({ version: 1, thread: 2 })]);
      expect(threads(storage)).toEqual([]);
    });
  });
});

describe("the preference gate", () => {
  const gate = (g: Partial<{ ignored: string[]; unsubscribed: string[] }>): Gate => ({
    ignored: new Set(g.ignored ?? []),
    unsubscribed: new Set((g.unsubscribed ?? []).map((c) => `${REPO}\n${c}`)),
  });

  it("keeps an ignored repository's threads from notifying, mentions included", async () => {
    await inFeed((storage) => {
      const feed = new Feed(storage.sql, Date.now);
      storage.transactionSync(() =>
        feed.apply([comment(1, 1), comment(2, 1, { kind: "mention" })], gate({ ignored: [REPO] })),
      );
      expect(threads(storage)).toEqual([]);
      // The feed's items apply as ever.
      expect(storage.sql.exec("SELECT count(*) AS n FROM feed_items").one().n).toBe(2);
    });
  });

  it("keeps an unsubscribed thread's activity from notifying, but not what names the principal", async () => {
    await inFeed((storage) => {
      const feed = new Feed(storage.sql, Date.now);
      const unsubscribed = gate({ unsubscribed: [conv(1)] });
      storage.transactionSync(() => feed.apply([comment(1, 1)], unsubscribed));
      expect(threads(storage)).toEqual([]);
      storage.transactionSync(() => feed.apply([comment(1, 2, { kind: "mention" })], unsubscribed));
      expect(threads(storage)).toMatchObject([{ reason: "mention", unread: 1 }]);
      storage.transactionSync(() => feed.inbox.markRead(threadId(REPO, conv(1))));
      // Its later activity: state only.
      storage.transactionSync(() => feed.apply([comment(1, 3)], unsubscribed));
      expect(threads(storage)).toMatchObject([{ unread: 0 }]);
    });
  });

  it("reads the principal's acknowledged preferences from the directory before applying", async () => {
    const principal = uniqueId("usr");
    const repoId = uniqueId("rep");
    await env.DIRECTORY.prepare(
      `INSERT INTO watch_preferences (principal_id, repo_id, root_id, level, revision, epoch_gen, at)
       VALUES (?, ?, ?, 'ignoring', 1, 1, 0)`,
    )
      .bind(principal, repoId, principal)
      .run();
    const stub = env.USER.getByName(principal);
    await stub.applyFeed([
      entry({ version: 1, thread: 1, conversation: "c1", repoId, principal, kind: "mention" }),
    ]);
    const other = uniqueId("rep");
    await stub.applyFeed([
      entry({ version: 1, thread: 1, conversation: "c1", repoId: other, principal }),
    ]);
    const rows = await runInDurableObject(stub, (_: UserDO, state) => threads(state.storage));
    expect(rows.map((r) => r.id)).toEqual([threadId(other, "c1")]);
  });

  it("fails the call when the preferences cannot be read, applying nothing", async () => {
    const stub = env.USER.getByName(uniqueId("usr"));
    // Warm: its epoch read done.
    await stub.applyFeed([]);
    // Asked inside the object: a refusal across RPC is also reported as unhandled there.
    const n = await runInDurableObject(stub, async (instance: UserDO, state) => {
      feedHooks.beforePreferenceRead = async () => {
        throw new Error("the directory is down");
      };
      try {
        await expect(
          instance.applyFeed([entry({ version: 1, thread: 1, conversation: "c1" })]),
        ).rejects.toThrow("the directory is down");
      } finally {
        delete feedHooks.beforePreferenceRead;
      }
      return state.storage.sql.exec("SELECT count(*) AS n FROM feed_items").one().n;
    });
    expect(n).toBe(0);
  });

  it("decides windows after the read, with nothing awaited before the write", async () => {
    const stub = env.USER.getByName(uniqueId("usr"));
    await stub.applyFeed([]);
    const until = Date.now() + 1_000;
    // Held past the window.
    feedHooks.beforePreferenceRead = async () => {
      vi.setSystemTime(until);
    };
    try {
      expect(
        await stub.applyFeed([
          { ...entry({ version: 1, thread: 1, conversation: "c1", priority: "P2" }), until },
        ]),
      ).toEqual({ changed: 0, notified: 0, expired: ["rep_test:1:1"] });
    } finally {
      delete feedHooks.beforePreferenceRead;
    }
  });

  it("writes nothing when the feed is retired while its preferences are read", async () => {
    const stub = env.USER.getByName(uniqueId("usr"));
    await stub.applyFeed([]);
    const written = await runInDurableObject(stub, async (instance: UserDO, state) => {
      feedHooks.beforePreferenceRead = () => instance.retire();
      try {
        expect(
          await instance.applyFeed([entry({ version: 1, thread: 1, conversation: "c1" })]),
        ).toEqual({ changed: 0, notified: 0 });
      } finally {
        delete feedHooks.beforePreferenceRead;
      }
      return [
        state.storage.sql.exec("SELECT count(*) AS n FROM feed_items").one().n,
        state.storage.sql.exec("SELECT count(*) AS n FROM inbox_threads").one().n,
      ];
    });
    expect(written).toEqual([0, 0]);
  });
});

describe("a stream's cap", () => {
  it("evicts its least recently updated thread, never another stream's, and fences it", async () => {
    await inFeed((storage) => {
      let now = Date.now();
      const { feed } = feedIn(storage, () => now);
      const apply = (es: ReturnType<typeof entry>[]) =>
        storage.transactionSync(() => feed.apply(es));
      // Another repository's stream, and the issues of this one.
      apply([entry({ version: 1, thread: 1, conversation: "other", repoId: "rep_other" })]);
      apply([entry({ version: 1, thread: 9_000, subject: "issue", conversation: "issue" })]);
      for (let n = 1; n <= INBOX_POLICY.streamThreads; n++) {
        now += 1;
        apply([comment(n, 1, { occurredAt: now })]);
      }
      now += 1;
      apply([comment(10_000, 1, { occurredAt: now })]);
      const ids = new Set(threads(storage).map((t) => t.conversation));
      expect(ids.has(conv(1))).toBe(false);
      expect(ids.has(conv(2))).toBe(true);
      expect(ids.size).toBe(INBOX_POLICY.streamThreads + 2);
      expect(ids.has("other") && ids.has("issue")).toBe(true);
      // A late older entry of the evicted thread stays out; a newer one comes back.
      apply([comment(1, 1, { occurredAt: now })]);
      expect(new Set(threads(storage).map((t) => t.conversation)).has(conv(1))).toBe(false);
      // Many evictions in a row: the stream stays at its cap, counted exactly.
      for (let n = 20_000; n < 20_300; n++) {
        now += 1;
        apply([comment(n, 1, { occurredAt: now })]);
      }
      expect(
        storage.sql
          .exec(
            "SELECT count(*) AS n FROM inbox_threads WHERE repo_id = ? AND subject = 'pull'",
            REPO,
          )
          .one().n,
      ).toBe(INBOX_POLICY.streamThreads);
      expect(countsExact(storage)).toBe(true);
      now += 1;
      apply([comment(1, 2, { occurredAt: now })]);
      expect(new Set(threads(storage).map((t) => t.conversation)).has(conv(1))).toBe(true);
    });
  });
});

describe("the inbox's cleanup", () => {
  it("goes with the feed's: purges, retention and retirement", async () => {
    await inFeed((storage) => {
      let now = Date.now();
      const { feed, apply } = feedIn(storage, () => now);
      apply([
        comment(1, 1, { occurredAt: now }),
        comment(2, 1, { occurredAt: now, repoId: "rep_b" }),
      ]);
      storage.transactionSync(() =>
        feed.purge({ repoIds: ["rep_b"], until: now, accountId: "", epochGen: 1, aclVersion: 1 }),
      );
      expect(threads(storage).map((t) => t.conversation)).toEqual([conv(1)]);
      expect(countsExact(storage)).toBe(true);
      now += FEED_HORIZON_MS + 1;
      while (storage.transactionSync(() => feed.retainStep()));
      expect(threads(storage)).toEqual([]);
      expect(countsExact(storage)).toBe(true);
      expect(storage.sql.exec("SELECT count(*) AS n FROM inbox_streams").one().n).toBe(0);
      expect(feed.nextRetention()).toBeNull();
      apply([comment(3, 1, { occurredAt: now })]);
      expect(feed.nextRetention()).toBe(now + FEED_HORIZON_MS);
      apply([comment(4, 1, { occurredAt: now, repoId: "rep_c" })]);
      while (storage.transactionSync(() => feed.retireStep()))
        expect(countsExact(storage)).toBe(true);
      expect(threads(storage)).toEqual([]);
      expect(storage.sql.exec("SELECT count(*) AS n FROM inbox_streams").one().n).toBe(0);
    });
  });

  it("forgets a gone thread's rows of its generation, not a later conversation's", async () => {
    await inFeed((storage) => {
      const { feed, apply } = feedIn(storage);
      apply([comment(1, 1, { epochGen: 1 })]);
      apply([entry({ version: 1, thread: 1, conversation: "replacement", epochGen: 2 })]);
      storage.transactionSync(() =>
        feed.forgetThreads([{ repoId: REPO, threadKey: "pull/1", epoch: 1 }]),
      );
      expect(threads(storage).map((t) => t.conversation)).toEqual(["replacement"]);
      expect(countsExact(storage)).toBe(true);
    });
  });
});

describe("a thread id", () => {
  it("names its repository and conversation, reversibly, and nothing else", () => {
    const id = threadId("rep_01K", "legacy:7:1760000000000");
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parseThreadId(id)).toEqual({
      repoId: "rep_01K",
      conversation: "legacy:7:1760000000000",
    });
    for (const bad of ["", "!", "cmVwXzAx", `${id}A`, "a".repeat(401)])
      expect(parseThreadId(bad), bad).toBeUndefined();
    expect(OPEN_GATE.ignored.size).toBe(0);
  });
});

describe("an inbox's cost", () => {
  it("reads about a stream's rows for a new thread, whatever other streams it holds", async () => {
    await inFeed((storage) => {
      const { feed, apply } = feedIn(storage);
      for (let r = 0; r < 1_000; r++)
        apply([entry({ version: 1, thread: 1, conversation: "c", repoId: `rep_${r}` })]);
      const counting = countingExec(storage.sql);
      storage.transactionSync(() => feed.inbox.take(comment(1, 1), OPEN_GATE));
      expect(counting.stop().read).toBeLessThan(30);
    });
  });

  it("reads a cold recipient's directory rows within a watched entry's price, its preferences set", async () => {
    const principal = uniqueId("usr");
    await env.DIRECTORY.batch([
      env.DIRECTORY.prepare(
        `INSERT INTO watch_preferences (principal_id, repo_id, root_id, level, revision, epoch_gen, at)
         VALUES (?1, 'rep_1', ?1, 'ignoring', 1, 1, 0)`,
      ).bind(principal),
      env.DIRECTORY.prepare(
        `INSERT INTO thread_preferences (principal_id, repo_id, conversation, number, kind,
           root_id, state, revision, epoch_gen, at)
         VALUES (?1, 'rep_1', 'c1', 1, 'issue', ?1, 'unsubscribed', 1, 1, 0)`,
      ).bind(principal),
    ]);
    const gate = await env.DIRECTORY.prepare(PREFERENCE_GATE)
      .bind(principal, JSON.stringify(["rep_1"]), JSON.stringify([["rep_1", "c1"]]))
      .all();
    expect(gate.results).toHaveLength(2);
    const epoch = await env.DIRECTORY.prepare(EPOCH_READ)
      .bind(feedEpochSource(principal), principal)
      .all();
    expect(gate.meta.rows_read + epoch.meta.rows_read).toBeLessThanOrEqual(
      WATCH_PRICE.recipient.d1_rows_read,
    );
  });

  it("looks a principal's preferences up by key, not through its other ones", async () => {
    const principal = uniqueId("usr");
    const statements = Array.from({ length: 1_000 }, (_, i) =>
      env.DIRECTORY.prepare(
        `INSERT INTO thread_preferences (principal_id, repo_id, conversation, number, kind,
           root_id, state, revision, epoch_gen, at)
         VALUES (?, ?, ?, ?, 'issue', ?, 'unsubscribed', 1, 1, 0)`,
      ).bind(principal, `rep_${i % 10}`, `c${i}`, i + 1, principal),
    );
    await env.DIRECTORY.batch(statements);
    const { meta, results } = await env.DIRECTORY.prepare(PREFERENCE_GATE)
      .bind(principal, JSON.stringify(["rep_3"]), JSON.stringify([["rep_3", "c3"]]))
      .all();
    expect(results).toEqual([{ repo_id: "rep_3", conversation: "c3" }]);
    expect(meta.rows_read).toBeLessThan(10);
  });
});

describe("the inbox's own checks", () => {
  it("count a stream's threads exactly: a missing, surplus or wrong count is found", async () => {
    await inFeed((storage) => {
      const { apply } = feedIn(storage);
      apply([comment(1, 1), comment(2, 1)]);
      expect(countsExact(storage)).toBe(true);
      storage.sql.exec("UPDATE inbox_streams SET threads = 3");
      expect(countsExact(storage)).toBe(false);
      storage.sql.exec("DELETE FROM inbox_streams");
      expect(countsExact(storage)).toBe(false);
      storage.sql.exec(
        "INSERT INTO inbox_streams VALUES ('rep_test', 'pull', 2), ('rep_x', 'issue', 1)",
      );
      expect(countsExact(storage)).toBe(false);
    });
  });
});

describe("what an inbox thread guards against", () => {
  it("outlives its eviction: another contribution of the event that notified it does not bring it back", async () => {
    await inFeed((storage) => {
      let now = Date.now();
      const { feed } = feedIn(storage, () => now);
      const apply = (es: ReturnType<typeof entry>[]) =>
        storage.transactionSync(() => feed.apply(es));
      // A settlement at version 2 notifies thread 1, which is marked done.
      apply([
        comment(1, 2, { eventKey: "rep_test:1:9", kind: "review_requested", occurredAt: now }),
      ]);
      storage.transactionSync(() => feed.inbox.markDone(threadId(REPO, conv(1))));
      // The stream fills: thread 1 is evicted.
      for (let n = 2; n <= INBOX_POLICY.streamThreads + 1; n++) {
        now += 1;
        apply([comment(n, 1, { occurredAt: now })]);
      }
      expect(threads(storage).some((t) => t.conversation === conv(1))).toBe(false);
      // A slot frees (another thread forgotten), then the event's main block at version 3 arrives.
      storage.transactionSync(() =>
        feed.forgetThreads([{ repoId: REPO, threadKey: "pull/2", epoch: 1 }]),
      );
      apply([comment(1, 3, { eventKey: "rep_test:1:9", occurredAt: now })]);
      expect(threads(storage).some((t) => t.conversation === conv(1))).toBe(false);
    });
  });

  it("lasts as long as the feed keeps what reached it last: a silent update keeps a late older event from notifying", async () => {
    await inFeed((storage) => {
      const day = 24 * 60 * 60 * 1000;
      const t0 = Date.now();
      let now = t0;
      const { feed } = feedIn(storage, () => now);
      const apply = (es: ReturnType<typeof entry>[]) =>
        storage.transactionSync(() => feed.apply(es));
      apply([comment(1, 1, { occurredAt: t0 })]);
      storage.transactionSync(() => feed.inbox.markRead(threadId(REPO, conv(1))));
      // Day 6: a silent update (version 3). Just past day 7: retention.
      now = t0 + 6 * day;
      apply([comment(1, 3, { occurredAt: now, silent: true })]);
      now = t0 + FEED_HORIZON_MS + 1;
      while (storage.transactionSync(() => feed.retainStep()));
      // Version 2, from day 5, arrives late: the feed still knows version 3.
      apply([comment(1, 2, { occurredAt: t0 + 5 * day })]);
      expect(threads(storage).filter((t) => t.unread === 1)).toEqual([]);
    });
  });

  it("forgets a gone number's threads within a call's bound, its restored identities included", async () => {
    await inFeed((storage) => {
      const { feed, apply } = feedIn(storage);
      const kinds = [
        "review_requested",
        "changes_requested",
        "approved",
        "merge_conflict",
        "assigned",
        "mention",
        "activity",
      ] as const;
      // Each number: all seven feed kinds, and three conversations a restore gave it.
      for (let n = 1; n <= MAX_GONE_THREADS; n++) {
        apply(kinds.map((kind) => entry({ version: 1, thread: n, kind, conversation: `c${n}a` })));
        apply([entry({ version: 1, thread: n, conversation: `c${n}b`, epochGen: 2 })]);
        apply([entry({ version: 1, thread: n, conversation: `c${n}c`, epochGen: 3 })]);
      }
      const rows = () =>
        Number(storage.sql.exec("SELECT count(*) AS n FROM feed_items").one().n) +
        Number(storage.sql.exec("SELECT count(*) AS n FROM inbox_threads").one().n);
      const before = rows();
      storage.transactionSync(() =>
        feed.forgetThreads(
          Array.from({ length: MAX_GONE_THREADS }, (_, i) => ({
            repoId: REPO,
            threadKey: `pull/${i + 1}`,
            epoch: 3,
          })),
        ),
      );
      // A call's deletions stay under a step's.
      expect(before - rows()).toBeLessThan(FEED_POLICY.sliceRows);
      expect(before - rows()).toBeGreaterThan(MAX_GONE_THREADS * 7);
      // Two identities a number went; the third is left for later.
      expect(threads(storage)).toHaveLength(MAX_GONE_THREADS);
      expect(countsExact(storage)).toBe(true);
    });
  });
});

describe("what the feed knows of a thread", () => {
  /** A stream filled past its cap after `first`, so `first`'s thread is evicted, then a slot freed. */
  const evict = (storage: DurableObjectStorage, feed: Feed, now: { at: number }) => {
    for (let n = 100; n < 100 + INBOX_POLICY.streamThreads; n++) {
      now.at += 1;
      storage.transactionSync(() => feed.apply([comment(n, 1, { occurredAt: now.at })]));
    }
    expect(threads(storage).some((t) => t.conversation === conv(1))).toBe(false);
    storage.transactionSync(() =>
      feed.forgetThreads([{ repoId: REPO, threadKey: "pull/100", epoch: 1 }]),
    );
  };

  it("keeps an evicted thread from coming back for an event older than a silent one after it", async () => {
    await inFeed((storage) => {
      const now = { at: Date.now() };
      const { feed } = feedIn(storage, () => now.at);
      storage.transactionSync(() => feed.apply([comment(1, 1, { occurredAt: now.at })]));
      evict(storage, feed, now);
      storage.transactionSync(() =>
        feed.apply([comment(1, 3, { occurredAt: now.at, silent: true })]),
      );
      storage.transactionSync(() => feed.apply([comment(1, 2, { occurredAt: now.at })]));
      expect(threads(storage).some((t) => t.conversation === conv(1))).toBe(false);
    });
  });

  it("lets an event that has not notified yet notify an evicted thread (a mention after suppressed activity)", async () => {
    await inFeed((storage) => {
      const now = { at: Date.now() };
      const { feed } = feedIn(storage, () => now.at);
      storage.transactionSync(() => feed.apply([comment(1, 1, { occurredAt: now.at })]));
      storage.transactionSync(() => feed.inbox.markDone(threadId(REPO, conv(1))));
      // Event B's activity, suppressed (unsubscribed); then the thread is evicted.
      const unsubscribed: Gate = {
        ignored: new Set(),
        unsubscribed: new Set([`${REPO}\n${conv(1)}`]),
      };
      storage.transactionSync(() =>
        feed.apply([comment(1, 2, { eventKey: "rep_test:1:b", occurredAt: now.at })], unsubscribed),
      );
      evict(storage, feed, now);
      // B's mention of the principal: it notifies.
      storage.transactionSync(() =>
        feed.apply(
          [comment(1, 2, { eventKey: "rep_test:1:b", kind: "mention", occurredAt: now.at })],
          unsubscribed,
        ),
      );
      expect(threads(storage).find((t) => t.conversation === conv(1))).toMatchObject({
        unread: 1,
        reason: "mention",
      });
    });
  });

  it("outlives a late purge: what the feed still knows past its cutoff keeps an older event from notifying", async () => {
    await inFeed((storage) => {
      const t0 = Date.now() - 1_000;
      const { feed, apply } = feedIn(storage);
      apply([comment(1, 1, { occurredAt: t0 + 100 })]);
      storage.transactionSync(() => feed.inbox.markRead(threadId(REPO, conv(1))));
      apply([comment(1, 3, { occurredAt: t0 + 300, silent: true })]);
      storage.transactionSync(() =>
        feed.purge({ repoIds: [REPO], until: t0 + 200, accountId: "", epochGen: 1, aclVersion: 1 }),
      );
      apply([comment(1, 2, { occurredAt: t0 + 250 })]);
      expect(threads(storage).filter((t) => t.unread === 1)).toEqual([]);
    });
  });
});

describe("a thread read or done where the feed's thread stands", () => {
  for (const evicted of [false, true])
    it(`stays read and done for a later contribution of an event it had seen${evicted ? ", its feed item since evicted to a fence" : ""}`, async () => {
      await inFeed((storage) => {
        let now = Date.now();
        const { feed } = feedIn(storage, () => now);
        const apply = (es: ReturnType<typeof entry>[], gate?: Gate) =>
          storage.transactionSync(() => feed.apply(es, gate));
        // Event A notifies thread 1.
        apply([comment(1, 1, { eventKey: "rep_test:1:a", occurredAt: now })]);
        // Event B's settlement (version 2), its repository ignored: state only, a tombstone.
        const ignored: Gate = { ignored: new Set([REPO]), unsubscribed: new Set() };
        apply(
          [
            comment(1, 2, {
              eventKey: "rep_test:1:b",
              kind: "review_requested",
              state: "resolved",
              occurredAt: now,
            }),
          ],
          ignored,
        );
        if (evicted)
          // Newer tombstones of other threads push it out of the stream: a fence keeps it.
          for (let n = 1_000; n < 1_001 + 500; n++) {
            now += 1;
            apply([
              comment(n, 1, {
                kind: "review_requested",
                state: "resolved",
                silent: true,
                occurredAt: now,
              }),
            ]);
          }
        expect(
          storage.sql
            .exec("SELECT count(*) AS n FROM feed_evictions WHERE thread_key = 'pull/1'")
            .one().n,
        ).toBe(evicted ? 1 : 0);
        storage.transactionSync(() => feed.inbox.markDone(threadId(REPO, conv(1))));
        // B's main block (version 3), the repository no longer ignored.
        apply([comment(1, 3, { eventKey: "rep_test:1:b", occurredAt: now })]);
        expect(threads(storage).find((t) => t.conversation === conv(1))).toMatchObject({
          unread: 0,
          done: 1,
        });
      });
    });
});

describe("entries delivered together", () => {
  it("notify as they would delivered apart, in either order", async () => {
    const histories = [
      [comment(1, 1, { kind: "mention" }), comment(1, 2)],
      [comment(1, 1), comment(1, 2, { silent: true })],
    ];
    for (const history of histories)
      for (const together of [false, true])
        for (const reversed of [false, true]) {
          const outcome = await inFeed((storage) => {
            const { apply } = feedIn(storage);
            const entries = reversed ? [...history].reverse() : history;
            if (together) apply(entries);
            else for (const e of history) apply([e]);
            return threads(storage).map(({ reason, unread }) => ({ reason, unread }));
          });
          expect(outcome, JSON.stringify({ together, reversed })).toEqual([
            { reason: history[0]?.recipient.kind === "mention" ? "mention" : "comment", unread: 1 },
          ]);
        }
  });
});
