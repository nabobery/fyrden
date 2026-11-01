import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import {
  createIdFactory,
  type DomainEvent,
  type Envelope,
  secureRandomBytes,
} from "@fyrden/domain";
import { describe, expect, it } from "vitest";
import { runEffectsCron } from "../src/cron/effects.js";
import type { RepoDO } from "../src/do/RepoDO.js";
import {
  type DispatchDeps,
  deliverEffects,
  type EffectBudget,
  invocationBudget,
  pruneEffects,
  recoverEffects,
} from "../src/effects/dispatcher.js";
import {
  EFFECT_POLICY,
  type Effect,
  type EffectPolicy,
  type EffectSink,
  MESSAGE_CALLS,
} from "../src/effects/journal.js";
import {
  type EffectMessage,
  effectMessages,
  MESSAGE_BYTES,
  type Publish,
  publisher,
} from "../src/effects/queues.js";
import { feedSink } from "../src/feed/sink.js";
import { consumeEffects } from "../src/queues/effects-consumer.js";
import { applyEnvelope, consumeEvents, EVENTS_QUEUE } from "../src/queues/events-consumer.js";
import { recordingPublish } from "./helpers/effects.js";
import { admitted } from "./helpers/read-model.js";

const newId = createIdFactory(Date.now, secureRandomBytes);
const OWNER = "usr_01K742SG00NAWD8WB4RTMJF8H7";
const T0 = 1_760_000_000_000;

async function listedRepo(): Promise<string> {
  const id = newId("rep");
  await env.DIRECTORY.prepare(
    "INSERT INTO principals (id, type, handle, created_at) VALUES (?, 'user', 'effects-owner', 0) ON CONFLICT DO NOTHING",
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

function pushEvent(repoId: string, seq: number, epochGen = 1, ownerGen = 1): DomainEvent {
  return {
    id: { sourceId: repoId, epochGen, sourceSeq: seq },
    type: "refs.updated",
    at: T0,
    actor: OWNER,
    actChain: [],
    ownerGen,
    entity: null,
    data: { via: "push", refs: [{ ref: "refs/heads/main", old: null, new: "a".repeat(40) }] },
    stored: false,
  };
}

const envelope = (repoId: string, events: DomainEvent[]): Envelope => ({
  sourceId: repoId,
  events,
});

const idOf = (repoId: string, seq: number, epochGen = 1) =>
  `${repoId}:${epochGen}:${seq}:test_hook:hook_1`;

/**
 * A sink with one target per push event, recording deliveries as a real
 * destination would: deduped by effect id, with every attempt counted.
 */
function recordingSink(extra: Partial<EffectSink> = {}) {
  const received = new Map<string, Effect>();
  const calls: string[] = [];
  let failing = 0;
  const sink: EffectSink = {
    name: "test_hook",
    plan: (event) =>
      event.type === "refs.updated" ? [{ target: "hook_1", payload: { event: event.type } }] : [],
    deliver: async (effect) => {
      calls.push(effect.id);
      if (failing > 0) {
        failing--;
        throw new Error("destination down");
      }
      received.set(effect.id, effect);
    },
    ...extra,
  };
  return { sink, received, calls, failNext: (n: number) => (failing = n) };
}

async function effectRows(repoId: string) {
  const { results } = await admitted()
    .prepare(
      "SELECT effect_id, state, attempts FROM effects WHERE effect_id LIKE ? ORDER BY effect_id",
    )
    .bind(`${repoId}:%`)
    .all<{ effect_id: string; state: string; attempts: number }>();
  return results;
}

async function effectRow(id: string) {
  return admitted()
    .prepare(
      `SELECT state, attempts, next_attempt_at, recover_at, lease_token, last_error, source_id,
       epoch_gen, owner_gen, any_owner, deliver_until FROM effects WHERE effect_id = ?`,
    )
    .bind(id)
    .first<{
      state: string;
      attempts: number;
      next_attempt_at: number;
      recover_at: number | null;
      lease_token: string | null;
      last_error: string | null;
      source_id: string | null;
      epoch_gen: number | null;
      owner_gen: number | null;
      any_owner: number;
      deliver_until: number | null;
    }>();
}

/** Makes `id` an effect delivered until `until` (a horizon), its attempts `attempts` so far. */
async function withHorizon(id: string, until: number, attempts: number): Promise<void> {
  await admitted()
    .prepare("UPDATE effects SET deliver_until = ?, attempts = ? WHERE effect_id = ?")
    .bind(until, attempts, id)
    .run();
}

function depsOf(
  sinks: readonly EffectSink[],
  now: number | (() => number),
  publish: Publish,
  policy?: EffectPolicy,
): DispatchDeps {
  return {
    db: admitted(),
    env,
    sinks,
    now: typeof now === "number" ? () => now : now,
    publish,
    ...(policy && { policy }),
  };
}

const budget = (now: number, policy: EffectPolicy = EFFECT_POLICY): EffectBudget =>
  invocationBudget(now, policy);

/**
 * A recovery that takes every overdue effect in one run: other tests of
 * this file (in any order) may leave more overdue than a page holds.
 */
const WHOLE_PAGE: EffectPolicy = { ...EFFECT_POLICY, recoverPage: 100_000 };

/**
 * The ids of `repoId`'s effects among those sent, in order: a recovery is
 * global, and other tests of this file may leave effects overdue.
 */
const sentOf = (sent: { ids: string[] }[], repoId: string) =>
  sent.flatMap((s) => s.ids).filter((id) => id.startsWith(`${repoId}:`));

/** Journals `n` effects of `repoId` for the recording sink, due at `at`, each with `payload`. */
async function dueEffects(
  repoId: string,
  n: number,
  at: number,
  payload = "{}",
  recoverAt = at + EFFECT_POLICY.lateMs,
): Promise<string[]> {
  await admitted()
    .prepare(
      `WITH RECURSIVE e(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM e WHERE i < ?2)
     INSERT INTO effects (effect_id, sink, target, payload, next_attempt_at, created_at, recover_at)
     SELECT ?1 || ':1:' || i || ':test_hook:hook_1', 'test_hook', 'hook_1', ?4, ?3, ?3, ?5 FROM e`,
    )
    .bind(repoId, n, at, payload, recoverAt)
    .run();
  return Array.from({ length: n }, (_, i) => idOf(repoId, i + 1));
}

describe("journaling and sending effects", () => {
  it("journals an event's effect with its projection, due at once, and sends its id to the sink's queue", async () => {
    const repoId = await listedRepo();
    const { sink, calls } = recordingSink();
    const { publish, sent } = recordingPublish();
    await applyEnvelope(env, envelope(repoId, [pushEvent(repoId, 1)]), {
      sinks: [sink],
      publish,
      now: () => T0,
    });
    expect(sent).toEqual([{ sink: "test_hook", ids: [idOf(repoId, 1)] }]);
    // Not delivered by the events consumer: the queue's consumer does.
    expect(calls).toEqual([]);
    expect(await effectRow(idOf(repoId, 1))).toMatchObject({
      state: "pending",
      attempts: 0,
      next_attempt_at: T0,
      // Sent: overdue only once a queue's longest expected wait has passed.
      recover_at: T0 + EFFECT_POLICY.lateMs,
      source_id: repoId,
      epoch_gen: 1,
      owner_gen: 1,
      any_owner: 0,
    });

    // A duplicate delivery of the event adds no effect and sends nothing: its message went out.
    await deliverEffects(
      depsOf([sink], T0 + 1, publish),
      "test_hook",
      [idOf(repoId, 1)],
      budget(T0),
    );
    await applyEnvelope(env, envelope(repoId, [pushEvent(repoId, 1)]), {
      sinks: [sink],
      publish,
      now: () => T0 + 2,
    });
    expect(sent).toHaveLength(1);
    expect(await effectRows(repoId)).toEqual([
      { effect_id: idOf(repoId, 1), state: "done", attempts: 1 },
    ]);
  });

  it("sends again, when its event is delivered again, an effect whose message never went out", async () => {
    const repoId = await listedRepo();
    const { sink } = recordingSink();
    const { publish, sent, failNext } = recordingPublish();
    failNext(1);
    const body = envelope(repoId, [pushEvent(repoId, 1)]);
    // The send fails after the batch committed: still applied, and overdue after the grace.
    expect(await applyEnvelope(env, body, { sinks: [sink], publish, now: () => T0 })).toBe(
      "applied",
    );
    expect(sent).toEqual([]);
    expect(await effectRow(idOf(repoId, 1))).toMatchObject({
      recover_at: T0 + EFFECT_POLICY.publishGraceMs,
    });
    await applyEnvelope(env, body, { sinks: [sink], publish, now: () => T0 + 1 });
    expect(sent).toEqual([{ sink: "test_hook", ids: [idOf(repoId, 1)] }]);
  });

  it("journals an effect in the same batch as its projection: both or neither", async () => {
    const repoId = await listedRepo();
    const snapshot: DomainEvent = {
      ...pushEvent(repoId, 1),
      type: "repo.updated",
      data: null,
      entity: {
        type: "repo",
        id: repoId,
        version: 1,
        deleted: false,
        row: {
          ownerId: OWNER,
          name: "r",
          visibility: "private",
          defaultBranch: "refs/heads/main",
          pushedAt: null,
          createdAt: 1,
        },
      },
    };
    const sink: EffectSink = {
      name: "test_hook",
      plan: () => [{ target: "hook_1", payload: {} }],
      deliver: async () => {},
    };
    const { publish, sent } = recordingPublish();
    const failingBatch = new Proxy(env.ORG_READ, {
      get(target, prop) {
        if (prop === "batch")
          return (statements: D1PreparedStatement[]) =>
            target.batch([...statements, target.prepare("SELECT * FROM no_such_table")]);
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const failing = new Proxy(env, {
      get: (target, prop) => (prop === "ORG_READ" ? failingBatch : Reflect.get(target, prop)),
    });
    await expect(
      applyEnvelope(failing, envelope(repoId, [snapshot]), {
        sinks: [sink],
        publish,
        now: () => T0,
      }),
    ).rejects.toThrow();
    const row = () =>
      admitted().prepare("SELECT version FROM repos WHERE repo_id = ?").bind(repoId).first();
    expect(await row()).toBeNull();
    expect(await effectRows(repoId)).toEqual([]);
    expect(sent).toEqual([]);
    await applyEnvelope(env, envelope(repoId, [snapshot]), {
      sinks: [sink],
      publish,
      now: () => T0,
    });
    expect(await row()).toEqual({ version: 1 });
    expect(await effectRows(repoId)).toMatchObject([{ state: "pending" }]);
    expect(sent).toHaveLength(1);
  });

  it("journals nothing for an event of an older epoch", async () => {
    const repoId = await listedRepo();
    const { sink } = recordingSink();
    const { publish } = recordingPublish();
    await applyEnvelope(env, envelope(repoId, [pushEvent(repoId, 1, 2)]), {
      sinks: [sink],
      publish,
      now: () => T0,
    });
    await applyEnvelope(env, envelope(repoId, [pushEvent(repoId, 9, 1)]), {
      sinks: [sink],
      publish,
      now: () => T0,
    });
    expect((await effectRows(repoId)).map((r) => r.effect_id)).toEqual([idOf(repoId, 1, 2)]);
  });

  it("gives sinks a stored event's data, fetched from the repository", async () => {
    const repoId = await listedRepo();
    const seen: unknown[] = [];
    const sink: EffectSink = {
      name: "test_hook",
      plan: (event) => {
        seen.push(event.data);
        return [];
      },
      deliver: async () => {},
    };
    await runInDurableObject(env.REPO.getByName(repoId), (_: RepoDO, state) => {
      state.storage.sql.exec(
        "INSERT INTO event_payloads (event_key, payload, created_at) VALUES (?, ?, 0)",
        `${repoId}:1:1`,
        JSON.stringify({ row: null, data: { via: "push", refs: ["many"] } }),
      );
    });
    const stored: DomainEvent = { ...pushEvent(repoId, 1), data: null, stored: true };
    await applyEnvelope(env, envelope(repoId, [stored]), {
      sinks: [sink],
      publish: recordingPublish().publish,
      now: () => T0,
    });
    expect(seen).toEqual([{ via: "push", refs: ["many"] }]);
  });

  it("delivers an inline sink's share itself, after sending the rest, and sends what it leaves", async () => {
    const repoId = await listedRepo();
    const order: string[] = [];
    const inline = recordingSink({
      name: "test_feed",
      inline: true,
      deliverBatch: async (effects) => {
        order.push("deliver");
        return { delivered: effects.map((effect) => effect.id) };
      },
    });
    const queued = recordingSink();
    const { sent } = recordingPublish();
    const publish: Publish = async (sink, ids) => {
      order.push(`send ${sink}`);
      sent.push({ sink, ids: [...ids] });
    };
    const events = Array.from({ length: 3 }, (_, i) => pushEvent(repoId, i + 1));
    await applyEnvelope(env, envelope(repoId, events), {
      sinks: [queued.sink, inline.sink],
      publish,
      inline: { batched: 2 },
      now: () => T0,
    });
    // The queued sink's three and the inline sink's third go out before the inline delivery.
    expect(order).toEqual(["send test_hook", "send test_feed", "deliver"]);
    expect(sent).toEqual([
      { sink: "test_hook", ids: [1, 2, 3].map((seq) => idOf(repoId, seq)) },
      { sink: "test_feed", ids: [`${repoId}:1:3:test_feed:hook_1`] },
    ]);
    expect(
      (await effectRows(repoId)).filter((row) => row.effect_id.includes(":test_feed:")),
    ).toMatchObject([{ state: "done" }, { state: "done" }, { state: "pending" }]);
  });

  it("takes an event whose feed block names further pages of its audience", async () => {
    const repoId = await listedRepo();
    const { sink } = recordingSink();
    const paged: DomainEvent = {
      ...pushEvent(repoId, 1),
      feed: {
        threadKey: "issue/1",
        subject: { kind: "issue", number: 1, title: "T", version: 1 },
        action: "comment",
        actorRoot: OWNER,
        actorTrust: "write",
        member: null,
        excerpt: null,
        audience: [],
        pages: [{ n: 1, count: 100, bytes: 20_000 }],
        deadline: T0 + 1_000,
      },
    };
    const batch = createMessageBatch(EVENTS_QUEUE, [
      { id: "m", timestamp: new Date(), attempts: 1, body: envelope(repoId, [paged]) },
    ]);
    await consumeEvents(batch, env, {
      sinks: [sink],
      publish: recordingPublish().publish,
      now: () => T0,
    });
    expect(await getQueueResult(batch, createExecutionContext())).toMatchObject({
      explicitAcks: ["m"],
    });
    expect(await effectRows(repoId)).toHaveLength(1);
  });

  it("records each failed effect of a batch with its own error", async () => {
    const repoId = await listedRepo();
    const inline = recordingSink({
      name: "test_feed",
      inline: true,
      deliverBatch: async (effects) => {
        const [first, second, third] = effects.map((effect) => effect.id);
        return {
          delivered: [first as string],
          failures: [
            { ids: [second as string], error: new Error("page missing") },
            { ids: [third as string], error: new Error("feed unavailable") },
          ],
        };
      },
    });
    const events = Array.from({ length: 3 }, (_, i) => pushEvent(repoId, i + 1));
    await applyEnvelope(env, envelope(repoId, events), {
      sinks: [inline.sink],
      publish: recordingPublish().publish,
      inline: { batched: 3 },
      now: () => T0,
    });
    const rows = await Promise.all(
      [1, 2, 3].map((seq) => effectRow(`${repoId}:1:${seq}:test_feed:hook_1`)),
    );
    expect(rows.map((row) => [row?.state, row?.last_error])).toEqual([
      ["done", null],
      ["pending", "page missing"],
      ["pending", "feed unavailable"],
    ]);
  });

  it("counts a failed send, still acknowledges, and leaves the effect for the cron after the grace", async () => {
    const repoId = await listedRepo();
    const { sink } = recordingSink();
    const { publish, failNext } = recordingPublish();
    failNext(1);
    const points: string[] = [];
    const batch = createMessageBatch(EVENTS_QUEUE, [
      {
        id: "m",
        timestamp: new Date(),
        attempts: 1,
        body: envelope(repoId, [pushEvent(repoId, 1)]),
      },
    ]);
    await consumeEvents(batch, env, {
      sinks: [sink],
      publish,
      now: () => T0,
      metrics: { count: (name, dims) => points.push(`${name} ${Object.values(dims)}`) },
    });
    expect(await getQueueResult(batch, createExecutionContext())).toMatchObject({
      explicitAcks: ["m"],
    });
    expect(points.filter((p) => p.startsWith("effects.dispatch"))).toEqual([
      "effects.dispatch error",
    ]);
    const recovery = recordingPublish();
    const deps = depsOf([sink], T0 + EFFECT_POLICY.publishGraceMs, recovery.publish, WHOLE_PAGE);
    await recoverEffects(deps);
    expect(sentOf(recovery.sent, repoId)).toEqual([idOf(repoId, 1)]);
  });
});

describe("delivering effects a message names", () => {
  it("delivers each effect once, whatever messages name it, and the destination dedupes", async () => {
    const repoId = await listedRepo();
    const ids = await dueEffects(repoId, 2, T0);
    const { sink, received, calls } = recordingSink();
    const { publish, sent } = recordingPublish();
    const deps = depsOf([sink], T0, publish);
    expect(await deliverEffects(deps, "test_hook", ids, budget(T0))).toBe(2);
    // A repeated message (the queue delivers at least once) finds them done.
    expect(await deliverEffects(deps, "test_hook", [...ids, ...ids], budget(T0))).toBe(0);
    expect(calls).toEqual(ids);
    expect(received.size).toBe(2);
    expect(sent).toEqual([]);
    expect(await effectRows(repoId)).toMatchObject([
      { state: "done", attempts: 1 },
      { state: "done", attempts: 1 },
    ]);
  });

  it("retries a failed delivery with backoff, as a message sent for when it is due", async () => {
    const repoId = await listedRepo();
    const [id = ""] = await dueEffects(repoId, 1, T0);
    const { sink, received, failNext } = recordingSink();
    const { publish, sent } = recordingPublish();
    failNext(2);
    await deliverEffects(depsOf([sink], T0, publish), "test_hook", [id], budget(T0));
    expect(await effectRow(id)).toMatchObject({
      state: "pending",
      attempts: 1,
      next_attempt_at: T0 + EFFECT_POLICY.backoffMs,
      recover_at: T0 + EFFECT_POLICY.backoffMs + EFFECT_POLICY.lateMs,
      lease_token: null,
    });
    expect(sent).toEqual([
      { sink: "test_hook", ids: [id], delaySeconds: EFFECT_POLICY.backoffMs / 1000 },
    ]);
    // A message ahead of the schedule (clocks differ) sends it on for when it is due.
    await deliverEffects(depsOf([sink], T0 + 1_000, publish), "test_hook", [id], budget(T0));
    expect(sent.at(-1)).toEqual({
      sink: "test_hook",
      ids: [id],
      delaySeconds: EFFECT_POLICY.backoffMs / 1000 - 1,
    });
    expect(await effectRow(id)).toMatchObject({ attempts: 1 });
    // The second attempt fails too: twice the delay.
    const second = T0 + EFFECT_POLICY.backoffMs;
    await deliverEffects(depsOf([sink], second, publish), "test_hook", [id], budget(second));
    expect(await effectRow(id)).toMatchObject({
      attempts: 2,
      next_attempt_at: second + 2 * EFFECT_POLICY.backoffMs,
    });
    const third = second + 2 * EFFECT_POLICY.backoffMs;
    await deliverEffects(depsOf([sink], third, publish), "test_hook", [id], budget(third));
    expect(await effectRow(id)).toMatchObject({ state: "done", attempts: 3 });
    expect(received.size).toBe(1);
  });

  it("records when an effect failed for good, not when its next attempt would have been", async () => {
    const repoId = await listedRepo();
    const [id = ""] = await dueEffects(repoId, 1, T0);
    const { sink, failNext } = recordingSink();
    const { publish, sent } = recordingPublish();
    failNext(1);
    const policy = { ...EFFECT_POLICY, maxAttempts: 1 };
    await deliverEffects(
      depsOf([sink], T0, publish, policy),
      "test_hook",
      [id],
      budget(T0, policy),
    );
    expect(await effectRow(id)).toMatchObject({
      state: "failed",
      attempts: 1,
      next_attempt_at: T0,
    });
    expect(sentOf(sent, repoId)).toEqual([]);
  });

  it("makes a retried effect overdue at its due time when its message cannot be sent", async () => {
    const repoId = await listedRepo();
    const [id = ""] = await dueEffects(repoId, 1, T0);
    const { sink, failNext: failDelivery } = recordingSink();
    const { publish, failNext } = recordingPublish();
    failDelivery(1);
    failNext(1);
    await deliverEffects(depsOf([sink], T0, publish), "test_hook", [id], budget(T0));
    expect(await effectRow(id)).toMatchObject({
      state: "pending",
      recover_at: T0 + EFFECT_POLICY.backoffMs,
    });
  });

  it("counts the claim as an attempt, so an effect whose runs keep dying ends failed", async () => {
    const repoId = await listedRepo();
    const [id = ""] = await dueEffects(repoId, 1, T0);
    const policy = { ...WHOLE_PAGE, maxAttempts: 2 };
    const crash = new Error("the invocation died");
    const dying: EffectSink = {
      name: "test_hook",
      plan: () => [],
      deliver: async () => {
        throw crash;
      },
    };
    // A run that dies mid-delivery: its claim is never released (the sink throws past the mark).
    const deadMark = new Proxy(env.ORG_READ, {
      get(target, prop) {
        if (prop === "prepare")
          return (query: string) => {
            if (query.includes("RETURNING effect_id, state, next_attempt_at")) throw crash;
            return target.prepare(query);
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const { publish, sent } = recordingPublish();
    let now = T0;
    for (let run = 0; run < 2; run++) {
      await expect(
        deliverEffects(
          { ...depsOf([dying], now, publish, policy), db: admitted(deadMark) },
          "test_hook",
          [id],
          budget(now, policy),
        ),
      ).rejects.toThrow(crash);
      // The claim lasts its lease; then the cron finds it overdue and sends it again.
      now += policy.leaseMs;
      await recoverEffects(depsOf([dying], now, publish, policy));
    }
    expect(await effectRow(id)).toMatchObject({
      state: "failed",
      attempts: 2,
      last_error: "attempts spent",
    });
    // Sent again once (after the first death); the second recovery ended it.
    expect(sentOf(sent, repoId)).toEqual([id]);
  });

  it("never lets two messages deliver one effect at once", async () => {
    const repoId = await listedRepo();
    const [id = ""] = await dueEffects(repoId, 1, T0);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => {};
    const delivering = new Promise<void>((resolve) => {
      started = resolve;
    });
    const calls: string[] = [];
    const slow: EffectSink = {
      name: "test_hook",
      plan: () => [],
      deliver: async (effect) => {
        calls.push(effect.id);
        started();
        await gate;
      },
    };
    const { publish, sent } = recordingPublish();
    const first = deliverEffects(depsOf([slow], T0, publish), "test_hook", [id], budget(T0));
    await delivering;
    // Another isolate takes the same message (or a recovery's) meanwhile.
    expect(
      await deliverEffects(depsOf([slow], T0 + 1, publish), "test_hook", [id], budget(T0)),
    ).toBe(0);
    release();
    expect(await first).toBe(1);
    expect(calls).toHaveLength(1);
    expect(sent).toEqual([]);
    expect(await effectRow(id)).toMatchObject({ state: "done" });
  });

  it("lets a later message take over an expired claim, and ignores the late outcome of the old holder", async () => {
    const repoId = await listedRepo();
    const [id = ""] = await dueEffects(repoId, 1, T0);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => {};
    const delivering = new Promise<void>((resolve) => {
      started = resolve;
    });
    let first = true;
    const sink: EffectSink = {
      name: "test_hook",
      plan: () => [],
      deliver: async () => {
        if (!first) return;
        first = false;
        started();
        await gate;
        // The old holder fails, long after its claim expired.
        throw new Error("too late");
      },
    };
    const { publish } = recordingPublish();
    const old = deliverEffects(depsOf([sink], T0, publish), "test_hook", [id], budget(T0));
    await delivering;
    const later = T0 + EFFECT_POLICY.leaseMs;
    expect(
      await deliverEffects(depsOf([sink], later, publish), "test_hook", [id], budget(later)),
    ).toBe(1);
    expect(await effectRow(id)).toMatchObject({ state: "done", attempts: 2 });
    release();
    await old;
    expect(await effectRow(id)).toMatchObject({ state: "done", attempts: 2 });
  });

  it("ends, without delivering, effects whose source was restored, transferred or deleted since", async () => {
    const restored = await listedRepo();
    const transferred = await listedRepo();
    const deleted = await listedRepo();
    const { sink, calls } = recordingSink();
    const acrossTransfers = recordingSink({ name: "test_refs", acrossTransfers: true });
    const { publish } = recordingPublish();
    for (const repoId of [restored, transferred, deleted])
      await applyEnvelope(env, envelope(repoId, [pushEvent(repoId, 1)]), {
        sinks: [sink, acrossTransfers.sink],
        publish,
        now: () => T0,
      });
    // A restore: the read model saw a newer epoch. A transfer: a newer ownership generation.
    await admitted()
      .prepare("UPDATE consumer_epochs SET epoch_gen = 2 WHERE source_id = ?")
      .bind(restored)
      .run();
    await admitted()
      .prepare("INSERT INTO source_owner (source_id, owner_gen) VALUES (?, 2)")
      .bind(transferred)
      .run();
    await admitted()
      .prepare(
        `INSERT INTO repos (repo_id, deleted, epoch_gen, version, owner_gen, updated_seq, updated_at)
       VALUES (?, 1, 1, 9, 1, 9, 0)`,
      )
      .bind(deleted)
      .run();
    const ids = [restored, transferred, deleted].map((repoId) => idOf(repoId, 1));
    const deps = depsOf([sink, acrossTransfers.sink], T0, publish);
    expect(await deliverEffects(deps, "test_hook", ids, budget(T0))).toBe(0);
    expect(calls).toEqual([]);
    const reasons = await Promise.all(ids.map(async (id) => (await effectRow(id))?.last_error));
    expect(reasons).toEqual([
      "invalidated: its source was restored to an earlier state",
      "invalidated: its source was transferred",
      "invalidated: its source was deleted",
    ]);
    // A sink whose effects stand across transfers still delivers the transferred source's.
    const refs = [restored, transferred].map((repoId) => `${repoId}:1:1:test_refs:hook_1`);
    expect(await deliverEffects(deps, "test_refs", refs, budget(T0))).toBe(1);
    expect([...acrossTransfers.received.keys()]).toEqual([refs[1]]);
  });

  it("delivers a transferred source's effects that stand across transfers, ending its others", async () => {
    const transferred = await listedRepo();
    const { sink, received } = recordingSink({
      plan: (event) =>
        event.type === "refs.updated"
          ? [
              { target: "hook_1", payload: { event: event.type } },
              { target: "settle_1", payload: { event: event.type }, acrossTransfers: true },
            ]
          : [],
    });
    const { publish } = recordingPublish();
    await applyEnvelope(env, envelope(transferred, [pushEvent(transferred, 1)]), {
      sinks: [sink],
      publish,
      now: () => T0,
    });
    await admitted()
      .prepare("INSERT INTO source_owner (source_id, owner_gen) VALUES (?, 2)")
      .bind(transferred)
      .run();
    const ordinary = idOf(transferred, 1);
    const standing = `${transferred}:1:1:test_hook:settle_1`;
    const deps = depsOf([sink], T0, publish);
    expect(await deliverEffects(deps, "test_hook", [ordinary, standing], budget(T0))).toBe(1);
    expect([...received.keys()]).toEqual([standing]);
    expect((await effectRow(ordinary))?.last_error).toBe("invalidated: its source was transferred");
  });

  it("ends effects of a sink this deployment does not have", async () => {
    const repoId = await listedRepo();
    const [id = ""] = await dueEffects(repoId, 1, T0);
    const { publish } = recordingPublish();
    await deliverEffects(depsOf([], T0, publish), "test_hook", [id], budget(T0));
    expect(await effectRow(id)).toMatchObject({
      state: "failed",
      last_error: "no sink named test_hook",
    });
  });

  it("passes over an effect of another sink that a message names", async () => {
    const repoId = await listedRepo();
    const [id = ""] = await dueEffects(repoId, 1, T0);
    const other = recordingSink({ name: "test_other" });
    const { publish } = recordingPublish();
    expect(
      await deliverEffects(depsOf([other.sink], T0, publish), "test_other", [id], budget(T0)),
    ).toBe(0);
    expect(other.calls).toEqual([]);
    expect(await effectRow(id)).toMatchObject({ state: "pending", attempts: 0 });
  });
});

describe("an effect delivered until its horizon", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("is journaled with its sink's horizon, an effect of a sink without one with none", async () => {
    const repoId = await listedRepo();
    const { sink } = recordingSink({ name: "test_hook" });
    const { sink: lasting } = recordingSink({ name: "test_horizon", horizonMs: 3 * DAY });
    const { publish } = recordingPublish();
    await applyEnvelope(env, envelope(repoId, [pushEvent(repoId, 1)]), {
      sinks: [sink, lasting],
      publish,
      now: () => T0,
    });
    const { results } = await admitted()
      .prepare("SELECT sink, deliver_until FROM effects WHERE source_id = ? ORDER BY sink")
      .bind(repoId)
      .all();
    expect(results).toEqual([
      { sink: "test_hook", deliver_until: null },
      { sink: "test_horizon", deliver_until: T0 + 3 * DAY },
    ]);
    // Feed entries are kept 7 days: their effects are delivered for as long.
    expect(feedSink.horizonMs).toBe(7 * DAY);
  });

  it("backs off at the longest delay once its attempts are spent, never wrapping round", async () => {
    for (const attempts of [EFFECT_POLICY.maxAttempts, 50, 64, 168]) {
      const repoId = await listedRepo();
      const [id = ""] = await dueEffects(repoId, 1, T0);
      await withHorizon(id, T0 + 7 * DAY, attempts - 1);
      const { sink, failNext } = recordingSink();
      const { publish, sent } = recordingPublish();
      failNext(1);
      await deliverEffects(depsOf([sink], T0, publish), "test_hook", [id], budget(T0));
      expect(await effectRow(id), String(attempts)).toMatchObject({
        state: "pending",
        attempts,
        next_attempt_at: T0 + EFFECT_POLICY.maxBackoffMs,
        recover_at: T0 + EFFECT_POLICY.maxBackoffMs + EFFECT_POLICY.lateMs,
      });
      expect(sent).toEqual([
        { sink: "test_hook", ids: [id], delaySeconds: EFFECT_POLICY.maxBackoffMs / 1000 },
      ]);
    }
  });

  it("backs an attempt-bounded effect off without wrapping round either", async () => {
    const repoId = await listedRepo();
    const [id = ""] = await dueEffects(repoId, 1, T0);
    const policy = { ...EFFECT_POLICY, maxAttempts: 200 };
    await admitted().prepare("UPDATE effects SET attempts = 64 WHERE effect_id = ?").bind(id).run();
    const { sink, failNext } = recordingSink();
    const { publish } = recordingPublish();
    failNext(1);
    await deliverEffects(
      depsOf([sink], T0, publish, policy),
      "test_hook",
      [id],
      budget(T0, policy),
    );
    expect(await effectRow(id)).toMatchObject({
      state: "pending",
      attempts: 65,
      next_attempt_at: T0 + EFFECT_POLICY.maxBackoffMs,
    });
  });

  it("is sent again by the cron, its message lost, however many attempts it has made", async () => {
    const repoId = await listedRepo();
    const [id = ""] = await dueEffects(repoId, 1, T0);
    await withHorizon(id, T0 + 7 * DAY, EFFECT_POLICY.maxAttempts + 5);
    const { sink, received } = recordingSink();
    const { publish, sent } = recordingPublish();
    // Its message expired in the queue: the cron finds it overdue and sends it again.
    const later = T0 + 2 * DAY;
    await recoverEffects(depsOf([sink], later, publish, WHOLE_PAGE));
    expect(sentOf(sent, repoId)).toEqual([id]);
    expect(await effectRow(id)).toMatchObject({ state: "pending" });
    await deliverEffects(depsOf([sink], later, publish), "test_hook", [id], budget(later));
    expect(received.has(id)).toBe(true);
    expect(await effectRow(id)).toMatchObject({
      state: "done",
      attempts: EFFECT_POLICY.maxAttempts + 6,
    });
  });

  it("is tried again an hour after a claim past its attempts died, not when the claim lapses", async () => {
    const repoId = await listedRepo();
    const [id = ""] = await dueEffects(repoId, 1, T0);
    await withHorizon(id, T0 + 7 * DAY, EFFECT_POLICY.maxAttempts);
    const crash = new Error("the invocation died");
    const dying: EffectSink = {
      name: "test_hook",
      plan: () => [],
      deliver: async () => {
        throw crash;
      },
    };
    // A run that dies mid-delivery: its claim is never released.
    const deadMark = new Proxy(env.ORG_READ, {
      get(target, prop) {
        if (prop === "prepare")
          return (query: string) => {
            if (query.includes("RETURNING effect_id, state, next_attempt_at")) throw crash;
            return target.prepare(query);
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const parked: string[] = [];
    const metrics = { count: (name: string) => parked.push(name) } as unknown as Metrics;
    const { publish, sent } = recordingPublish();
    await expect(
      deliverEffects(
        { ...depsOf([dying], T0, publish), db: admitted(deadMark), metrics },
        "test_hook",
        [id],
        budget(T0),
      ),
    ).rejects.toThrow(crash);
    expect(parked.filter((n) => n === "effects.parked")).toHaveLength(1);
    expect(await effectRow(id)).toMatchObject({
      attempts: EFFECT_POLICY.maxAttempts + 1,
      next_attempt_at: T0 + EFFECT_POLICY.maxBackoffMs,
      recover_at: T0 + EFFECT_POLICY.maxBackoffMs,
    });
    // Its claim lapses: not sent again yet, nor claimable.
    const lapsed = T0 + EFFECT_POLICY.leaseMs;
    await recoverEffects(depsOf([dying], lapsed, publish, WHOLE_PAGE));
    expect(sentOf(sent, repoId)).toEqual([]);
    const { sink, received } = recordingSink();
    await deliverEffects(depsOf([sink], lapsed, publish), "test_hook", [id], budget(lapsed));
    expect(received.size).toBe(0);
    // An hour on: sent again, and delivered.
    const hour = T0 + EFFECT_POLICY.maxBackoffMs;
    await recoverEffects(depsOf([sink], hour, publish, WHOLE_PAGE));
    expect(sentOf(sent, repoId)).toContain(id);
    await deliverEffects(depsOf([sink], hour, publish), "test_hook", [id], budget(hour));
    expect(received.has(id)).toBe(true);
  });

  it("is given back untried at once, however many attempts it has made", async () => {
    const repoId = await listedRepo();
    const ids = await dueEffects(repoId, 2, T0);
    for (const id of ids) await withHorizon(id, T0 + 7 * DAY, EFFECT_POLICY.maxAttempts + 3);
    let clock = T0;
    const slow: EffectSink = {
      name: "test_hook",
      plan: () => [],
      deliver: async () => {
        clock += EFFECT_POLICY.invocation.deadlineMs;
      },
    };
    const { publish } = recordingPublish();
    await deliverEffects(
      depsOf([slow], () => clock, publish),
      "test_hook",
      ids,
      budget(T0),
    );
    // The second was claimed, then given back untried (when the deadline had passed): due then,
    // not an hour on.
    expect(await effectRow(ids[1] ?? "")).toMatchObject({
      attempts: EFFECT_POLICY.maxAttempts + 3,
      lease_token: null,
      next_attempt_at: T0 + EFFECT_POLICY.invocation.deadlineMs,
    });
  });

  it("records its horizon as why it failed when that passed during its last delivery", async () => {
    const repoId = await listedRepo();
    const [id = ""] = await dueEffects(repoId, 1, T0);
    await withHorizon(id, T0 + 1_000, EFFECT_POLICY.maxAttempts + 3);
    let clock = T0;
    const late: EffectSink = {
      name: "test_hook",
      plan: () => [],
      deliver: async () => {
        clock = T0 + 2_000;
        throw new Error("destination down");
      },
    };
    const { publish } = recordingPublish();
    await deliverEffects(
      depsOf([late], () => clock, publish),
      "test_hook",
      [id],
      budget(T0),
    );
    expect(await effectRow(id)).toMatchObject({
      state: "failed",
      last_error: "past its delivery horizon",
    });
  });

  it("is ended at its horizon when that comes before its next attempt, failed or claimed", async () => {
    const repoId = await listedRepo();
    const [failing = "", dying = ""] = await dueEffects(repoId, 2, T0);
    const horizon = T0 + 10 * 60_000;
    await withHorizon(failing, horizon, EFFECT_POLICY.maxAttempts + 1);
    await withHorizon(dying, horizon, EFFECT_POLICY.maxAttempts + 1);
    const { sink, failNext } = recordingSink();
    const { publish } = recordingPublish();
    failNext(1);
    await deliverEffects(depsOf([sink], T0, publish), "test_hook", [failing], budget(T0));
    expect(await effectRow(failing)).toMatchObject({ state: "pending", recover_at: horizon });
    // A claim that dies: its claim lapses before the horizon, which comes before the hour.
    const crash = new Error("the invocation died");
    const deadMark = new Proxy(env.ORG_READ, {
      get(target, prop) {
        if (prop === "prepare")
          return (query: string) => {
            if (query.includes("RETURNING effect_id, state, next_attempt_at")) throw crash;
            return target.prepare(query);
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const thrower: EffectSink = {
      name: "test_hook",
      plan: () => [],
      deliver: async () => {
        throw crash;
      },
    };
    await expect(
      deliverEffects(
        { ...depsOf([thrower], T0, publish), db: admitted(deadMark) },
        "test_hook",
        [dying],
        budget(T0),
      ),
    ).rejects.toThrow(crash);
    expect(await effectRow(dying)).toMatchObject({ state: "pending", recover_at: horizon });
    // The cron at the horizon ends both.
    await recoverEffects(depsOf([sink], horizon, publish, WHOLE_PAGE));
    for (const id of [failing, dying])
      expect(await effectRow(id)).toMatchObject({
        state: "failed",
        last_error: "past its delivery horizon",
      });
  });

  it("is not delivered past its horizon, and the cron ends it", async () => {
    const repoId = await listedRepo();
    const [id = ""] = await dueEffects(repoId, 1, T0);
    await withHorizon(id, T0 + 7 * DAY, 3);
    const { sink, received } = recordingSink();
    const { publish, sent } = recordingPublish();
    const past = T0 + 7 * DAY;
    await deliverEffects(depsOf([sink], past, publish), "test_hook", [id], budget(past));
    expect(received.size).toBe(0);
    await recoverEffects(depsOf([sink], past, publish, WHOLE_PAGE));
    expect(sentOf(sent, repoId)).toEqual([]);
    expect(await effectRow(id)).toMatchObject({
      state: "failed",
      last_error: "past its delivery horizon",
    });
  });
});

describe("a single-effect sink's outcome", () => {
  it("ends an effect its sink says is over, with no retry and its claim cleared", async () => {
    const repoId = await listedRepo();
    const [id = ""] = await dueEffects(repoId, 1, T0);
    const { sink } = recordingSink({
      deliver: async () => ({ ended: "expired: past its delivery deadline" }),
    });
    const { publish, sent } = recordingPublish();
    expect(await deliverEffects(depsOf([sink], T0, publish), "test_hook", [id], budget(T0))).toBe(
      0,
    );
    expect(await effectRow(id)).toMatchObject({
      state: "failed",
      attempts: 1,
      lease_token: null,
      last_error: "expired: past its delivery deadline",
    });
    expect(sent).toEqual([]);
  });

  it("hands the sink the time it was claimed at, not a later one", async () => {
    const repoId = await listedRepo();
    const [one = "", two = ""] = await dueEffects(repoId, 2, T0);
    const seen: (number | undefined)[] = [];
    // The clock reads T0 until the claim's batch is done, and an hour later from then on.
    let late = false;
    const clock = () => (late ? T0 + 3_600_000 : T0);
    const claiming = new Proxy(env.ORG_READ, {
      get(target, prop) {
        if (prop === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            late = true;
            return results;
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const run = async (sink: EffectSink, id: string) => {
      late = false;
      const deps = { ...depsOf([sink], clock, recordingPublish().publish), db: admitted(claiming) };
      expect(await deliverEffects(deps, "test_hook", [id], budget(T0))).toBe(1);
    };
    await run(
      recordingSink({
        deliver: async (effect) => {
          seen.push(effect.claimedAt);
        },
      }).sink,
      one,
    );
    await run(
      recordingSink({
        deliverBatch: async (effects) => {
          seen.push(...effects.map((e) => e.claimedAt));
          return { delivered: effects.map((e) => e.id) };
        },
      }).sink,
      two,
    );
    expect(seen).toEqual([T0, T0]);
  });

  it("is retried, not counted a failed delivery, when its end cannot be recorded", async () => {
    const repoId = await listedRepo();
    const [id = ""] = await dueEffects(repoId, 1, T0);
    const { sink } = recordingSink({ deliver: async () => ({ ended: "expired: past" }) });
    const lost = new Proxy(env.ORG_READ, {
      get(target, prop) {
        if (prop === "prepare")
          return (query: string) => {
            if (query.includes("SET state = 'failed', next_attempt_at = ?1, last_error = ?2"))
              throw new Error("D1 down");
            return target.prepare(query);
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const { publish, sent } = recordingPublish();
    await expect(
      deliverEffects(
        { ...depsOf([sink], T0, publish), db: admitted(lost) },
        "test_hook",
        [id],
        budget(T0),
      ),
    ).rejects.toThrow(/D1 down/);
    // Still claimed, its claim to expire: nothing marked it failed or sent a retry.
    expect(await effectRow(id)).toMatchObject({ state: "pending", last_error: null });
    expect(sent).toEqual([]);
  });
});

describe("an invocation's budget", () => {
  it("delivers as many effects as the budget allows and sends the rest back", async () => {
    const repoId = await listedRepo();
    const ids = await dueEffects(repoId, 40, T0);
    const { sink, received } = recordingSink();
    const { publish, sent } = recordingPublish();
    const shared = budget(T0);
    expect(EFFECT_POLICY.invocation.effects).toBe(32);
    // Two messages share one invocation's budget.
    const deps = depsOf([sink], T0, publish);
    expect(await deliverEffects(deps, "test_hook", ids.slice(0, 20), shared)).toBe(20);
    expect(await deliverEffects(deps, "test_hook", ids.slice(20), shared)).toBe(12);
    expect(received.size).toBe(32);
    expect(sent).toEqual([{ sink: "test_hook", ids: ids.slice(32) }]);
    // The eight sent back were never claimed.
    const left = await Promise.all(ids.slice(32).map(effectRow));
    expect(left.every((row) => row?.attempts === 0 && row.lease_token === null)).toBe(true);
  });

  it("counts the bytes an effect keeps elsewhere in the same budget, claimed and debited alike", async () => {
    const repoId = await listedRepo();
    const KiB = 1024;
    const big = await dueEffects(repoId, 3, T0, JSON.stringify({ externalBytes: 600 * KiB }));
    const { sink, received } = recordingSink();
    const { publish, sent } = recordingPublish();
    const shared = budget(T0);
    // The first whatever its size; the second would pass the 1 MiB.
    expect(await deliverEffects(depsOf([sink], T0, publish), "test_hook", big, shared)).toBe(1);
    expect(sent).toEqual([{ sink: "test_hook", ids: big.slice(1) }]);
    // What is left (about 424 KiB) takes a small one, not a second large one.
    const small = await dueEffects(
      await listedRepo(),
      1,
      T0,
      JSON.stringify({ externalBytes: 100 * KiB }),
    );
    expect(await deliverEffects(depsOf([sink], T0, publish), "test_hook", small, shared)).toBe(1);
    expect(shared.bytes).toBeLessThan(1024 * KiB - 700 * KiB);
    expect(received.size).toBe(2);
    // A value that is no count charges nothing more.
    const odd = await dueEffects(await listedRepo(), 1, T0, JSON.stringify({ externalBytes: "x" }));
    expect(await deliverEffects(depsOf([sink], T0, publish), "test_hook", odd, budget(T0))).toBe(1);
  });

  it("claims a bounded number of payload bytes, the first effect whatever its size", async () => {
    const repoId = await listedRepo();
    const payload = JSON.stringify({ body: "x".repeat(200 * 1024) });
    expect(EFFECT_POLICY.invocation.bytes).toBe(1024 * 1024);
    expect(5 * payload.length).toBeLessThanOrEqual(EFFECT_POLICY.invocation.bytes);
    expect(6 * payload.length).toBeGreaterThan(EFFECT_POLICY.invocation.bytes);
    const ids = await dueEffects(repoId, 8, T0, payload);
    const { sink, received } = recordingSink();
    const { publish, sent } = recordingPublish();
    expect(await deliverEffects(depsOf([sink], T0, publish), "test_hook", ids, budget(T0))).toBe(5);
    expect(received.size).toBe(5);
    expect(sent).toEqual([{ sink: "test_hook", ids: ids.slice(5) }]);

    const tiny = { ...EFFECT_POLICY, invocation: { ...EFFECT_POLICY.invocation, bytes: 10 } };
    const next = depsOf([sink], T0, publish, tiny);
    expect(await deliverEffects(next, "test_hook", ids.slice(5), budget(T0, tiny))).toBe(1);
    expect(sent.at(-1)).toEqual({ sink: "test_hook", ids: ids.slice(6) });
  });

  it("gives back what a batch sink's calls cannot cover, uncounted, and sends it back", async () => {
    const repoId = await listedRepo();
    const ids = await dueEffects(repoId, 4, T0, JSON.stringify({ calls: 40 }));
    const delivered: string[] = [];
    const sink: EffectSink = {
      name: "test_hook",
      plan: () => [],
      deliver: async () => {},
      deliverBatch: async (effects) => {
        delivered.push(...effects.map((effect) => effect.id));
        return { delivered: effects.map((effect) => effect.id) };
      },
      calls: (planned) => (planned.payload as { calls: number }).calls,
    };
    const { publish, sent } = recordingPublish();
    const small = { ...EFFECT_POLICY, invocation: { ...EFFECT_POLICY.invocation, calls: 100 } };
    // 100 calls: the message's own, then two effects of 40.
    expect(MESSAGE_CALLS + 2 * 40).toBeLessThanOrEqual(100);
    expect(
      await deliverEffects(depsOf([sink], T0, publish, small), "test_hook", ids, budget(T0, small)),
    ).toBe(2);
    expect(delivered).toEqual(ids.slice(0, 2));
    expect(sent).toEqual([{ sink: "test_hook", ids: ids.slice(2) }]);
    for (const id of ids.slice(2))
      expect(await effectRow(id)).toMatchObject({ attempts: 0, lease_token: null });
  });

  it("starts no delivery past its deadline: what is left goes back uncounted", async () => {
    const repoId = await listedRepo();
    const ids = await dueEffects(repoId, 3, T0);
    let clock = T0;
    const calls: string[] = [];
    const slow: EffectSink = {
      name: "test_hook",
      plan: () => [],
      deliver: async (effect) => {
        calls.push(effect.id);
        clock += EFFECT_POLICY.invocation.deadlineMs;
      },
    };
    const { publish, sent } = recordingPublish();
    const shared = budget(T0);
    expect(
      await deliverEffects(
        depsOf([slow], () => clock, publish),
        "test_hook",
        ids,
        shared,
      ),
    ).toBe(1);
    expect(calls).toEqual(ids.slice(0, 1));
    expect(sent).toEqual([{ sink: "test_hook", ids: ids.slice(1) }]);
    for (const id of ids.slice(1))
      expect(await effectRow(id)).toMatchObject({ attempts: 0, lease_token: null });
    // A later message of the same invocation starts nothing either.
    const [other = ""] = await dueEffects(await listedRepo(), 1, T0);
    expect(
      await deliverEffects(
        depsOf([slow], () => clock, publish),
        "test_hook",
        [other],
        shared,
      ),
    ).toBe(0);
    expect(sent.at(-1)).toEqual({ sink: "test_hook", ids: [other] });
  });
  it("starts nothing when its deadline passed during the claim, unless it is the invocation's first", async () => {
    const { publish, sent } = recordingPublish();
    for (const batched of [false, true]) {
      const repoId = await listedRepo();
      const ids = await dueEffects(repoId, 2, T0);
      const delivered: string[] = [];
      const sink: EffectSink = {
        name: "test_hook",
        plan: () => [],
        deliver: async (effect) => {
          delivered.push(effect.id);
        },
        ...(batched && {
          deliverBatch: async (effects: readonly Effect[]) => {
            delivered.push(...effects.map((effect) => effect.id));
            return { delivered: effects.map((effect) => effect.id) };
          },
        }),
      };
      let clock = T0;
      // The claim takes until past the deadline.
      const slowClaim = new Proxy(env.ORG_READ, {
        get(target, prop) {
          if (prop === "batch")
            return async (statements: D1PreparedStatement[]) => {
              const results = await target.batch(statements);
              clock += EFFECT_POLICY.invocation.deadlineMs;
              return results;
            };
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const deps = { ...depsOf([sink], () => clock, publish), db: admitted(slowClaim) };
      // An invocation that already delivered: nothing starts, and the claims are given back.
      const started = { ...budget(T0), started: true };
      expect(await deliverEffects(deps, "test_hook", ids, started)).toBe(0);
      expect(delivered).toEqual([]);
      expect(sent.at(-1)).toEqual({ sink: "test_hook", ids });
      for (const id of ids)
        expect(await effectRow(id)).toMatchObject({ attempts: 0, lease_token: null });
      // Its first effect alone goes all the same; the other is given back.
      clock = T0;
      expect(await deliverEffects(deps, "test_hook", ids, budget(T0))).toBe(1);
      expect(delivered).toEqual(ids.slice(0, 1));
      expect(sent.at(-1)).toEqual({ sink: "test_hook", ids: ids.slice(1) });
      expect(await effectRow(ids[1] ?? "")).toMatchObject({ attempts: 0, lease_token: null });
    }
  });
});

describe("effects queue messages", () => {
  it("are split by count and by bytes, each under one queue operation's 64 KB", () => {
    const ids = Array.from({ length: 25 }, (_, i) => `id_${i}`);
    expect(effectMessages("feed", ids, 10).map((m) => m.ids.length)).toEqual([10, 10, 5]);
    // References name their target repository: long ids, many to an event.
    const long = Array.from({ length: 2_500 }, (_, i) => `${"r".repeat(70)}:${i}`);
    const messages = effectMessages("references", long, 10_000);
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages)
      expect(new TextEncoder().encode(JSON.stringify(message)).length).toBeLessThanOrEqual(
        MESSAGE_BYTES,
      );
    expect(messages.flatMap((m) => m.ids)).toEqual(long);
  });

  it("give an effect its sink sends alone a message of its own, the others packed around it in order", () => {
    const ids = ["a:feed:feed", "a:feed:page:1", "a:feed:page:2", "b:feed:feed", "c:feed:feed"];
    const alone = (id: string) => id.includes(":page:");
    expect(effectMessages("feed", ids, 8, alone).map((m) => m.ids)).toEqual([
      ["a:feed:feed"],
      ["a:feed:page:1"],
      ["a:feed:page:2"],
      ["b:feed:feed", "c:feed:feed"],
    ]);
    expect(effectMessages("feed", ["a:feed:page:1"], 8, alone).map((m) => m.ids)).toEqual([
      ["a:feed:page:1"],
    ]);
    // Without such a rule, by count as before.
    expect(effectMessages("feed", ids, 8).map((m) => m.ids)).toEqual([ids]);
  });

  it("send each of the feed's audience pages alone, and its other effects 8 a message", async () => {
    const sent: EffectMessage[] = [];
    const queue = {
      send: async () => {},
      sendBatch: async (messages: MessageSendRequest<EffectMessage>[]) => {
        sent.push(...messages.map((m) => m.body));
      },
    } as unknown as Queue<EffectMessage>;
    const pages = Array.from({ length: 3 }, (_, i) => `r:1:1:e:feed:page:${i + 1}`);
    const small = Array.from({ length: 11 }, (_, i) => `r:1:1:e${i}:feed:feed`);
    await publisher({ feed: queue }, [feedSink])("feed", [
      ...small.slice(0, 2),
      ...pages,
      ...small.slice(2),
    ]);
    expect(sent.map((m) => m.ids)).toEqual([
      small.slice(0, 2),
      [pages[0]],
      [pages[1]],
      [pages[2]],
      // Nine in a row: eight, then one.
      small.slice(2, 10),
      small.slice(10),
    ]);
  });

  it("count each message sent, not each call sending them", async () => {
    const queue = {
      send: async () => {},
      sendBatch: async () => {},
    } as unknown as Queue<EffectMessage>;
    let counted = 0;
    const metrics = {
      count(name: string, dimensions: Record<string, string>, value = 1) {
        if (name === "queue.send" && dimensions.queue === "effects_test_hook") counted += value;
      },
    } as unknown as Metrics;
    const { sink } = recordingSink({ perMessage: 1 });
    await publisher(
      { test_hook: queue },
      [sink],
      metrics,
    )(
      "test_hook",
      Array.from({ length: 150 }, (_, i) => `id_${i}`),
    );
    expect(counted).toBe(150);
    // None that could not be sent.
    const down = {
      sendBatch: async () => {
        throw new Error("queue down");
      },
    } as unknown as Queue<EffectMessage>;
    await expect(
      publisher({ test_hook: down }, [sink], metrics)("test_hook", ["id_x"]),
    ).rejects.toThrow(/queue down/);
    expect(counted).toBe(150);
  });

  it("go out in sendBatch calls of at most 100 messages, with their delay", async () => {
    const batches: MessageSendRequest<EffectMessage>[][] = [];
    const queue = {
      send: async () => {},
      sendBatch: async (messages: MessageSendRequest<EffectMessage>[]) => {
        batches.push(messages);
      },
    } as unknown as Queue<EffectMessage>;
    const { sink } = recordingSink({ perMessage: 1 });
    const publish = publisher({ test_hook: queue }, [sink]);
    await publish(
      "test_hook",
      Array.from({ length: 150 }, (_, i) => `id_${i}`),
      90.5,
    );
    expect(batches.map((b) => b.length)).toEqual([100, 50]);
    expect(batches[0]?.[0]).toEqual({
      body: { v: 1, sink: "test_hook", ids: ["id_0"] },
      contentType: "json",
      delaySeconds: 91,
    });
    await expect(publish("no_such_sink", ["x"])).rejects.toThrow(/no queue/);
  });

  it("are acknowledged once delivered, retried when an outcome cannot be recorded, dropped when malformed", async () => {
    const repoId = await listedRepo();
    const ids = await dueEffects(repoId, 2, Date.now());
    const { sink, received } = recordingSink();
    const { publish } = recordingPublish();
    const batch = createMessageBatch("fyrden-effects-webhooks", [
      { id: "good", timestamp: new Date(), attempts: 1, body: { v: 1, sink: "webhooks", ids } },
      { id: "bad", timestamp: new Date(), attempts: 1, body: { v: 2 } },
      // Another sink's effects on this queue: dropped (the cron sends them where they belong).
      { id: "other", timestamp: new Date(), attempts: 1, body: { v: 1, sink: "feed", ids } },
    ]);
    // This queue's sink, as the deployment names it, delivering like the recording sink.
    const webhooks = { ...sink, name: "webhooks" };
    await admitted()
      .prepare("UPDATE effects SET sink = 'webhooks' WHERE effect_id LIKE ?")
      .bind(`${repoId}:%`)
      .run();
    await consumeEffects(batch, env, { sinks: [webhooks], publish });
    expect(await getQueueResult(batch, createExecutionContext())).toMatchObject({
      explicitAcks: ["good", "bad", "other"],
      retryMessages: [],
    });
    expect(received.size).toBe(2);

    // Marking the outcome fails: the message is retried, and its retry finds the effect claimed.
    const [id = ""] = await dueEffects(await listedRepo(), 1, Date.now());
    await admitted()
      .prepare("UPDATE effects SET sink = 'webhooks' WHERE effect_id = ?")
      .bind(id)
      .run();
    const lostMark = new Proxy(env.ORG_READ, {
      get(target, prop) {
        if (prop === "prepare")
          return (query: string) => {
            if (query.startsWith("UPDATE effects SET state = 'done'")) throw new Error("D1 down");
            return target.prepare(query);
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const failing = new Proxy(env, {
      get: (target, prop) => (prop === "ORG_READ" ? lostMark : Reflect.get(target, prop)),
    });
    const retried = createMessageBatch("fyrden-effects-webhooks", [
      {
        id: "lost",
        timestamp: new Date(),
        attempts: 1,
        body: { v: 1, sink: "webhooks", ids: [id] },
      },
    ]);
    await consumeEffects(retried, failing, { sinks: [webhooks], publish });
    expect(await getQueueResult(retried, createExecutionContext())).toMatchObject({
      explicitAcks: [],
      retryMessages: [{ msgId: "lost" }],
    });
  });
});

describe("recovering overdue effects", () => {
  it("sends a message again for overdue effects only, a page a run, the longest overdue first", async () => {
    const repoId = await listedRepo();
    const now = 1_000;
    // Overdue at 1, 2, ... (before anything other tests in this file leave).
    const ids = await dueEffects(repoId, 5, 0, "{}", 1);
    for (const [i, id] of ids.entries())
      await admitted()
        .prepare("UPDATE effects SET recover_at = ? WHERE effect_id = ?")
        .bind(i + 1, id)
        .run();
    const notYet = await dueEffects(await listedRepo(), 1, 0, "{}", 10_000_000);
    const { sink, calls } = recordingSink();
    const { publish, sent } = recordingPublish();
    const policy = { ...EFFECT_POLICY, recoverPage: 3 };
    const deps = depsOf([sink], now, publish, policy);
    expect(await recoverEffects(deps)).toEqual({ sent: 3, ended: 0 });
    expect(sentOf(sent, repoId)).toEqual(ids.slice(0, 3));
    // Moved on: the next run reaches the others, not these again.
    expect(await recoverEffects(deps)).toEqual({ sent: 2, ended: 0 });
    expect(sentOf(sent, repoId)).toEqual(ids);
    expect(await recoverEffects(deps)).toEqual({ sent: 0, ended: 0 });
    expect(sent.flatMap((s) => s.ids)).not.toContain(notYet[0]);
    // It delivers nothing itself.
    expect(calls).toEqual([]);
    expect(await effectRow(ids[0] ?? "")).toMatchObject({
      state: "pending",
      attempts: 0,
      recover_at: now + policy.lateMs,
    });
  });

  it("makes effects overdue again when their message cannot be sent", async () => {
    const repoId = await listedRepo();
    const now = 2_000;
    const [id = ""] = await dueEffects(repoId, 1, 0, "{}", 1);
    const { sink } = recordingSink();
    const { publish, failNext, sent } = recordingPublish();
    failNext(1);
    await expect(recoverEffects(depsOf([sink], now, publish))).rejects.toThrow(/send/);
    expect(await effectRow(id)).toMatchObject({ recover_at: now });
    await recoverEffects(depsOf([sink], now, publish));
    expect(sentOf(sent, repoId)).toEqual([id]);
  });

  it("recovers effects the Worker before this migration journals during a deploy", async () => {
    const repoId = await listedRepo();
    const id = idOf(repoId, 1);
    // That Worker's insert: none of the new columns.
    await admitted()
      .prepare(
        `INSERT OR IGNORE INTO effects (effect_id, sink, target, payload, next_attempt_at, created_at)
       VALUES (?, 'test_hook', 'hook_1', '{}', ?, ?)`,
      )
      .bind(id, T0 + 60_000, T0)
      .run();
    expect(await effectRow(id)).toMatchObject({ recover_at: 0, source_id: null });
    const { sink, received } = recordingSink();
    const { publish, sent } = recordingPublish();
    await recoverEffects(depsOf([sink], 4_000, publish));
    expect(sentOf(sent, repoId)).toEqual([id]);
    // Delivered unchecked once due, as it was before.
    const due = T0 + 60_000;
    await deliverEffects(depsOf([sink], due, publish), "test_hook", [id], budget(due));
    expect([...received.keys()]).toEqual([id]);
  });

  it("reads overdue effects through their index, and only those", async () => {
    const repoId = await listedRepo();
    // Many pending effects not overdue: the recovery reads none of them.
    await dueEffects(repoId, 500, 0, "{}", Number.MAX_SAFE_INTEGER);
    const [id = ""] = await dueEffects(await listedRepo(), 1, 0, "{}", 1);
    // What each statement read, as its batch reports it (the executor's admission included).
    const statements: { query: string; rowsRead: number }[] = [];
    const recording = new Proxy(env.ORG_READ, {
      get(target, prop) {
        if (prop === "batch")
          return async (batch: D1PreparedStatement[]) => {
            const results = await target.batch(batch);
            batch.forEach((statement, i) => {
              const query = (statement as unknown as { statement?: string }).statement ?? "";
              if (query.includes("ORDER BY recover_at"))
                statements.push({ query, rowsRead: results[i]?.meta.rows_read ?? 0 });
            });
            return results;
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const { sink } = recordingSink();
    const { publish, sent } = recordingPublish();
    await recoverEffects({ ...depsOf([sink], 3_000, publish), db: admitted(recording) });
    expect(sent.flatMap((s) => s.ids)).toContain(id);
    const [claim] = statements;
    expect(claim?.rowsRead).toBeLessThan(50);
    const select = claim?.query.match(/SELECT effect_id FROM effects WHERE[^)]*LIMIT \?3/)?.[0];
    const { results } = await admitted()
      .prepare(`EXPLAIN QUERY PLAN ${select}`)
      .bind(3_000, 0, 10)
      .all<{ detail: string }>();
    const plan = results.map((row) => row.detail).join("\n");
    expect(plan).toMatch(/USING (COVERING )?INDEX effects_recover \(recover_at<\?\)/);
    expect(plan).not.toMatch(/TEMP B-TREE/);
  });

  it("deletes delivered effects after the retention", async () => {
    const repoId = await listedRepo();
    const [id = ""] = await dueEffects(repoId, 1, T0);
    const { sink } = recordingSink();
    const { publish } = recordingPublish();
    await deliverEffects(depsOf([sink], T0, publish), "test_hook", [id], budget(T0));
    await pruneEffects(depsOf([sink], T0 + EFFECT_POLICY.retentionMs - 1, publish));
    expect(await effectRows(repoId)).toHaveLength(1);
    await pruneEffects(depsOf([sink], T0 + EFFECT_POLICY.retentionMs, publish));
    expect(await effectRows(repoId)).toEqual([]);
  });
});

describe("the effects cron", () => {
  it("reconciles webhook deliveries, then recovers overdue effects without delivering them", async () => {
    const repoId = await listedRepo();
    const [id = ""] = await dueEffects(repoId, 1, 0, "{}", 1);
    // A delivery past retention whose body was never stored: reconciling deletes it.
    const delivery = `${repoId}-delivery`;
    await admitted()
      .prepare(
        `INSERT INTO webhook_deliveries (delivery_id, repo_id, hook_id, event, action, private,
         payload_key, state, reason, attempts, next_attempt_at, created_at, updated_at, expires_at)
       VALUES (?, ?, 1, 'push', NULL, 1, ?, 'dropped', 'payload_too_large', 0, 0, 0, 0, 1)`,
      )
      .bind(delivery, repoId, `webhooks/${delivery}.json`)
      .run();
    const { sink, calls } = recordingSink();
    const { publish, sent } = recordingPublish();
    await runEffectsCron(env, {
      metrics: { count: () => {} },
      now: () => 5_000,
      sinks: [sink],
      publish,
    });
    expect(
      await admitted()
        .prepare("SELECT 1 FROM webhook_deliveries WHERE delivery_id = ?")
        .bind(delivery)
        .first(),
    ).toBeNull();
    expect(sent.flatMap((s) => s.ids)).toContain(id);
    expect(calls).toEqual([]);
  });
});
