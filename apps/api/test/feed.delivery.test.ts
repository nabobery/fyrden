// Activity feed entries reaching feeds: the feed sink plans one effect per
// event that names recipients, and delivers a batch of effects with one
// call per recipient; the dispatcher hands a batch sink every effect it
// claimed at once, retries only what was not delivered, and an invocation
// stays within Free's D1 queries.

import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  createIdFactory,
  type DomainEvent,
  type Envelope,
  type FeedBlock,
  type FeedEntry,
  secureRandomBytes,
} from "@fyrden/domain";
import { describe, expect, it } from "vitest";
import { sweepEffects } from "../src/effects/dispatcher.js";
import {
  EFFECT_POLICY,
  type EffectSink,
  INLINE_BATCH_EFFECTS,
  INLINE_EFFECTS,
} from "../src/effects/journal.js";
import { EFFECT_SINKS } from "../src/effects/sinks.js";
import { feedSink } from "../src/feed/sink.js";
import { applyEnvelope, consumeEvents, EVENTS_QUEUE } from "../src/queues/events-consumer.js";

const newId = createIdFactory(Date.now, secureRandomBytes);
const OWNER = "usr_01K742SG00NAWD8WB4RTMJF8H8";
const T0 = 1_760_000_000_000;

async function listedRepo(): Promise<string> {
  const id = newId("rep");
  await env.DIRECTORY.prepare(
    "INSERT INTO principals (id, type, handle, created_at) VALUES (?, 'user', 'feed-owner', 0) ON CONFLICT DO NOTHING",
  )
    .bind(OWNER)
    .run();
  await env.DIRECTORY.prepare(
    `INSERT INTO repos (id, owner_id, name, network_id, org_shard, visibility, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'default', 'private', 0, 0)`,
  )
    .bind(id, OWNER, id.toLowerCase(), newId("net"))
    .run();
  return id;
}

/** A feed block built by hand (the repository makes them): a comment on pull 1 for `recipients`. */
function block(version: number, recipients: readonly string[]): FeedBlock {
  return {
    threadKey: "pull/1",
    subject: { kind: "pull", number: 1, title: "A pull request", version },
    action: "comment",
    actorRoot: OWNER,
    actorTrust: "write",
    member: `comment/${version}`,
    excerpt: "Looks good",
    audience: recipients.map((principal) => ({
      principal,
      kind: "activity",
      reasons: ["commenter"],
      priority: "P1",
      state: "open",
      silent: false,
    })),
  };
}

function commentEvent(repoId: string, seq: number, feed?: FeedBlock): DomainEvent {
  return {
    id: { sourceId: repoId, epochGen: 1, sourceSeq: seq },
    type: "issue_comment.created",
    at: Date.now(),
    actor: OWNER,
    actChain: [],
    ownerGen: 1,
    entity: null,
    data: null,
    stored: false,
    ...(feed && { feed }),
  };
}

const envelope = (repoId: string, events: DomainEvent[]): Envelope => ({
  sourceId: repoId,
  events,
});

/**
 * Feeds that record each call (the principal and its entries) instead of
 * applying them, failing the principals in `failing`.
 */
function recordingFeeds(failing = new Set<string>()) {
  const calls: { principal: string; entries: FeedEntry[] }[] = [];
  const on = {
    ...env,
    USER: {
      getByName: (principal: string) => ({
        applyFeed: async (entries: FeedEntry[]) => {
          calls.push({ principal, entries });
          if (failing.has(principal)) throw new Error(`${principal} is down`);
          return { changed: entries.length, notified: entries.length };
        },
      }),
    },
  } as unknown as Env;
  return { on, calls, failing };
}

async function effectRows(repoId: string) {
  const { results } = await env.ORG_READ.prepare(
    "SELECT effect_id, state, attempts FROM effects WHERE effect_id LIKE ? ORDER BY effect_id",
  )
    .bind(`${repoId}:%`)
    .all<{ effect_id: string; state: string; attempts: number }>();
  return results;
}

type Executes = Record<"run" | "all" | "first" | "raw", (...args: unknown[]) => unknown>;

/** `db`, counting the queries it runs: a statement run alone, or a batch (one call, however many statements). */
function counting(db: D1Database, count: { queries: number }): D1Database {
  const counted = <T extends object>(statement: T): T => {
    const methods = statement as unknown as Executes & { bind: (...args: unknown[]) => T };
    for (const name of ["run", "all", "first", "raw"] as const) {
      const run = methods[name].bind(statement);
      methods[name] = (...args) => {
        count.queries++;
        return run(...args);
      };
    }
    const bind = methods.bind.bind(statement);
    methods.bind = (...args) => counted(bind(...args));
    return statement;
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (query: string) => counted(target.prepare(query));
      if (prop === "batch")
        return (statements: D1PreparedStatement[]) => {
          count.queries++;
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("the feed sink", () => {
  it("plans one effect for an event naming recipients, and none for any other", () => {
    expect(feedSink.plan(commentEvent("rep_0", 1))).toEqual([]);
    expect(feedSink.plan(commentEvent("rep_0", 2, block(1, [])))).toEqual([]);
    const event = commentEvent("rep_0", 3, block(1, ["usr_a", "usr_b"]));
    expect(feedSink.plan(event)).toEqual([
      {
        target: "feed",
        payload: {
          repoId: "rep_0",
          eventKey: "rep_0:1:3",
          occurredAt: event.at,
          actor: OWNER,
          feed: event.feed,
        },
      },
    ]);
  });

  it("is one of the deployment's sinks, and journals nothing for events without a feed block", async () => {
    expect(EFFECT_SINKS).toContain(feedSink);
    const repoId = await listedRepo();
    const { on, calls } = recordingFeeds();
    await applyEnvelope(on, envelope(repoId, [commentEvent(repoId, 1)]), { sinks: [feedSink] });
    expect(await effectRows(repoId)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("makes one call per recipient for a batch of events, with each one's entries", async () => {
    const repoId = await listedRepo();
    const { on, calls } = recordingFeeds();
    const [a, b, c] = ["usr_a", "usr_b", "usr_c"].map((p) => `${p}${repoId}`) as [
      string,
      string,
      string,
    ];
    await applyEnvelope(
      on,
      envelope(repoId, [
        commentEvent(repoId, 1, block(1, [a, b])),
        commentEvent(repoId, 2, block(2, [b, c])),
      ]),
      { sinks: [feedSink] },
    );
    expect(calls.map((call) => [call.principal, call.entries.map((e) => e.eventKey)])).toEqual([
      [a, [`${repoId}:1:1`]],
      [b, [`${repoId}:1:1`, `${repoId}:1:2`]],
      [c, [`${repoId}:1:2`]],
    ]);
    // Each entry carries the block without its audience, and its own recipient.
    expect(calls[1]?.entries[1]).toMatchObject({
      repoId,
      actor: OWNER,
      feed: { threadKey: "pull/1", member: "comment/2", subject: { version: 2 } },
      recipient: { principal: b, kind: "activity" },
    });
    expect(calls[1]?.entries[1]?.feed).not.toHaveProperty("audience");
    expect(await effectRows(repoId)).toMatchObject([{ state: "done" }, { state: "done" }]);
  });

  it("retries only the effects naming a recipient that failed, and the sweeper delivers them", async () => {
    const repoId = await listedRepo();
    const [a, b, c] = ["usr_a", "usr_b", "usr_c"].map((p) => `${p}${repoId}`) as [
      string,
      string,
      string,
    ];
    const { on, calls, failing } = recordingFeeds(new Set([c]));
    await applyEnvelope(
      on,
      envelope(repoId, [
        commentEvent(repoId, 1, block(1, [a, b])),
        commentEvent(repoId, 2, block(2, [b, c])),
      ]),
      { sinks: [feedSink], now: () => T0 },
    );
    expect(await effectRows(repoId)).toEqual([
      { effect_id: `${repoId}:1:1:feed:feed`, state: "done", attempts: 0 },
      { effect_id: `${repoId}:1:2:feed:feed`, state: "pending", attempts: 1 },
    ]);
    failing.clear();
    calls.length = 0;
    await sweepEffects({
      db: env.ORG_READ,
      env: on,
      sinks: [feedSink],
      now: () => T0 + EFFECT_POLICY.backoffMs,
    });
    expect(await effectRows(repoId)).toMatchObject([{ state: "done" }, { state: "done" }]);
    // Only the failed effect again: its recipients get its entries once more (a feed applies
    // them once).
    expect(
      calls
        .filter((call) => call.principal.endsWith(repoId))
        .map((call) => [call.principal, call.entries.map((e) => e.eventKey)]),
    ).toEqual([
      [b, [`${repoId}:1:2`]],
      [c, [`${repoId}:1:2`]],
    ]);
  });

  it("applies entries to the recipients' feeds", async () => {
    const repoId = await listedRepo();
    const reader = `usr_reader${repoId}`;
    const event = commentEvent(repoId, 1, block(1, [reader]));
    await applyEnvelope(env, envelope(repoId, [event]), { sinks: [feedSink] });
    // The same entry again under another effect (as a retried one brings it): nothing changes.
    await applyEnvelope(env, envelope(repoId, [{ ...event, id: { ...event.id, sourceSeq: 2 } }]), {
      sinks: [feedSink],
    });
    const page = await env.USER.getByName(reader).listFeed(null, 50, {});
    expect(page).toMatchObject({
      expired: false,
      head: { seq: 1 },
      items: [{ repoId, threadKey: "pull/1", kind: "activity", members: ["comment/1"] }],
    });
  });

  it("delivers a batch sink's effects inline besides the other sinks' share", async () => {
    const repoId = await listedRepo();
    const { on, calls } = recordingFeeds();
    const single: string[] = [];
    const oneByOne: EffectSink = {
      name: "test_hook",
      plan: () => [{ target: "hook_1", payload: {} }],
      deliver: async (effect) => {
        single.push(effect.id);
      },
    };
    const count = { queries: 0 };
    const measured = {
      ...on,
      DIRECTORY: counting(env.DIRECTORY, count),
      ORG_READ: counting(env.ORG_READ, count),
    } as Env;
    await applyEnvelope(
      measured,
      envelope(
        repoId,
        [1, 2, 3].map((seq) => commentEvent(repoId, seq, block(seq, [`usr_r${repoId}`]))),
      ),
      // Not T0: the effect left pending must not fall due in the global sweep below.
      { sinks: [oneByOne, feedSink] },
    );
    expect(single).toHaveLength(INLINE_EFFECTS);
    expect(calls.map((call) => call.entries.length)).toEqual([3]);
    // A lookup, the batch, the claim, a mark per effect delivered alone, one for the feed's.
    expect(count.queries).toBe(1 + 1 + 1 + INLINE_EFFECTS + 1);
    expect((await effectRows(repoId)).map((row) => row.state).sort()).toEqual([
      "done",
      "done",
      "done",
      "done",
      "done",
      "pending",
    ]);
  });

  it("keeps a consumer invocation and a sweep within Free's 50 D1 queries", async () => {
    const repos = await Promise.all(Array.from({ length: 5 }, () => listedRepo()));
    const { on, calls } = recordingFeeds();
    const count = { queries: 0 };
    const measured = {
      ...on,
      DIRECTORY: counting(env.DIRECTORY, count),
      ORG_READ: counting(env.ORG_READ, count),
    } as Env;
    // Five messages of three events, each for 100 recipients.
    const audience = Array.from({ length: 100 }, (_, i) => `usr_${i}`);
    const batch = createMessageBatch(
      EVENTS_QUEUE,
      repos.map((repoId, i) => ({
        id: `m${i}`,
        timestamp: new Date(),
        attempts: 1,
        body: envelope(
          repoId,
          [1, 2, 3].map((seq) => commentEvent(repoId, seq, block(seq, audience))),
        ),
      })),
    );
    const ctx = createExecutionContext();
    await consumeEvents(batch, measured, { sinks: [feedSink], now: () => T0 });
    expect((await getQueueResult(batch, ctx)).explicitAcks).toHaveLength(5);
    // Per message a directory lookup and a read-model batch; the invocation's eight inline
    // effects (three messages' worth), a claim and one mark per message.
    expect(INLINE_BATCH_EFFECTS).toBe(8);
    expect(count.queries).toBe(5 * 2 + 3 * 2);
    // Each message's inline effects went in one call per recipient: 3, 3, then 2 entries each.
    expect(calls).toHaveLength(300);
    expect(calls.map((call) => call.entries.length)).toEqual([
      ...Array(200).fill(3),
      ...Array(100).fill(2),
    ]);

    // The sweeper takes the rest, a batch at a time: a claim, a mark and the prune.
    count.queries = 0;
    calls.length = 0;
    await sweepEffects({
      db: measured.ORG_READ,
      env: measured,
      sinks: [feedSink],
      now: () => T0 + EFFECT_POLICY.sweepAfterMs,
    });
    expect(count.queries).toBe(3);
    expect(calls.length).toBeLessThanOrEqual(100);
    expect(calls.every((call) => call.entries.length === EFFECT_POLICY.sweepBatch)).toBe(true);
  });
});
