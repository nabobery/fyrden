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
  secureRandomBytes,
} from "@fyrden/domain";
import { describe, expect, it } from "vitest";
import { runEffectsCron } from "../src/cron/effects.js";
import type { RepoDO } from "../src/do/RepoDO.js";
import { dispatchEffects, sweepEffects } from "../src/effects/dispatcher.js";
import {
  EFFECT_POLICY,
  type Effect,
  type EffectSink,
  INLINE_EFFECTS,
  INLINE_EFFECTS_ALONE,
  SINGLE_EFFECT_CALLS,
  SWEEP_ROUND_CALLS,
} from "../src/effects/journal.js";
import { applyEnvelope, consumeEvents, EVENTS_QUEUE } from "../src/queues/events-consumer.js";
import { settleOthersDue } from "./helpers/effects.js";

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
 * A sink with one target per push event, recording `repoId`'s deliveries as
 * a real destination would: deduped by effect id, with every attempt counted.
 * The sweep is global: other tests' effects are taken and not recorded.
 */
function recordingSink(repoId: string) {
  const received = new Map<string, Effect>();
  const calls: string[] = [];
  let failing = 0;
  const sink: EffectSink = {
    name: "test_hook",
    plan: (event) =>
      event.type === "refs.updated" ? [{ target: "hook_1", payload: { event: event.type } }] : [],
    deliver: async (effect) => {
      if (!effect.id.startsWith(`${repoId}:`)) return;
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
    const { sink, received, calls } = recordingSink(repoId);
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
    const { sink, received, failNext } = recordingSink(repoId);
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
    const { sink, received, calls } = recordingSink(repoId);
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
    const { sink, calls, failNext } = recordingSink(repoId);
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
    const { sink, calls } = recordingSink(repoId);
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
    const { sink } = recordingSink(repoId);
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
    const { sink, failNext } = recordingSink(repoId);
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
    const { sink } = recordingSink(repoId);
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

/** Journals `n` effects of `repoId` for the recording sink, due at `at`, each with `payload`. */
async function dueEffects(repoId: string, n: number, at: number, payload = "{}"): Promise<void> {
  await env.ORG_READ.prepare(
    `WITH RECURSIVE e(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM e WHERE i < ?2)
     INSERT INTO effects (effect_id, sink, target, payload, next_attempt_at, created_at)
     SELECT ?1 || ':1:' || i || ':test_hook:hook_1', 'test_hook', 'hook_1', ?4, ?3, ?3 FROM e`,
  )
    .bind(repoId, n, at, payload)
    .run();
}

/** How many of `repoId`'s effects are left, each checked untouched: never tried, unclaimed. */
async function untouched(repoId: string): Promise<number> {
  const { results } = await env.ORG_READ.prepare(
    `SELECT attempts, lease_token FROM effects WHERE effect_id LIKE ? AND state != 'done'`,
  )
    .bind(`${repoId}:%`)
    .all<{ attempts: number; lease_token: string | null }>();
  expect(results.every((r) => r.attempts === 0 && r.lease_token === null)).toBe(true);
  return results.length;
}

/** A sweep's claim of due effects: its SQL, its arguments and the rows D1 read for it. */
type Claim = { query: string; args: unknown[]; rowsRead: number };

/** `db`, recording each claim of due effects a sweep makes through it. */
function recordingClaims(db: D1Database): { db: D1Database; claims: Claim[] } {
  const claims: Claim[] = [];
  const recording = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare")
        return (query: string) => {
          const statement = target.prepare(query);
          if (!query.includes("row_number() OVER")) return statement;
          return {
            bind: (...args: unknown[]) => {
              const bound = statement.bind(...args);
              return {
                all: async () => {
                  const result = await bound.all();
                  claims.push({ query, args, rowsRead: result.meta.rows_read });
                  return result;
                },
              };
            },
          };
        };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: recording, claims };
}

describe("effects throughput", () => {
  it("delivers a bounded number of effects a run, and the next runs go on from there", async () => {
    const at = T0 + 1;
    await settleOthersDue(at);
    const repoId = await listedRepo();
    const { sink, received } = recordingSink(repoId);
    // A push moving 60 pull requests' heads leaves about this many webhook effects.
    await dueEffects(repoId, 60, T0);
    expect(EFFECT_POLICY.sweepLimit).toBe(20);
    expect(await sweep([sink], at)).toBe(20);
    expect(received.size).toBe(20);
    expect(await untouched(repoId)).toBe(40);
    expect(await sweep([sink], at)).toBe(20);
    expect(await sweep([sink], at)).toBe(20);
    expect((await effectRows(repoId)).every((row) => row.state === "done")).toBe(true);
  });

  it("claims a bounded number of payload bytes a run, and the next run goes on from there", async () => {
    const at = T0 + 3;
    await settleOthersDue(at);
    const repoId = await listedRepo();
    const { sink, received } = recordingSink(repoId);
    // Webhook effects of large bodies: five of them fit a run's bytes, a sixth would not.
    const payload = JSON.stringify({ body: "x".repeat(200 * 1024) });
    expect(EFFECT_POLICY.sweepBytes).toBe(1024 * 1024);
    expect(5 * payload.length).toBeLessThanOrEqual(EFFECT_POLICY.sweepBytes);
    expect(6 * payload.length).toBeGreaterThan(EFFECT_POLICY.sweepBytes);
    await dueEffects(repoId, 8, T0, payload);
    expect(await sweep([sink], at)).toBe(5);
    expect(received.size).toBe(5);
    expect(await untouched(repoId)).toBe(3);
    expect(await sweep([sink], at)).toBe(3);
    expect(received.size).toBe(8);
  });

  it("delivers a run's first effect even when it alone is past the run's bytes", async () => {
    const at = T0 + 4;
    await settleOthersDue(at);
    const repoId = await listedRepo();
    const { sink, received } = recordingSink(repoId);
    await dueEffects(repoId, 2, T0, JSON.stringify({ body: "x".repeat(100) }));
    const policy = { ...EFFECT_POLICY, sweepBytes: 10 };
    const run = () => sweepEffects({ db: env.ORG_READ, env, sinks: [sink], now: () => at, policy });
    expect(await run()).toBe(1);
    expect(await untouched(repoId)).toBe(1);
    expect(await run()).toBe(1);
    expect(received.size).toBe(2);
  });

  it("claims a burst due at one time by reading a page of it, oldest first and by id among equals", async () => {
    const at = T0 + 7;
    await settleOthersDue(at);
    const repoId = await listedRepo();
    const { sink, calls } = recordingSink(repoId);
    const burst = 1000;
    await dueEffects(repoId, burst, T0);
    // Due before the burst: it goes first, though its id sorts after every one of the burst's.
    const earlier = `${repoId}:2:1:test_hook:hook_1`;
    await env.ORG_READ.prepare(
      `INSERT INTO effects (effect_id, sink, target, payload, next_attempt_at, created_at)
       VALUES (?1, 'test_hook', 'hook_1', '{}', ?2, ?2)`,
    )
      .bind(earlier, T0 - 1)
      .run();
    const { db, claims } = recordingClaims(env.ORG_READ);
    const limit = EFFECT_POLICY.sweepLimit;
    expect(await sweep([sink], at, db)).toBe(limit);

    // The rows the claim always took: by due time, then by id (as text) among the burst's.
    const byId = Array.from({ length: burst }, (_, i) => `${repoId}:1:${i + 1}:test_hook:hook_1`);
    byId.sort();
    expect([...calls].sort()).toEqual([earlier, ...byId.slice(0, limit - 1)].sort());
    // One claim, reading in index order and stopping after its page, with no sort: a few rows
    // read for each effect it claims (161 measured for 20, the same with a burst of 30 or
    // 3,000), where reading and sorting the whole burst read 1,163.
    expect(claims).toHaveLength(1);
    const claim = claims[0] as Claim;
    expect(claim.rowsRead).toBeLessThanOrEqual(10 * limit);
    const { results } = await env.ORG_READ.prepare(`EXPLAIN QUERY PLAN ${claim.query}`)
      .bind(...claim.args)
      .all<{ detail: string }>();
    const plan = results.map((row) => row.detail).join("\n");
    expect(plan).toMatch(/SEARCH effects USING INDEX effects_due_order \(next_attempt_at<\?\)/);
    expect(plan).not.toMatch(/TEMP B-TREE/);
  });

  it("gives each page a claim from when it is taken, so a slow sweep's later page is not taken over", async () => {
    const at = T0 + 5;
    const later = at + EFFECT_POLICY.leaseMs + 1;
    await settleOthersDue(later);
    const repoId = await listedRepo();
    await dueEffects(repoId, 4, T0);
    // The first page of two takes longer than a claim lasts to deliver; a sweep starting then
    // overlaps the second page.
    let clock = at;
    const calls: string[] = [];
    let overlapping: Promise<number> | undefined;
    const policy = { ...EFFECT_POLICY, sweepPage: 2 };
    const sink: EffectSink = {
      name: "test_hook",
      plan: () => [],
      deliver: async (effect) => {
        if (!effect.id.startsWith(`${repoId}:`)) return;
        calls.push(effect.id);
        if (calls.length === 2) clock = later;
        if (calls.length === 3) {
          overlapping = sweepEffects({
            db: env.ORG_READ,
            env,
            sinks: [sink],
            now: () => clock,
            policy,
          });
          await overlapping;
        }
      },
    };
    await sweepEffects({ db: env.ORG_READ, env, sinks: [sink], now: () => clock, policy });
    expect(await overlapping).toBe(0);
    expect([...calls].sort()).toEqual([1, 2, 3, 4].map((i) => `${repoId}:1:${i}:test_hook:hook_1`));
    expect((await effectRows(repoId)).every((row) => row.state === "done")).toBe(true);
  });

  it("delivers what the sweep's calls allow, a page at a time, and leaves the rest untouched", async () => {
    const at = T0 + 2;
    await settleOthersDue(at);
    const repoId = await listedRepo();
    const { sink, received } = recordingSink(repoId);
    await dueEffects(repoId, 30, T0);
    const policy = { ...EFFECT_POLICY, sweepPage: 4, sweepCalls: 100 };
    const delivered = await sweepEffects({
      db: env.ORG_READ,
      env,
      sinks: [sink],
      now: () => at,
      policy,
    });
    // Pages of 4 while their calls fit (each page's own calls first): 4, 4, then 3.
    expect(SWEEP_ROUND_CALLS + 4 * SINGLE_EFFECT_CALLS).toBe(36);
    expect(delivered).toBe(11);
    expect(received.size).toBe(11);
    const rows = await env.ORG_READ.prepare(
      `SELECT state, attempts, lease_token FROM effects WHERE effect_id LIKE ? AND state != 'done'`,
    )
      .bind(`${repoId}:%`)
      .all();
    expect(rows.results).toHaveLength(19);
    expect(rows.results.every((r) => r.attempts === 0 && r.lease_token === null)).toBe(true);
    // The next run goes on from there.
    await sweepEffects({ db: env.ORG_READ, env, sinks: [sink], now: () => at, policy });
    expect(received.size).toBe(22);
  });

  it("delivers more effects inline when the consumer's batch is small", async () => {
    const one = await listedRepo();
    const single = recordingSink(one);
    const events = Array.from({ length: 12 }, (_, i) => pushEvent(one, i + 1));
    const alone = createMessageBatch(EVENTS_QUEUE, [
      { id: "alone", timestamp: new Date(), attempts: 1, body: envelope(one, events) },
    ]);
    await consumeEvents(alone, env, { sinks: [single.sink], now: () => T0 });
    expect(await getQueueResult(alone, createExecutionContext())).toMatchObject({
      explicitAcks: ["alone"],
    });
    expect(single.received.size).toBe(INLINE_EFFECTS_ALONE);
    expect(INLINE_EFFECTS_ALONE).toBe(5);

    // A full batch of five messages shares the least.
    const repos = await Promise.all(Array.from({ length: 5 }, () => listedRepo()));
    const delivered: string[] = [];
    const sink: EffectSink = {
      name: "test_hook",
      plan: single.sink.plan,
      deliver: async (effect) => {
        if (repos.some((repoId) => effect.id.startsWith(`${repoId}:`))) delivered.push(effect.id);
      },
    };
    const full = createMessageBatch(
      EVENTS_QUEUE,
      repos.map((repoId, i) => ({
        id: `m${i}`,
        timestamp: new Date(),
        attempts: 1,
        body: envelope(
          repoId,
          [1, 2, 3].map((seq) => pushEvent(repoId, seq)),
        ),
      })),
    );
    await consumeEvents(full, env, { sinks: [sink], now: () => T0 });
    expect(delivered).toHaveLength(INLINE_EFFECTS);
  });
});

describe("the effects cron", () => {
  it("reconciles webhook deliveries before its sweep, so a run cut short has reconciled", async () => {
    const at = T0 + 6;
    await settleOthersDue(at);
    const repoId = await listedRepo();
    await dueEffects(repoId, 1, T0);
    // A delivery past retention whose body was never stored: reconciling deletes it.
    const delivery = `${repoId}-delivery`;
    await env.ORG_READ.prepare(
      `INSERT INTO webhook_deliveries (delivery_id, repo_id, hook_id, event, action, private,
         payload_key, state, reason, attempts, next_attempt_at, created_at, updated_at, expires_at)
       VALUES (?, ?, 1, 'push', NULL, 1, ?, 'dropped', 'payload_too_large', 0, 0, 0, 0, 1)`,
    )
      .bind(delivery, repoId, `webhooks/${delivery}.json`)
      .run();
    // What the invocation had done when the sweep began delivering, had it been stopped there.
    let reconciledFirst: boolean | undefined;
    const sink: EffectSink = {
      name: "test_hook",
      plan: () => [],
      deliver: async (effect) => {
        if (!effect.id.startsWith(`${repoId}:`)) return;
        reconciledFirst =
          (await env.ORG_READ.prepare("SELECT 1 FROM webhook_deliveries WHERE delivery_id = ?")
            .bind(delivery)
            .first()) === null;
      },
    };
    await runEffectsCron(env, { metrics: { count: () => {} }, now: () => at, sinks: [sink] });
    expect(reconciledFirst).toBe(true);
    expect(await effectRows(repoId)).toMatchObject([{ state: "done" }]);
  });
});
