// A deleted principal's feed: retired, it holds nothing and takes nothing
// (a late entry or purge is answered as delivered, changing nothing), and a
// feed object restored from before its retirement retires itself on its
// first call, the directory saying the principal is being deleted.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { FeedEntry } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import { feedHooks, type UserDO } from "../src/do/UserDO.js";
import type { Effect } from "../src/effects/journal.js";
import { feedSink } from "../src/feed/sink.js";
import { user } from "./helpers/api.js";
import { FROM_START, feedIn, shownCount } from "./helpers/feed.js";

function entry(principal: string, version: number): FeedEntry {
  const repoId = "rep_feedretire";
  return {
    eventKey: `${repoId}:1:${version}`,
    repoId,
    occurredAt: Date.now(),
    actor: "usr_actor",
    epochGen: 1,
    feed: {
      threadKey: "pull/1",
      subject: { kind: "pull", number: 1, title: "A pull request", version },
      action: "comment",
      actorRoot: "usr_actor",
      actorTrust: "write",
      member: `comment/${version}`,
      excerpt: null,
    },
    recipient: {
      principal,
      kind: "activity",
      reasons: ["commenter"],
      priority: "P1",
      state: "open",
      silent: false,
    },
  };
}

const rows = (stub: DurableObjectStub<UserDO>) =>
  runInDurableObject(stub, (_: UserDO, state) => {
    const n = (table: string) =>
      state.storage.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).one().n;
    return { items: n("feed_items"), marks: n("purge_marks"), retired: n("feed_retired") };
  });

/** The feed's rows, counter, retirement and alarm. */
const state = (stub: DurableObjectStub<UserDO>) =>
  runInDurableObject(stub, async (_: UserDO, storage) => {
    const n = (table: string) =>
      storage.storage.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).one().n;
    return {
      items: n("feed_items"),
      marks: n("purge_marks"),
      evictions: n("feed_evictions"),
      counted: shownCount(storage.storage),
      retired: n("feed_retired"),
      retiredAt:
        storage.storage.sql.exec<{ at: number }>("SELECT at FROM feed_retired").toArray()[0]?.at ??
        null,
      alarm: (await storage.storage.getAlarm()) !== null,
    };
  });

/** Runs the feed's alarm until none is set: its cleanup done, a step at a time. */
async function cleaned(stub: DurableObjectStub<UserDO>): Promise<number> {
  let alarms = 0;
  while (await runDurableObjectAlarm(stub)) alarms++;
  return alarms;
}

const markDeleting = (principalId: string) =>
  env.DIRECTORY.prepare(
    `UPDATE principals SET lifecycle = 'deleting', disabled_at = ?2,
       lifecycle_gen = lifecycle_gen + 1 WHERE id = ?1`,
  )
    .bind(principalId, Date.now())
    .run();

const purge = (repoId: string) => ({
  repoIds: [repoId],
  until: Date.now(),
  accountId: "org_feedretire",
  epochGen: 1,
  aclVersion: 2,
});

describe("a retired feed", () => {
  it("holds nothing, and takes no entry or purge, answered as delivered", async () => {
    const who = await user();
    const stub = env.USER.getByName(who.principalId);
    expect(await stub.applyFeed([entry(who.principalId, 1)])).toMatchObject({ changed: 1 });
    // A purge mark, an eviction fence and the retention alarm, all to go.
    expect(await stub.purge(purge("rep_marked"))).toEqual({ deleted: 0 });
    await runInDurableObject(stub, (_: UserDO, state) =>
      state.storage.sql.exec(
        `INSERT INTO feed_evictions (repo_id, thread_key, kind, thread_epoch, version, event_at)
         VALUES ('rep_evicted', 'pull/2', 'activity', 1, 1, 1)`,
      ),
    );
    expect(await state(stub)).toMatchObject({ items: 1, marks: 1, evictions: 1, counted: 1 });
    expect(await state(stub)).toMatchObject({ alarm: true });
    await stub.retire();
    // Retired at once: it reads as empty and takes nothing; its rows go from its alarm.
    expect(await state(stub)).toMatchObject({ retired: 1, alarm: true });
    const empty = await stub.listStreams(FROM_START, 10, {});
    expect(empty.expired ? [] : empty.items).toEqual([]);
    expect(await cleaned(stub)).toBeGreaterThan(0);
    const retiredAt = await state(stub);
    expect(retiredAt).toMatchObject({
      items: 0,
      marks: 0,
      evictions: 0,
      counted: 0,
      retired: 1,
      alarm: false,
    });
    // Again: nothing changes.
    await stub.retire();
    expect(await cleaned(stub)).toBeGreaterThanOrEqual(0);
    expect(await state(stub)).toEqual(retiredAt);
    expect(await rows(stub)).toEqual({ items: 0, marks: 0, retired: 1 });
    expect(await stub.applyFeed([entry(who.principalId, 2)])).toEqual({ changed: 0, notified: 0 });
    expect(await stub.purge(purge("rep_feedretire"))).toEqual({ deleted: 0 });
    expect(await stub.forgetRepos([purge("rep_other")])).toEqual({ deleted: 0 });
    expect(await rows(stub)).toEqual({ items: 0, marks: 0, retired: 1 });
    // Its reads show nothing.
    const page = await stub.listStreams(FROM_START, 10, {});
    expect(page.expired ? [] : page.items).toEqual([]);
  });

  it("retires itself when restored from before its retirement, on its first call", async () => {
    const who = await user();
    const stub = env.USER.getByName(who.principalId);
    expect(await stub.applyFeed([entry(who.principalId, 1)])).toMatchObject({ changed: 1 });
    // The principal's deletion began; the feed object is as a backup left it, in a new instance.
    await markDeleting(who.principalId);
    await runInDurableObject(stub, (_: UserDO, state) => state.abort("restore")).catch(() => {});
    const restored = env.USER.getByName(who.principalId);
    expect(await restored.applyFeed([entry(who.principalId, 2)])).toEqual({
      changed: 0,
      notified: 0,
    });
    await cleaned(restored);
    expect(await rows(restored)).toEqual({ items: 0, marks: 0, retired: 1 });
  });

  it("is retired by any call that comes first after a restore", async () => {
    for (const first of [
      (feed: DurableObjectStub<UserDO>) =>
        feed.forgetGoneThreads([{ repoId: "rep_x", threadKey: "pull/1", epoch: 1 }]),
      (feed: DurableObjectStub<UserDO>) =>
        feed.ackFeed(
          { repoId: "rep_feedretire", threadKey: "pull/1", kind: "activity" },
          { epoch: 1, version: 1 },
        ),
      (feed: DurableObjectStub<UserDO>) => feed.listStreams(FROM_START, 10, {}),
    ]) {
      const who = await user();
      const stub = env.USER.getByName(who.principalId);
      await stub.applyFeed([entry(who.principalId, 1)]);
      await markDeleting(who.principalId);
      await runInDurableObject(stub, (_: UserDO, s) => s.abort("restore")).catch(() => {});
      const restored = env.USER.getByName(who.principalId);
      await first(restored);
      await cleaned(restored);
      expect(await rows(restored)).toEqual({ items: 0, marks: 0, retired: 1 });
    }
  });

  it("keeps its retention alarm while the directory cannot be reached", async () => {
    const who = await user();
    const stub = env.USER.getByName(who.principalId);
    await stub.applyFeed([entry(who.principalId, 1)]);
    await runInDurableObject(stub, (_: UserDO, s) => s.abort("cold")).catch(() => {});
    const cold = env.USER.getByName(who.principalId);
    // The alarm firing: no longer scheduled while it runs.
    await runInDurableObject(cold, (_: UserDO, s) => s.storage.deleteAlarm());
    feedHooks.beforeEpochRead = () => Promise.reject(new Error("the directory is down"));
    try {
      await runInDurableObject(cold, (instance: UserDO) => instance.alarm());
    } finally {
      delete feedHooks.beforeEpochRead;
    }
    expect(await state(cold)).toMatchObject({ alarm: true, items: 1 });
  });

  it("is answered as delivered by the sink, while the event reaches its other recipients", async () => {
    const live = await user();
    const gone = await user();
    await env.USER.getByName(gone.principalId).retire();
    const { recipient: _recipient, feed, ...event } = entry(live.principalId, 1);
    const recipient = (principal: string) => ({ ...entry(principal, 1).recipient });
    const effect = {
      id: uniqueId("eff"),
      payload: {
        ...event,
        feed: { ...feed, audience: [recipient(live.principalId), recipient(gone.principalId)] },
      },
    } as unknown as Effect;
    await feedSink.deliver(effect, env, env.ORG_READ);
    expect((await rows(env.USER.getByName(live.principalId))).items).toBe(1);
    expect(await rows(env.USER.getByName(gone.principalId))).toEqual({
      items: 0,
      marks: 0,
      retired: 1,
    });
  });

  it("is retired by its alarm too, when that is its first call", async () => {
    const who = await user();
    const stub = env.USER.getByName(who.principalId);
    await stub.applyFeed([entry(who.principalId, 1)]);
    await markDeleting(who.principalId);
    await runInDurableObject(stub, (_: UserDO, state) => state.abort("restore")).catch(() => {});
    const restored = env.USER.getByName(who.principalId);
    await runInDurableObject(restored, (instance: UserDO) => instance.alarm());
    expect(await rows(restored)).toEqual({ items: 0, marks: 0, retired: 1 });
  });

  it("is emptied over several alarms, gated all along, its cleanup surviving eviction and a second retire", async () => {
    const who = await user();
    const stub = env.USER.getByName(who.principalId);
    // 2,600 items: more than one alarm's four steps of 500 (in six repositories, within each
    // one's cap).
    await runInDurableObject(stub, (_: UserDO, state) => {
      const { apply } = feedIn(state.storage);
      apply(
        Array.from({ length: 2_600 }, (_, i) => ({
          ...entry(who.principalId, 1),
          repoId: `rep_feedretire${i % 6}`,
          eventKey: `rep_feedretire:${i}:1`,
          feed: { ...entry(who.principalId, 1).feed, threadKey: `pull/${i + 1}` },
        })),
      );
    });
    await stub.retire();
    const gated = async (feed: DurableObjectStub<UserDO>) => {
      expect(await feed.applyFeed([entry(who.principalId, 9)])).toEqual({
        changed: 0,
        notified: 0,
      });
      const page = await feed.listStreams(FROM_START, 10, {});
      expect(page.expired ? [] : page.items).toEqual([]);
      expect((await feed.syncStreams(null, 10, {})).items).toEqual([]);
      expect(
        await feed.ackFeed(
          { repoId: "rep_feedretire", threadKey: "pull/1", kind: "activity" },
          { epoch: 1, version: 1 },
        ),
      ).toEqual({ status: "missing" });
    };
    await gated(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await state(stub)).items).toBe(600);
    // Evicted, and retired again, between alarms: the cleanup goes on from storage.
    await runInDurableObject(stub, (_: UserDO, s) => s.abort("evict")).catch(() => {});
    const again = env.USER.getByName(who.principalId);
    await again.retire();
    expect(await state(again)).toMatchObject({ items: 600, alarm: true });
    await gated(again);
    await cleaned(again);
    expect(await state(again)).toMatchObject({ items: 0, retired: 1, alarm: false });
  });

  it("is retired, and emptied, by its alarm when that runs first after a restore", async () => {
    const who = await user();
    const stub = env.USER.getByName(who.principalId);
    await stub.applyFeed([entry(who.principalId, 1)]);
    await markDeleting(who.principalId);
    await runInDurableObject(stub, (_: UserDO, state) => state.abort("restore")).catch(() => {});
    const restored = env.USER.getByName(who.principalId);
    // Its retention alarm, set before the restore, fires first.
    expect(await runDurableObjectAlarm(restored)).toBe(true);
    await cleaned(restored);
    expect(await state(restored)).toMatchObject({ items: 0, retired: 1, alarm: false });
  });

  it("of a principal the directory does not know takes entries as before", async () => {
    const stub = env.USER.getByName(`usr_${uniqueId("ghost").replace(/[^a-z0-9]/gi, "")}`);
    expect(await stub.applyFeed([entry("usr_unknown", 1)])).toMatchObject({ changed: 1 });
  });
});
