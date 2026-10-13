import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  createIdFactory,
  type DomainEvent,
  type Envelope,
  secureRandomBytes,
} from "@fyrden/domain";
import { describe, expect, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { dispatchEffects, sweepEffects } from "../src/effects/dispatcher.js";
import { EFFECT_POLICY, type Effect, type EffectSink } from "../src/effects/journal.js";
import { applyEnvelope } from "../src/queues/events-consumer.js";

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

function pushEvent(repoId: string, seq: number, epochGen = 1): DomainEvent {
  return {
    id: { sourceId: repoId, epochGen, sourceSeq: seq },
    type: "refs.updated",
    at: T0,
    actor: OWNER,
    actChain: [],
    ownerGen: 1,
    entity: null,
    data: { via: "push", refs: [{ ref: "refs/heads/main", old: null, new: "a".repeat(40) }] },
    stored: false,
  };
}

const envelope = (repoId: string, events: DomainEvent[]): Envelope => ({
  sourceId: repoId,
  events,
});

/**
 * A sink with one target per push event, recording deliveries as a real
 * destination would: deduped by effect id, with every attempt counted.
 */
function recordingSink() {
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
  };
  return { sink, received, calls, failNext: (n: number) => (failing = n) };
}

async function effectRows(repoId: string) {
  const { results } = await env.ORG_READ.prepare(
    "SELECT effect_id, state, attempts FROM effects WHERE effect_id LIKE ? ORDER BY effect_id",
  )
    .bind(`${repoId}:%`)
    .all<{ effect_id: string; state: string; attempts: number }>();
  return results;
}

const sweep = (sinks: readonly EffectSink[], now: number, db: D1Database = env.ORG_READ) =>
  sweepEffects({ db, env, sinks, now: () => now });

describe("effects journal", () => {
  it("journals an event's effect with its projection and delivers it once", async () => {
    const repoId = await listedRepo();
    const { sink, received, calls } = recordingSink();
    await applyEnvelope(env, envelope(repoId, [pushEvent(repoId, 1)]), {
      sinks: [sink],
      now: () => T0,
    });
    expect(await effectRows(repoId)).toEqual([
      { effect_id: `${repoId}:1:1:test_hook:hook_1`, state: "done", attempts: 0 },
    ]);
    expect([...received.keys()]).toEqual([`${repoId}:1:1:test_hook:hook_1`]);

    // A duplicate delivery of the event adds no effect and delivers nothing again.
    await applyEnvelope(env, envelope(repoId, [pushEvent(repoId, 1)]), {
      sinks: [sink],
      now: () => T0,
    });
    expect(await effectRows(repoId)).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("retries a failed delivery from the sweeper, with backoff", async () => {
    const repoId = await listedRepo();
    const { sink, received, failNext } = recordingSink();
    failNext(2);
    await applyEnvelope(env, envelope(repoId, [pushEvent(repoId, 1)]), {
      sinks: [sink],
      now: () => T0,
    });
    expect(await effectRows(repoId)).toMatchObject([{ state: "pending", attempts: 1 }]);
    // Not due yet: nothing happens.
    await sweep([sink], T0 + 1);
    expect(await effectRows(repoId)).toMatchObject([{ attempts: 1 }]);
    await sweep([sink], T0 + EFFECT_POLICY.backoffMs);
    expect(await effectRows(repoId)).toMatchObject([{ state: "pending", attempts: 2 }]);
    await sweep([sink], T0 + 10 * EFFECT_POLICY.backoffMs);
    expect(await effectRows(repoId)).toMatchObject([{ state: "done" }]);
    expect(received.size).toBe(1);
  });

  it("delivers again with the same id after a crash between delivery and the mark, and the destination dedupes", async () => {
    const repoId = await listedRepo();
    const { sink, received, calls } = recordingSink();
    // The mark after the first delivery is lost.
    let dropped = false;
    const losingMark = new Proxy(env.ORG_READ, {
      get(target, prop) {
        if (prop === "prepare")
          return (query: string) => {
            if (!dropped && query.startsWith("UPDATE effects SET state = 'done'")) {
              dropped = true;
              throw new Error("crash");
            }
            return target.prepare(query);
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const crashing = new Proxy(env, {
      get: (target, prop) => (prop === "ORG_READ" ? losingMark : Reflect.get(target, prop)),
    });
    await applyEnvelope(crashing, envelope(repoId, [pushEvent(repoId, 1)]), {
      sinks: [sink],
      now: () => T0,
    });
    expect(await effectRows(repoId)).toMatchObject([{ state: "pending" }]);
    // Not while the lost delivery's claim lasts.
    await sweep([sink], T0 + EFFECT_POLICY.sweepAfterMs);
    expect(calls).toHaveLength(1);
    await sweep([sink], T0 + EFFECT_POLICY.leaseMs);
    expect(await effectRows(repoId)).toMatchObject([{ state: "done" }]);
    expect(calls).toEqual([`${repoId}:1:1:test_hook:hook_1`, `${repoId}:1:1:test_hook:hook_1`]);
    expect(received.size).toBe(1);
  });

  it("keeps a failed effect's backoff when its event is delivered again", async () => {
    const repoId = await listedRepo();
    const { sink, calls, failNext } = recordingSink();
    failNext(1);
    const body = envelope(repoId, [pushEvent(repoId, 1)]);
    await applyEnvelope(env, body, { sinks: [sink], now: () => T0 });
    await applyEnvelope(env, body, { sinks: [sink], now: () => T0 + 1 });
    expect(calls).toHaveLength(1);
    expect(await effectRows(repoId)).toMatchObject([{ state: "pending", attempts: 1 }]);
  });

  it("never lets the consumer and the sweeper deliver one effect at once", async () => {
    const repoId = await listedRepo();
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
      plan: () => [{ target: "hook_1", payload: {} }],
      // The sweep is global: only this repository's effect is held.
      deliver: async (effect) => {
        if (!effect.id.startsWith(`${repoId}:`)) return;
        calls.push(effect.id);
        started();
        await gate;
      },
    };
    const consuming = applyEnvelope(env, envelope(repoId, [pushEvent(repoId, 1)]), {
      sinks: [slow],
      now: () => T0,
    });
    // While the consumer is delivering, sweep as if the effect were due.
    await delivering;
    await sweep([slow], T0 + EFFECT_POLICY.sweepAfterMs);
    release();
    await consuming;
    expect(calls).toHaveLength(1);
    expect(await effectRows(repoId)).toMatchObject([{ state: "done" }]);
  });

  it("lets the sweeper take over an expired claim, and ignores the late outcome of the old holder", async () => {
    const repoId = await listedRepo();
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
      plan: () => [{ target: "hook_1", payload: {} }],
      deliver: async (effect) => {
        if (!effect.id.startsWith(`${repoId}:`)) return;
        if (!first) return;
        first = false;
        started();
        await gate;
        // The old holder fails, long after its claim expired.
        throw new Error("too late");
      },
    };
    const consuming = applyEnvelope(env, envelope(repoId, [pushEvent(repoId, 1)]), {
      sinks: [sink],
      now: () => T0,
    });
    await delivering;
    await sweep([sink], T0 + EFFECT_POLICY.leaseMs);
    expect(await effectRows(repoId)).toMatchObject([{ state: "done", attempts: 0 }]);
    release();
    await consuming;
    expect(await effectRows(repoId)).toMatchObject([{ state: "done", attempts: 0 }]);
  });

  it("does not deliver at once an effect the sweeper already tried", async () => {
    const repoId = await listedRepo();
    const { sink, calls } = recordingSink();
    await env.ORG_READ.prepare(
      `INSERT INTO effects (effect_id, sink, target, payload, attempts, next_attempt_at, created_at)
       VALUES (?, 'test_hook', 'hook_1', '{}', 1, ?, ?)`,
    )
      .bind(`${repoId}:1:1:test_hook:hook_1`, T0 + 90_000, T0)
      .run();
    await dispatchEffects({ db: env.ORG_READ, env, sinks: [sink], now: () => T0 }, [
      `${repoId}:1:1:test_hook:hook_1`,
    ]);
    expect(calls).toEqual([]);
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
    await applyEnvelope(env, envelope(repoId, [stored]), { sinks: [sink], now: () => T0 });
    expect(seen).toEqual([{ via: "push", refs: ["many"] }]);
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
      applyEnvelope(failing, envelope(repoId, [snapshot]), { sinks: [sink], now: () => T0 }),
    ).rejects.toThrow();
    const row = () =>
      env.ORG_READ.prepare("SELECT version FROM repos WHERE repo_id = ?").bind(repoId).first();
    expect(await row()).toBeNull();
    expect(await effectRows(repoId)).toEqual([]);
    await applyEnvelope(env, envelope(repoId, [snapshot]), { sinks: [sink], now: () => T0 });
    expect(await row()).toEqual({ version: 1 });
    expect(await effectRows(repoId)).toMatchObject([{ state: "done" }]);
  });

  it("journals nothing for an event of an older epoch", async () => {
    const repoId = await listedRepo();
    const { sink } = recordingSink();
    await applyEnvelope(env, envelope(repoId, [pushEvent(repoId, 1, 2)]), {
      sinks: [sink],
      now: () => T0,
    });
    await applyEnvelope(env, envelope(repoId, [pushEvent(repoId, 9, 1)]), {
      sinks: [sink],
      now: () => T0,
    });
    expect((await effectRows(repoId)).map((r) => r.effect_id)).toEqual([
      `${repoId}:2:1:test_hook:hook_1`,
    ]);
  });

  it("marks an effect failed after the last attempt, or when its sink is gone", async () => {
    const repoId = await listedRepo();
    const { sink, failNext } = recordingSink();
    failNext(1_000);
    await applyEnvelope(env, envelope(repoId, [pushEvent(repoId, 1)]), {
      sinks: [sink],
      now: () => T0,
    });
    let now = T0;
    for (let i = 0; i < EFFECT_POLICY.maxAttempts; i++) {
      now += EFFECT_POLICY.maxBackoffMs;
      await sweep([sink], now);
    }
    expect(await effectRows(repoId)).toMatchObject([
      { state: "failed", attempts: EFFECT_POLICY.maxAttempts },
    ]);

    const other = await listedRepo();
    await applyEnvelope(env, envelope(other, [pushEvent(other, 1)]), {
      sinks: [sink],
      now: () => T0,
    });
    await env.ORG_READ.prepare(
      "UPDATE effects SET state = 'pending', next_attempt_at = 0 WHERE effect_id LIKE ?",
    )
      .bind(`${other}:%`)
      .run();
    await sweep([], T0);
    expect(await effectRows(other)).toMatchObject([{ state: "failed" }]);
  });

  it("deletes delivered effects after the retention", async () => {
    const repoId = await listedRepo();
    const { sink } = recordingSink();
    await applyEnvelope(env, envelope(repoId, [pushEvent(repoId, 1)]), {
      sinks: [sink],
      now: () => T0,
    });
    await sweep([sink], T0 + EFFECT_POLICY.retentionMs - 1);
    expect(await effectRows(repoId)).toHaveLength(1);
    await sweep([sink], T0 + EFFECT_POLICY.retentionMs);
    expect(await effectRows(repoId)).toEqual([]);
  });
});
