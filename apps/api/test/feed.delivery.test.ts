// Activity feed entries reaching feeds: the feed sink plans one effect per
// event that names recipients, and delivers a batch of effects with one
// call per recipient; the dispatcher hands a batch sink every effect it
// claimed at once, retries only what was not delivered, and an invocation
// stays within Free's D1 queries.

import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  runInDurableObject,
} from "cloudflare:test";
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
import type { RepoDO } from "../src/do/RepoDO.js";
import { deliverEffects, invocationBudget } from "../src/effects/dispatcher.js";
import {
  EFFECT_POLICY,
  type EffectSink,
  INLINE_BATCH_EFFECTS,
  INLINE_RECIPIENTS,
} from "../src/effects/journal.js";
import { EFFECT_SINKS } from "../src/effects/sinks.js";
import { feedSink } from "../src/feed/sink.js";
import {
  applyEnvelope,
  consumeEvents,
  EVENTS_QUEUE,
  INVOCATION_CALLS,
} from "../src/queues/events-consumer.js";
import { recordingPublish } from "./helpers/effects.js";

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
          epochGen: 1,
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
      epochGen: 1,
      recipient: { principal: b, kind: "activity" },
    });
    expect(calls[1]?.entries[1]?.feed).not.toHaveProperty("audience");
    expect(await effectRows(repoId)).toMatchObject([{ state: "done" }, { state: "done" }]);
  });

  it("retries only the effects naming a recipient that failed, and their queue delivers them", async () => {
    const repoId = await listedRepo();
    const [a, b, c] = ["usr_a", "usr_b", "usr_c"].map((p) => `${p}${repoId}`) as [
      string,
      string,
      string,
    ];
    const { on, calls, failing } = recordingFeeds(new Set([c]));
    const { publish, sent } = recordingPublish();
    await applyEnvelope(
      on,
      envelope(repoId, [
        commentEvent(repoId, 1, block(1, [a, b])),
        commentEvent(repoId, 2, block(2, [b, c])),
      ]),
      { sinks: [feedSink], publish, now: () => T0 },
    );
    expect(await effectRows(repoId)).toEqual([
      { effect_id: `${repoId}:1:1:feed:feed`, state: "done", attempts: 1 },
      { effect_id: `${repoId}:1:2:feed:feed`, state: "pending", attempts: 1 },
    ]);
    // Its retry: a message for when it is due.
    expect(sent).toEqual([
      {
        sink: "feed",
        ids: [`${repoId}:1:2:feed:feed`],
        delaySeconds: EFFECT_POLICY.backoffMs / 1000,
      },
    ]);
    failing.clear();
    calls.length = 0;
    const due = T0 + EFFECT_POLICY.backoffMs;
    await deliverEffects(
      { db: env.ORG_READ, env: on, sinks: [feedSink], now: () => due, publish },
      "feed",
      sent[0]?.ids ?? [],
      invocationBudget(due),
    );
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
    const { publish } = recordingPublish();
    await applyEnvelope(env, envelope(repoId, [event]), { sinks: [feedSink], publish });
    // The same entry again under another effect (as a retried one brings it): nothing changes.
    await applyEnvelope(env, envelope(repoId, [{ ...event, id: { ...event.id, sourceSeq: 2 } }]), {
      sinks: [feedSink],
      publish,
    });
    const page = await env.USER.getByName(reader).listFeed(null, 50, {});
    expect(page).toMatchObject({
      expired: false,
      head: { seq: 1 },
      items: [{ repoId, threadKey: "pull/1", kind: "activity", members: ["comment/1"] }],
    });
  });

  it("delivers the feed's effects inline and sends the other sinks' to their queue", async () => {
    const repoId = await listedRepo();
    const { on, calls } = recordingFeeds();
    const single: string[] = [];
    const queued: EffectSink = {
      name: "test_hook",
      plan: () => [{ target: "hook_1", payload: {} }],
      deliver: async (effect) => {
        single.push(effect.id);
      },
    };
    const { publish, sent } = recordingPublish();
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
      { sinks: [queued, feedSink], publish },
    );
    expect(single).toEqual([]);
    expect(sent).toEqual([
      { sink: "test_hook", ids: [1, 2, 3].map((seq) => `${repoId}:1:${seq}:test_hook:hook_1`) },
    ]);
    expect(calls.map((call) => call.entries.length)).toEqual([3]);
    // A lookup, the batch, marking the sent ones, the feed's claim and its mark.
    expect(count.queries).toBe(5);
    expect((await effectRows(repoId)).map((row) => row.state).sort()).toEqual([
      "done",
      "done",
      "done",
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("keeps a consumer invocation and an effects queue's to a few D1 queries", async () => {
    const repos = await Promise.all(Array.from({ length: 5 }, () => listedRepo()));
    const { on, calls } = recordingFeeds();
    const { publish, sent } = recordingPublish();
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
    // Calls and queries are what this bounds: a recipients' share as large as the calls.
    await consumeEvents(batch, measured, {
      sinks: [feedSink],
      publish,
      now: () => T0,
      inline: { batched: INLINE_BATCH_EFFECTS, recipients: INVOCATION_CALLS },
    });
    expect((await getQueueResult(batch, ctx)).explicitAcks).toHaveLength(5);
    // Per message a directory lookup and a read-model batch; for the invocation, one send of
    // the seven effects left, marking them sent, and the eight inline effects' claim and mark.
    expect(INLINE_BATCH_EFFECTS).toBe(8);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.ids).toHaveLength(7);
    expect(count.queries).toBe(5 * 2 + 1 + 2);
    // The inline effects went in one call per recipient: 8 entries each.
    expect(calls).toHaveLength(100);
    expect(calls.every((call) => call.entries.length === 8)).toBe(true);

    // The feed queue's consumer takes the other seven in one invocation, as its calls allow
    // (100 each): a claim, a mark, and one call per recipient.
    count.queries = 0;
    calls.length = 0;
    await deliverEffects(
      { db: measured.ORG_READ, env: measured, sinks: [feedSink], now: () => T0, publish },
      "feed",
      sent[0]?.ids ?? [],
      invocationBudget(T0),
    );
    expect(count.queries).toBe(2);
    expect(calls).toHaveLength(100);
    expect(calls.every((call) => call.entries.length === 7)).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("keeps an invocation's calls within its allowance when events are stored, sending the rest to the feed's queue", async () => {
    const repos = await Promise.all(Array.from({ length: 5 }, () => listedRepo()));
    const { on, calls } = recordingFeeds();
    const count = { queries: 0, payloads: 0 };
    const measured = {
      ...on,
      DIRECTORY: counting(env.DIRECTORY, count),
      ORG_READ: counting(env.ORG_READ, count),
      REPO: {
        getByName: (repoId: string) => ({
          eventPayload: (key: string) => {
            count.payloads++;
            return env.REPO.getByName(repoId).eventPayload(key);
          },
        }),
      },
    } as unknown as Env;
    // Five messages of fifty stored events, two of each for 100 recipients of their own.
    const envelopes = await Promise.all(
      repos.map(async (repoId, r) => {
        const events = Array.from({ length: 50 }, (_, i) => {
          const seq = i + 1;
          const audience = Array.from({ length: 100 }, (_, n) => `usr_${r}_${seq}_${n}`);
          return {
            ...commentEvent(repoId, seq, seq <= 2 ? block(seq, audience) : undefined),
            stored: true,
          };
        });
        await runInDurableObject(env.REPO.getByName(repoId), (_: RepoDO, state) => {
          for (const event of events)
            state.storage.sql.exec(
              "INSERT INTO event_payloads (event_key, payload, created_at) VALUES (?, ?, 0)",
              `${repoId}:1:${event.id.sourceSeq}`,
              JSON.stringify({ row: null, data: { body: "stored" } }),
            );
        });
        return envelope(repoId, events);
      }),
    );
    const batch = createMessageBatch(
      EVENTS_QUEUE,
      envelopes.map((body, i) => ({ id: `m${i}`, timestamp: new Date(), attempts: 1, body })),
    );
    const ctx = createExecutionContext();
    const { publish, sent } = recordingPublish();
    // Calls are what this bounds: a recipients' share as large as the calls.
    await consumeEvents(batch, measured, {
      sinks: [feedSink],
      publish,
      now: () => T0,
      inline: { batched: INLINE_BATCH_EFFECTS, recipients: INVOCATION_CALLS },
    });
    expect((await getQueueResult(batch, ctx)).explicitAcks).toHaveLength(5);
    expect(count.payloads).toBe(250);
    expect(sent.flatMap((s) => s.ids)).toHaveLength(4);
    // Six effects inline (three messages' two), the other four sent to the feed's queue.
    expect(calls).toHaveLength(600);
    const total = count.queries + count.payloads + calls.length;
    expect(total).toBeLessThanOrEqual(INVOCATION_CALLS);
    const states = (await Promise.all(repos.map(effectRows))).flat().map((row) => row.state);
    expect(states.filter((state) => state === "pending")).toHaveLength(4);
  });

  it("shares the recipients delivered inline across an invocation's messages", async () => {
    const repos = await Promise.all(Array.from({ length: 4 }, () => listedRepo()));
    const { on, calls } = recordingFeeds();
    const { publish, sent } = recordingPublish();
    // Four messages, one event each, for 30, 30, 20 and 1 recipients of their own.
    const sizes = [30, 30, 20, 1];
    const batch = createMessageBatch(
      EVENTS_QUEUE,
      repos.map((repoId, i) => ({
        id: `m${i}`,
        timestamp: new Date(),
        attempts: 1,
        body: envelope(repoId, [
          commentEvent(
            repoId,
            1,
            block(
              1,
              Array.from({ length: sizes[i] as number }, (_, n) => `usr_${i}_${n}`),
            ),
          ),
        ]),
      })),
    );
    expect(INLINE_RECIPIENTS).toBe(50);
    // The share left unsaid: the invocation's default, one for all its messages.
    await consumeEvents(batch, on, {
      sinks: [feedSink],
      publish,
      now: () => T0,
      inline: { batched: INLINE_BATCH_EFFECTS },
    });
    // 30 and 20 fit the 50; the second 30, and then the 1, do not.
    expect(calls).toHaveLength(50);
    const queued = sent.flatMap((s) => s.ids).map((id) => id.split(":")[0]);
    expect(queued).toEqual([repos[1], repos[3]]);
  });
});
