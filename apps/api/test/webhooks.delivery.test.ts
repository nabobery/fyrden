// Webhook deliveries: made from events (row, body, message) within the
// journal's and the consumer's budgets, each attempt signed, posted through
// the SSRF guard and recorded, retried, failed or cancelled as its answer
// says; and the cron's share (late messages sent again, hooks a 410 turns
// off, retention). The cron sees every delivery in this file's database,
// other tests' too: a test that runs it either orders its own rows first
// or runs it until its own are handled.
import { env } from "cloudflare:workers";
import { METRIC_AGGREGATION, type Metrics } from "@fyrden/adapters-cloudflare/obs";
import { type DomainEvent, eventKey } from "@fyrden/domain";
import { describe, expect, it, vi } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import {
  type Effect,
  type EffectSink,
  effectCalls,
  effectStatements,
} from "../src/effects/journal.js";
import { applyEnvelope } from "../src/queues/events-consumer.js";
import { CLEANUP_POLICY } from "../src/repos/cleanups.js";
import { advanceDeletion } from "../src/repos/deletion.js";
import { ATTEMPT_POLICY, attemptDelivery, reconcileWebhooks } from "../src/webhooks/deliver.js";
import { signature } from "../src/webhooks/secrets.js";
import {
  bodyOf,
  createWebhookSink,
  deliveryIdOf,
  FIRST_ATTEMPTS,
  webhookSink,
} from "../src/webhooks/sink.js";
import { api, json } from "./helpers/api.js";
import { inRepo } from "./helpers/repo-git.js";
import { type HookOut, RECEIVER, webhookTest } from "./helpers/webhooks.js";

const t = webhookTest();

/** The effect `sink` plans for `event`, as the journal hands it over. */
function effectOf(sink: EffectSink, event: DomainEvent): Effect {
  const [planned] = sink.plan(event);
  if (!planned) throw new Error("the event makes no webhook effect");
  return { id: `effect_${eventKey(event.id)}`, sink: sink.name, ...planned, attempts: 1 };
}

describe("webhooks", () => {
  it("are delivered: one row, its body, a message; signed as Standard Webhooks says", async () => {
    const hook = (await t.createHook({ events: ["push"] })).body;
    await api("POST", `${t.path}/file-commits`, t.owner.token, {
      message: "first",
      changes: [{ path: "a.txt", content: "a\n" }],
    });
    const events = (await t.outbox()).filter((e) => e.webhooks);
    await t.materialize(events);
    await t.materialize(events);
    const rows = (await t.deliveries()).sort((a, b) => (a.event < b.event ? -1 : 1));
    expect(rows.map((r) => [r.event, r.state, r.private])).toEqual([
      ["ping", "pending", 1],
      ["push", "pending", 1],
    ]);
    // Made again: nothing more.
    expect(t.sent.map((s) => s.delivery).sort()).toEqual(rows.map((r) => r.delivery_id).sort());
    const push = rows[1] as (typeof rows)[number];
    expect(push.delivery_id).toBe(
      await deliveryIdOf(eventKey((events[1] as DomainEvent).id), hook.id),
    );

    await attemptDelivery(t.deps(), push.delivery_id);
    expect(t.received).toHaveLength(1);
    const request = t.received[0] as (typeof t.received)[number];
    expect(request.url).toBe(RECEIVER);
    const body = JSON.parse(request.body);
    expect(body).toMatchObject({
      event: "push",
      repository: { id: t.repo.id, name: t.repo.name, private: true },
      refs: [{ ref: "refs/heads/main", before: null, created: true, deleted: false }],
    });
    expect(request.headers.get("webhook-id")).toBe(push.delivery_id);
    const timestamp = Number(request.headers.get("webhook-timestamp"));
    expect(request.headers.get("webhook-signature")).toBe(
      await signature([hook.secret as string], {
        id: push.delivery_id,
        timestamp,
        body: new TextEncoder().encode(request.body),
      }),
    );
    expect((await t.deliveries()).find((d) => d.event === "push")).toMatchObject({
      state: "done",
      attempts: 1,
      last_status: 200,
    });
    // Done: another message makes no attempt.
    await attemptDelivery(t.deps(), push.delivery_id);
    expect(t.received).toHaveLength(1);
  });

  it("list a push's refs up to a bound, so its journal row stays within a D1 value", () => {
    const name = `refs/heads/${'q"'.repeat(480)}`;
    const refs = Array.from({ length: 500 }, (_, i) => ({
      ref: `${name}${i}`,
      old: null,
      new: "a".repeat(40),
    }));
    const body = bodyOf({
      id: { sourceId: "rep_0", epochGen: 1, sourceSeq: 1 },
      type: "refs.updated",
      at: 0,
      actor: null,
      actChain: [],
      ownerGen: 1,
      entity: null,
      data: { via: "push", refs },
      stored: false,
      webhooks: { hooks: [{ id: 1, v: 1 }], repo: { name: "r", ownerId: "usr_0", private: true } },
    }) as { refs: unknown[]; refs_count: number; refs_truncated: boolean };
    expect(body.refs_count).toBe(500);
    expect(body.refs_truncated).toBe(true);
    expect(body.refs.length).toBeLessThan(500);
    const bound = new TextEncoder().encode(JSON.stringify(JSON.stringify(body))).length;
    expect(bound).toBeLessThan(1_000_000);
  });

  it("leave a message to a later invocation once its calls are spent, never the first", async () => {
    await t.createHook();
    const events = (await t.outbox()).filter((e) => e.webhooks);
    const envelope = { sourceId: t.repo.id, events };
    const spent = { left: 1, reserved: 0, applied: true };
    expect(await applyEnvelope(t.testEnv(), envelope, { sinks: [webhookSink], calls: spent })).toBe(
      "deferred",
    );
    const fresh = { left: 1, reserved: 0, applied: false };
    expect(await applyEnvelope(t.testEnv(), envelope, { sinks: [webhookSink], calls: fresh })).toBe(
      "applied",
    );
  });

  it("journal an envelope of 50 large pushes in at most ten statements", () => {
    const name = `refs/heads/${'q"'.repeat(480)}`;
    const events: DomainEvent[] = Array.from({ length: 50 }, (_, n) => ({
      id: { sourceId: "rep_0", epochGen: 1, sourceSeq: n + 1 },
      type: "refs.updated",
      at: 0,
      actor: null,
      actChain: [],
      ownerGen: 1,
      entity: null,
      data: {
        via: "push",
        refs: Array.from({ length: 500 }, (_, i) => ({
          ref: `${name}${i}`,
          old: null,
          new: "a".repeat(40),
        })),
      },
      stored: false,
      webhooks: { hooks: [{ id: 1, v: 1 }], repo: { name: "r", ownerId: "usr_0", private: true } },
    }));
    expect(
      effectStatements(env.ORG_READ, [webhookSink], "rep_0", events, 0).length,
    ).toBeLessThanOrEqual(10);
  });

  it("are dropped, not sent empty, when an event's stored data cannot be read", async () => {
    await t.createHook();
    const ping = (await t.outbox()).find((e) => e.webhooks) as DomainEvent;
    // Still stored after hydration: its data was not found.
    await t.materialize([{ ...ping, data: null, stored: true }]);
    expect(await t.deliveries()).toEqual([
      expect.objectContaining({ state: "dropped", reason: "payload_missing" }),
    ]);
  });

  it("retry what may pass later, fail what will not, and turn a gone receiver's hook off", async () => {
    const hook = (await t.createHook()).body;
    await t.materialize((await t.outbox()).filter((e) => e.webhooks));
    const [ping] = await t.deliveries();
    const id = (ping as { delivery_id: string }).delivery_id;
    const now = Date.now();

    t.answer = () => new Response("busy", { status: 503, headers: { "retry-after": "30" } });
    await attemptDelivery(t.deps(now), id);
    expect((await t.deliveries())[0]).toMatchObject({
      state: "pending",
      attempts: 1,
      last_status: 503,
    });
    expect(t.sent.at(-1)).toEqual({ delivery: id, delaySeconds: 30 });
    // Not due yet.
    await attemptDelivery(t.deps(now + 1_000), id);
    expect(t.received).toHaveLength(1);

    t.answer = () => new Response("gone", { status: 410 });
    await attemptDelivery(t.deps(now + 31_000), id);
    expect((await t.deliveries())[0]).toMatchObject({
      state: "failed",
      reason: "gone",
      attempts: 2,
    });
    const after = await json<HookOut>(api("GET", `${t.path}/hooks/${hook.id}`, t.owner.token));
    expect(after.body).toMatchObject({
      active: false,
      disabled_reason: expect.stringContaining("410"),
      last_response: { code: 410, status: "failed" },
    });
  });

  it("count each retry and each late message sent again as a message sent", async () => {
    await t.createHook();
    await t.materialize((await t.outbox()).filter((e) => e.webhooks));
    const [ping] = await t.deliveries();
    const id = (ping as { delivery_id: string }).delivery_id;
    let counted = 0;
    const metrics = {
      count(name: string, dimensions: Record<string, string>, value = 1) {
        if (name === "queue.send" && dimensions.queue === "webhooks") counted += value;
      },
    } as unknown as Metrics;
    t.sent.length = 0;
    t.answer = () => new Response("busy", { status: 503, headers: { "retry-after": "30" } });
    await attemptDelivery({ ...t.deps(Date.now()), metrics }, id);
    expect(t.sent).toHaveLength(1);
    expect(counted).toBe(1);
    // Its retry's message lost, and the queue down: the cron sends nothing, counting nothing.
    const late = t.deps(Date.now() + 16 * 60_000);
    const down = {
      send: async () => {
        throw new Error("queue down");
      },
    };
    await expect(
      reconcileWebhooks({
        ...late,
        env: { ...late.env, WEBHOOKS: down } as unknown as Env,
        metrics,
      }),
    ).rejects.toThrow();
    expect(counted).toBe(1);
    // A later run sends it again (its failed send left it due from then), and any other late ones.
    await reconcileWebhooks({ ...t.deps(Date.now() + 32 * 60_000), metrics });
    expect(t.sent.length).toBeGreaterThan(1);
    expect(counted).toBe(t.sent.length);
  });

  it("are cancelled when their hook goes, and never go over http for a private repository", async () => {
    const hook = (await t.createHook()).body;
    await t.materialize((await t.outbox()).filter((e) => e.webhooks));
    await api("DELETE", `${t.path}/hooks/${hook.id}`, t.owner.token);
    expect((await t.deliveries())[0]).toMatchObject({ state: "cancelled", reason: "hook_deleted" });

    // An http hook (as one made while the repository was public), and a private repository's event.
    const second = (await t.createHook()).body;
    await inRepo(t.stub(), (r: RepoDO) => {
      r.git.context.storage.sql.exec(
        "UPDATE webhooks SET url = ? WHERE hook_id = ?",
        "http://93.184.216.34/hook",
        second.id,
      );
    });
    await t.materialize(
      (await t.outbox()).filter((e) => e.webhooks?.hooks.some((h) => h.id === second.id)),
    );
    const ping = (await t.deliveries()).find((d) => d.hook_id === second.id) as {
      delivery_id: string;
    };
    await attemptDelivery(t.deps(), ping.delivery_id);
    expect(t.received).toHaveLength(0);
    expect((await t.deliveries()).find((d) => d.hook_id === second.id)).toMatchObject({
      state: "failed",
      reason: "insecure_url",
    });
  });

  it("are sent again by the cron when their message is late, and pruned past retention", async () => {
    await t.createHook();
    await t.materialize((await t.outbox()).filter((e) => e.webhooks));
    const [ping] = await t.deliveries();
    const id = (ping as { delivery_id: string }).delivery_id;
    t.sent.length = 0;
    // Due, and its message lost: sent again once, after the grace period.
    // (The cron sees every repository's deliveries: only this one's are counted.)
    const late = Date.now() + 16 * 60_000;
    for (let i = 0; i < 5 && !t.sent.some((s) => s.delivery === id); i++)
      await reconcileWebhooks(t.deps(late));
    await reconcileWebhooks(t.deps(late));
    expect(t.sent.filter((s) => s.delivery === id)).toEqual([{ delivery: id }]);
    // The cron prunes in batches, other tests' deliveries too: until none of this one's is left.
    for (let i = 0; i < 20 && (await t.deliveries()).length > 0; i++)
      await reconcileWebhooks(t.deps(Date.now() + 31 * 24 * 60 * 60_000));
    expect(await t.deliveries()).toEqual([]);
  });

  it("turn a hook off only for a 410 their claim recorded, and the cron finishes a failed one", async () => {
    const hook = (await t.createHook()).body;
    await t.materialize((await t.outbox()).filter((e) => e.webhooks));
    const [ping] = await t.deliveries();
    const id = (ping as { delivery_id: string }).delivery_id;
    // A's request is held; its claim expires; B delivers; then A gets 410.
    let release = () => {};
    let entered = () => {};
    const inFetch = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      if (calls > 1) return new Response("ok", { status: 200 });
      await new Promise<void>((resolve) => {
        release = resolve;
        entered();
      });
      return new Response("gone", { status: 410 });
    });
    const now = Date.now();
    const first = attemptDelivery(t.deps(now), id);
    await inFetch;
    await attemptDelivery(t.deps(now + 2 * 60_000), id);
    release();
    await first;
    expect((await t.deliveries())[0]).toMatchObject({ state: "done", last_status: 200 });
    expect(
      (await json<HookOut>(api("GET", `${t.path}/hooks/${hook.id}`, t.owner.token))).body.active,
    ).toBe(true);

    // A 410 recorded while the repository object cannot be told: the cron turns the hook off.
    const second = (await t.createHook()).body;
    await t.materialize(
      (await t.outbox()).filter((e) => e.webhooks?.hooks.some((h) => h.id === second.id)),
    );
    const gone = (await t.deliveries()).find((d) => d.hook_id === second.id) as {
      delivery_id: string;
    };
    vi.stubGlobal("fetch", async () => new Response("gone", { status: 410 }));
    const unreachable = {
      ...t.deps(),
      env: {
        ...t.testEnv(),
        REPO: {
          getByName: (name: string) => {
            const real = env.REPO.getByName(name);
            return {
              hookForDelivery: (hookId: number) => real.hookForDelivery(hookId),
              disableHook: async () => {
                throw new Error("unavailable");
              },
            };
          },
        },
      } as unknown as Env,
    };
    await attemptDelivery(unreachable, gone.delivery_id);
    expect(
      (await json<HookOut>(api("GET", `${t.path}/hooks/${second.id}`, t.owner.token))).body.active,
    ).toBe(true);
    for (let i = 0; i < 20; i++) {
      await reconcileWebhooks(t.deps());
      if (
        !(await json<HookOut>(api("GET", `${t.path}/hooks/${second.id}`, t.owner.token))).body
          .active
      )
        break;
    }
    expect(
      (await json<HookOut>(api("GET", `${t.path}/hooks/${second.id}`, t.owner.token))).body,
    ).toMatchObject({
      active: false,
      disabled_reason: expect.stringContaining("410"),
    });
  });

  it("keep a last attempt claimed after the cron read them late, its answer recorded", async () => {
    await t.createHook();
    await t.materialize((await t.outbox()).filter((e) => e.webhooks));
    const [ping] = await t.deliveries();
    const id = (ping as { delivery_id: string }).delivery_id;
    // Late (first in the cron's order), with its last attempt to make.
    await env.ORG_READ.prepare(
      "UPDATE webhook_deliveries SET next_attempt_at = 0, attempts = ? WHERE delivery_id = ?",
    )
      .bind(ATTEMPT_POLICY.maxAttempts - 1, id)
      .run();
    let release = () => {};
    let entered = () => {};
    const inFetch = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.stubGlobal("fetch", async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
        entered();
      });
      return new Response("ok", { status: 200 });
    });
    const now = Date.now();
    // The cron's first read is its late deliveries: once it has them, a message claims the
    // last attempt (its request held) before the cron goes on.
    let consumer: Promise<void> | undefined;
    const afterRead = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, prop) {
          if (prop === "bind") return (...values: unknown[]) => afterRead(target.bind(...values));
          if (prop === "all")
            return async () => {
              const read = await target.all<{ delivery_id: string }>();
              if (!consumer) {
                expect(read.results.map((r) => r.delivery_id)).toContain(id);
                consumer = attemptDelivery(t.deps(now), id);
                await inFetch;
              }
              return read;
            };
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const paused: D1Database = new Proxy(env.ORG_READ, {
      get(target, prop) {
        if (prop === "prepare") return (sql: string) => afterRead(target.prepare(sql));
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await reconcileWebhooks({ ...t.deps(now), db: paused });
    release();
    await consumer;
    expect((await t.deliveries())[0]).toMatchObject({
      state: "done",
      reason: null,
      attempts: ATTEMPT_POLICY.maxAttempts,
      last_status: 200,
    });
  });

  it("let a hook that cannot be turned off yet wait behind others", async () => {
    const stuck = (await t.createHook()).body;
    const other = (await t.createHook()).body;
    await t.materialize((await t.outbox()).filter((e) => e.webhooks));
    vi.stubGlobal("fetch", async () => new Response("gone", { status: 410 }));
    // Both 410s recorded while the repository object cannot be told.
    const failingFor = (hookIds: number[]) =>
      ({
        ...t.testEnv(),
        REPO: {
          getByName: (name: string) => {
            const real = env.REPO.getByName(name);
            return {
              hookForDelivery: (hookId: number) => real.hookForDelivery(hookId),
              disableHook: async (hookId: number, version: number, reason: string) => {
                if (hookIds.includes(hookId)) throw new Error("unavailable");
                return real.disableHook(hookId, version, reason);
              },
            };
          },
        },
      }) as unknown as Env;
    const rows = await t.deliveries();
    const byHook = (id: number) =>
      (rows.find((d) => d.hook_id === id) as { delivery_id: string }).delivery_id;
    // Times a millisecond apart at least, so which waits longest is never a tie.
    const at = Date.now();
    await attemptDelivery(
      { ...t.deps(at), env: failingFor([stuck.id, other.id]) },
      byHook(stuck.id),
    );
    await attemptDelivery(
      { ...t.deps(at + 1), env: failingFor([stuck.id, other.id]) },
      byHook(other.id),
    );
    // One a run: the stuck one first, then (behind it now) the other.
    const oneARun = {
      ...t.deps(at + 10),
      env: failingFor([stuck.id]),
      policy: { ...ATTEMPT_POLICY, disableBatch: 1 },
    };
    for (let i = 0; i < 3; i++) await reconcileWebhooks(oneARun);
    const active = async (id: number) =>
      (await json<HookOut>(api("GET", `${t.path}/hooks/${id}`, t.owner.token))).body.active;
    expect(await active(other.id)).toBe(false);
    expect(await active(stuck.id)).toBe(true);
  });

  it("are reconciled past a failed resend, the failure reported once every step has run", async () => {
    const hook = async () => (await t.createHook()).body.id;
    const hooks = {
      late: await hook(),
      spent: await hook(),
      gone: await hook(),
      expired: await hook(),
    };
    // One ping a run: a run delivers only a few effects itself.
    for (const event of (await t.outbox()).filter((e) => e.webhooks)) await t.materialize([event]);
    const rows = await t.deliveries();
    const pingOf = (id: number) =>
      (rows.find((d) => d.hook_id === id) as { delivery_id: string }).delivery_id;
    const [late, spent, gone, expired] = [
      pingOf(hooks.late),
      pingOf(hooks.spent),
      pingOf(hooks.gone),
      pingOf(hooks.expired),
    ];
    const set = (id: string, assignments: string) =>
      env.ORG_READ.prepare(`UPDATE webhook_deliveries SET ${assignments} WHERE delivery_id = ?`)
        .bind(id)
        .run();
    // Each first in its step's order, whatever other tests left in this file's database.
    await set(late, "next_attempt_at = 0");
    await set(
      spent,
      `attempts = ${ATTEMPT_POLICY.maxAttempts}, lease_token = 'dead', lease_until = 1`,
    );
    await set(
      gone,
      "state = 'failed', reason = 'gone', last_status = 410, disable_hook_version = 1, disable_retry_at = 0",
    );
    await set(expired, "state = 'done', expires_at = 1");
    const body = await env.ORG_READ.prepare(
      "SELECT payload_key FROM webhook_deliveries WHERE delivery_id = ?",
    )
      .bind(expired)
      .first<{ payload_key: string }>();

    const now = Date.now();
    const queueDown = {
      ...t.deps(now),
      env: {
        ...t.testEnv(),
        WEBHOOKS: {
          send: async () => {
            throw new Error("queue unavailable");
          },
        },
      } as unknown as Env,
    };
    const failed = await reconcileWebhooks(queueDown).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(AggregateError);
    expect(failed).toMatchObject({
      errors: expect.arrayContaining([expect.objectContaining({ message: "queue unavailable" })]),
    });
    // The other steps ran all the same.
    const after = new Map((await t.deliveries()).map((d) => [d.delivery_id, d]));
    expect(after.get(spent)).toMatchObject({ state: "failed", reason: "attempts_spent" });
    expect(
      (await json<HookOut>(api("GET", `${t.path}/hooks/${hooks.gone}`, t.owner.token))).body,
    ).toMatchObject({ active: false, disabled_reason: expect.stringContaining("410") });
    expect(after.has(expired)).toBe(false);
    expect(await env.ASSETS.head(body?.payload_key as string)).toBeNull();
    // The delivery whose message was not sent stays due: sent once it is late again.
    const kept = await env.ORG_READ.prepare(
      "SELECT state, next_attempt_at, lease_token FROM webhook_deliveries WHERE delivery_id = ?",
    )
      .bind(late)
      .first();
    expect(kept).toEqual({ state: "pending", next_attempt_at: now, lease_token: null });
    // (Other tests' due deliveries come first: sent until this one is.)
    for (let i = 0; i < 20 && !t.sent.some((s) => s.delivery === late); i++)
      await reconcileWebhooks(t.deps(now + ATTEMPT_POLICY.lateMs));
    expect(t.sent.filter((s) => s.delivery === late)).toEqual([{ delivery: late }]);
  });

  it("record nothing over a cancellation, keep a bounded excerpt, and wait for a body", async () => {
    const hook = (await t.createHook()).body;
    await t.materialize((await t.outbox()).filter((e) => e.webhooks));
    const [ping] = await t.deliveries();
    const id = (ping as { delivery_id: string }).delivery_id;
    // The hook is deleted while its attempt is under way.
    let release = () => {};
    let entered = () => {};
    const inFetch = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.stubGlobal("fetch", async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
        entered();
      });
      return new Response("late", { status: 200 });
    });
    const running = attemptDelivery(t.deps(), id);
    await inFetch;
    await api("DELETE", `${t.path}/hooks/${hook.id}`, t.owner.token);
    const messages = t.sent.length;
    release();
    await running;
    expect((await t.deliveries())[0]).toMatchObject({ state: "cancelled", reason: "hook_deleted" });
    const attempts = await env.ORG_READ.prepare(
      "SELECT count(*) AS n FROM webhook_attempts WHERE delivery_id = ?",
    )
      .bind(id)
      .first<{ n: number }>();
    expect(attempts?.n).toBe(0);
    expect(t.sent.length).toBe(messages);

    // Malformed bytes read as U+FFFD: still 4 KiB of UTF-8 at most.
    const second = (await t.createHook()).body;
    vi.stubGlobal(
      "fetch",
      async () => new Response(new Uint8Array(4096).fill(0xff), { status: 500 }),
    );
    await t.materialize(
      (await t.outbox()).filter((e) => e.webhooks?.hooks.some((h) => h.id === second.id)),
    );
    const failing = (await t.deliveries()).find((d) => d.hook_id === second.id) as {
      delivery_id: string;
    };
    await attemptDelivery(t.deps(), failing.delivery_id);
    const excerpt = await env.ORG_READ.prepare(
      "SELECT response_excerpt FROM webhook_attempts WHERE delivery_id = ?",
    )
      .bind(failing.delivery_id)
      .first<{ response_excerpt: string }>();
    expect(new TextEncoder().encode(excerpt?.response_excerpt ?? "").length).toBeLessThanOrEqual(
      4096,
    );

    // Its body not stored (yet): no attempt spent, until an hour has passed.
    const third = (await t.createHook()).body;
    await t.materialize(
      (await t.outbox()).filter((e) => e.webhooks?.hooks.some((h) => h.id === third.id)),
    );
    const waiting = (await t.deliveries()).find((d) => d.hook_id === third.id) as {
      delivery_id: string;
    };
    const key = await env.ORG_READ.prepare(
      "SELECT payload_key FROM webhook_deliveries WHERE delivery_id = ?",
    )
      .bind(waiting.delivery_id)
      .first<{ payload_key: string }>();
    await env.ASSETS.delete(key?.payload_key as string);
    await attemptDelivery(t.deps(), waiting.delivery_id);
    expect((await t.deliveries()).find((d) => d.hook_id === third.id)).toMatchObject({
      state: "pending",
      attempts: 0,
    });
    await attemptDelivery(t.deps(Date.now() + 61 * 60_000), waiting.delivery_id);
    expect((await t.deliveries()).find((d) => d.hook_id === third.id)).toMatchObject({
      state: "failed",
      reason: "payload_missing",
    });
  });

  it("are deleted with their repository, an attempt still queued sends nothing, and leave nothing to turn off", async () => {
    const hook = (await t.createHook()).body;
    await t.materialize((await t.outbox()).filter((e) => e.webhooks));
    const [ping] = await t.deliveries();
    const id = (ping as { delivery_id: string }).delivery_id;
    await api("DELETE", `/repos/${t.owner.handle}/${t.repo.name}`, t.owner.token);
    // The deletion waits while the invocation that made the deliveries could still be running.
    expect(await advanceDeletion(env, t.repo.id)).toBe("deleting");
    expect(await t.deliveries()).toHaveLength(1);
    await env.ORG_READ.prepare(
      "UPDATE effects SET done_at = done_at - ?2 WHERE effect_id >= ?1 || ':' AND effect_id < ?1 || ';'",
    )
      .bind(t.repo.id, CLEANUP_POLICY.settleMs)
      .run();
    expect(await advanceDeletion(env, t.repo.id)).toBe("deleted");
    expect(await t.stub().eraseForDeletion()).toBe("erased");
    await attemptDelivery(t.deps(), id);
    expect(t.received).toHaveLength(0);
    expect(await t.deliveries()).toEqual([]);
    expect(await t.stub().disableHook(hook.id, 1, "gone")).toBe(false);
  });

  it("make their first attempts themselves, two an event, and queue the others'", async () => {
    for (let i = 0; i < 3; i++) await t.createHook({ events: ["push"] });
    await api("POST", `${t.path}/file-commits`, t.owner.token, {
      message: "first",
      changes: [{ path: "a.txt", content: "a\n" }],
    });
    const push = (await t.outbox()).filter((e) => e.type === "refs.updated" && e.webhooks);
    expect(push).toHaveLength(1);
    expect(FIRST_ATTEMPTS).toBe(2);
    // The first receiver is busy: its retry is a message for later.
    let answers = 0;
    t.answer = () => (++answers === 1 ? new Response("busy", { status: 503 }) : new Response("ok"));
    await t.materialize(push, FIRST_ATTEMPTS);
    const rows = await t.deliveries();
    expect(rows.map((r) => r.state).sort()).toEqual(["done", "pending", "pending"]);
    expect(t.received).toHaveLength(2);
    // The third's first attempt is queued (at once), the busy one's retry delayed.
    const unattempted = rows.find((r) => r.state === "pending" && r.attempts === 0);
    const retried = rows.find((r) => r.state === "pending" && r.attempts === 1);
    expect(t.sent).toEqual([
      { delivery: unattempted?.delivery_id },
      { delivery: retried?.delivery_id, delaySeconds: expect.any(Number) },
    ]);
    // The effect delivered again (its mark lost): no attempt and no message more.
    const sink = createWebhookSink({ resolver: () => async () => ["93.184.216.34"] });
    const effect = effectOf(sink, push[0] as DomainEvent);
    await sink.deliver(effect, t.testEnv(), env.ORG_READ);
    expect(t.received).toHaveLength(2);
    expect(t.sent).toHaveLength(2);
  });

  it("count each first attempt they queue as a message sent", async () => {
    for (let i = 0; i < 5; i++) await t.createHook({ events: ["push"] });
    await api("POST", `${t.path}/file-commits`, t.owner.token, {
      message: "first",
      changes: [{ path: "a.txt", content: "a\n" }],
    });
    const [push] = (await t.outbox()).filter((e) => e.type === "refs.updated" && e.webhooks);
    let sent = 0;
    const metrics = {
      count(name: string, dimensions: Record<string, string>, value = 1) {
        if (name === "queue.send" && dimensions.queue === "webhooks") sent += value;
      },
    } as unknown as Metrics;
    const sink = createWebhookSink({ resolver: () => async () => ["93.184.216.34"] });
    await sink.deliver(effectOf(sink, push as DomainEvent), t.testEnv(), env.ORG_READ, metrics);
    // Two made at once, three queued in one call.
    expect(t.received).toHaveLength(FIRST_ATTEMPTS);
    expect(t.sent).toHaveLength(5 - FIRST_ATTEMPTS);
    expect(sent).toBe(5 - FIRST_ATTEMPTS);
  });

  it("keep making an event's deliveries within the calls the sink counts for it", async () => {
    for (let i = 0; i < 3; i++) await t.createHook({ events: ["push"] });
    await api("POST", `${t.path}/file-commits`, t.owner.token, {
      message: "first",
      changes: [{ path: "a.txt", content: "a\n" }],
    });
    const [push] = (await t.outbox()).filter((e) => e.type === "refs.updated" && e.webhooks);
    // The costliest answer: gone, so each attempt also turns its hook off.
    t.answer = () => new Response("gone", { status: 410 });
    const sink = createWebhookSink({ resolver: () => async () => ["93.184.216.34"] });
    const effect = effectOf(sink, push as DomainEvent);
    const calls = { n: 0 };
    const counted = <T extends object>(target: T, methods: readonly string[]): T =>
      new Proxy(target, {
        get(object, prop) {
          const value = Reflect.get(object, prop);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (methods.includes(String(prop))) calls.n++;
            const result = value.apply(object, args);
            // A prepared statement counts when it runs (bound or not).
            if (prop === "prepare" || prop === "bind")
              return counted(result, ["run", "first", "all", "raw"]);
            return result;
          };
        },
      });
    const base = t.testEnv();
    const measured = {
      ...base,
      ORG_READ: counted(env.ORG_READ, ["batch"]),
      ASSETS: counted(base.ASSETS, ["put", "get", "delete", "head"]),
      WEBHOOKS: counted(base.WEBHOOKS, ["send", "sendBatch"]),
      // A repository object's stub only by the calls an attempt makes.
      REPO: {
        getByName: (name: string) => {
          const stub = base.REPO.getByName(name);
          return {
            hooksForDelivery: (...args: Parameters<typeof stub.hooksForDelivery>) => {
              calls.n++;
              return stub.hooksForDelivery(...args);
            },
            disableHook: (...args: Parameters<typeof stub.disableHook>) => {
              calls.n++;
              return stub.disableHook(...args);
            },
          };
        },
      },
    } as unknown as Env;
    await sink.deliver(effect, measured, measured.ORG_READ);
    expect(t.received).toHaveLength(2);
    // The event's first two hooks attempted (in its order), the third queued.
    const byHook = (await t.deliveries()).sort((a, b) => a.hook_id - b.hook_id);
    expect(byHook.map((d) => d.reason)).toEqual(["gone", "gone", null]);
    // Measured: 14 (two attempts turning their hooks off, and the third queued).
    expect(calls.n).toBe(14);
    expect(calls.n).toBeLessThanOrEqual(
      effectCalls(sink, { target: effect.target, payload: effect.payload }),
    );
  });

  it("queue a first attempt that could not be made, for when its delivery can be claimed", async () => {
    await t.createHook({ events: ["push"] });
    await api("POST", `${t.path}/file-commits`, t.owner.token, {
      message: "first",
      changes: [{ path: "a.txt", content: "a\n" }],
    });
    const [event] = (await t.outbox()).filter((e) => e.type === "refs.updated" && e.webhooks);
    const sink = createWebhookSink({ resolver: () => async () => ["93.184.216.34"] });
    const effect = effectOf(sink, event as DomainEvent);
    // The attempt is made, 2 s after its claim, but its outcome cannot be
    // recorded: its claim holds the delivery.
    const claimedAt = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(claimedAt);
    // Its deliveries made and its first attempt claimed (two batches), the record is lost.
    let batches = 0;
    const lostRecord = new Proxy(env.ORG_READ, {
      get(target, prop) {
        if (prop === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (++batches <= 2) return target.batch(statements);
            vi.setSystemTime(claimedAt + 2_000);
            throw new Error("D1 overloaded");
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      await sink.deliver(effect, t.testEnv(), lostRecord);
    } finally {
      vi.useRealTimers();
    }
    const [row] = await t.deliveries();
    expect(row).toMatchObject({ state: "pending", attempts: 1 });
    expect(t.received).toHaveLength(1);
    // Queued for when the claim ends, not at once (an attempt then would find it claimed).
    expect(t.sent).toEqual([
      { delivery: row?.delivery_id, delaySeconds: ATTEMPT_POLICY.leaseMs / 1000 - 2 },
    ]);
    await attemptDelivery(t.deps(claimedAt + ATTEMPT_POLICY.leaseMs), row?.delivery_id ?? "");
    expect(await t.deliveries()).toMatchObject([{ state: "done", attempts: 2 }]);
  });
  it("make their first attempts from the body and hooks they hold, one lookup an event", async () => {
    for (let i = 0; i < 2; i++) await t.createHook({ events: ["push"] });
    await api("POST", `${t.path}/file-commits`, t.owner.token, {
      message: "first",
      changes: [{ path: "a.txt", content: "a\n" }],
    });
    const [push] = (await t.outbox()).filter((e) => e.type === "refs.updated" && e.webhooks);
    const sink = createWebhookSink({ resolver: () => async () => ["93.184.216.34"] });
    const effect = effectOf(sink, push as DomainEvent);
    const reads: string[] = [];
    const base = t.testEnv();
    const lookups: number[][] = [];
    const watched = {
      ...base,
      ASSETS: new Proxy(base.ASSETS, {
        get(target, prop) {
          const value = Reflect.get(target, prop);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (prop === "get" || prop === "head") reads.push(String(prop));
            return value.apply(target, args);
          };
        },
      }),
      REPO: {
        getByName: (name: string) => {
          const stub = base.REPO.getByName(name);
          return {
            hooksForDelivery: (ids: number[]) => {
              lookups.push(ids);
              return stub.hooksForDelivery(ids);
            },
            hookForDelivery: () => {
              throw new Error("a first attempt looks its hook up with the others");
            },
            disableHook: (...args: Parameters<typeof stub.disableHook>) =>
              stub.disableHook(...args),
          };
        },
      },
    } as unknown as Env;
    const points: { name: string; dimensions: Record<string, string>; value: number }[] = [];
    const metrics = {
      count: (name: string, dimensions: Record<string, string>, value = 1) =>
        points.push({ name, dimensions, value }),
    } as unknown as Metrics;
    await sink.deliver(effect, watched, env.ORG_READ, metrics);
    expect(t.received).toHaveLength(2);
    expect((await t.deliveries()).map((d) => d.state)).toEqual(["done", "done"]);
    // The body it stored is the body it sent, not read back; both hooks in one lookup.
    expect(reads).toEqual([]);
    expect(lookups).toHaveLength(1);
    expect(lookups[0]?.length).toBe(2);
    // Each stage timed: the event's once, each attempt's once per attempt.
    const stages = points
      .filter((p) => p.name === "webhooks.stage_ms")
      .map((p) => p.dimensions.stage)
      .sort();
    expect(stages).toEqual(["body", "claim", "hooks", "post", "post", "record", "record", "rows"]);
    expect(METRIC_AGGREGATION["webhooks.stage_ms"]).toBe("each");
  });

  it("send nothing to a hook deleted before its delivery is claimed", async () => {
    const hook = (await t.createHook({ events: ["push"] })).body;
    await api("POST", `${t.path}/file-commits`, t.owner.token, {
      message: "first",
      changes: [{ path: "a.txt", content: "a\n" }],
    });
    const [push] = (await t.outbox()).filter((e) => e.type === "refs.updated" && e.webhooks);
    const sink = createWebhookSink({ resolver: () => async () => ["93.184.216.34"] });
    const base = t.testEnv();
    // The hook goes while the body is stored: after its delivery's row, before its claim.
    const racing = {
      ...base,
      ASSETS: new Proxy(base.ASSETS, {
        get(target, prop) {
          const value = Reflect.get(target, prop);
          if (prop !== "put") return typeof value === "function" ? value.bind(target) : value;
          return async (...args: unknown[]) => {
            expect((await api("DELETE", `${t.path}/hooks/${hook.id}`, t.owner.token)).status).toBe(
              200,
            );
            return value.apply(target, args);
          };
        },
      }),
    } as unknown as Env;
    await sink.deliver(effectOf(sink, push as DomainEvent), racing, env.ORG_READ);
    expect(t.received).toHaveLength(0);
    expect(await t.deliveries()).toMatchObject([
      { state: "cancelled", reason: "hook_deleted", attempts: 0 },
    ]);
    expect(t.sent).toEqual([]);
  });

  it("claim no first attempt once the repository's tombstone is in, and take the body back", async () => {
    await t.createHook({ events: ["push"] });
    await api("POST", `${t.path}/file-commits`, t.owner.token, {
      message: "first",
      changes: [{ path: "a.txt", content: "a\n" }],
    });
    const [push] = (await t.outbox()).filter((e) => e.type === "refs.updated" && e.webhooks);
    const sink = createWebhookSink({ resolver: () => async () => ["93.184.216.34"] });
    const base = t.testEnv();
    const deleted: unknown[] = [];
    // The tombstone comes in while the body is stored.
    const racing = {
      ...base,
      ASSETS: new Proxy(base.ASSETS, {
        get(target, prop) {
          const value = Reflect.get(target, prop);
          if (typeof value !== "function") return value;
          return async (...args: unknown[]) => {
            const result = await value.apply(target, args);
            if (prop === "put")
              await env.ORG_READ.prepare(
                `INSERT INTO repos (repo_id, deleted, epoch_gen, version, owner_gen, updated_seq,
                   updated_at) VALUES (?1, 1, 0, 0, 0, 0, 0)
                 ON CONFLICT (repo_id) DO UPDATE SET deleted = 1`,
              )
                .bind(t.repo.id)
                .run();
            if (prop === "delete") deleted.push(args[0]);
            return result;
          };
        },
      }),
    } as unknown as Env;
    await sink.deliver(effectOf(sink, push as DomainEvent), racing, env.ORG_READ);
    expect(t.received).toHaveLength(0);
    expect(deleted).toHaveLength(1);
    expect(await t.deliveries()).toMatchObject([{ state: "pending", attempts: 0 }]);
    expect(t.sent).toEqual([]);
  });

  it("see every first attempt of an event through, one failing not stopping the other", async () => {
    for (let i = 0; i < 2; i++) await t.createHook({ events: ["push"] });
    await api("POST", `${t.path}/file-commits`, t.owner.token, {
      message: "first",
      changes: [{ path: "a.txt", content: "a\n" }],
    });
    const [push] = (await t.outbox()).filter((e) => e.type === "refs.updated" && e.webhooks);
    const sink = createWebhookSink({ resolver: () => async () => ["93.184.216.34"] });
    // The first record written fails, and so does queuing that attempt instead; the other
    // record is held until that has happened.
    let batches = 0;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fallbackFailed: () => void = () => {};
    const fellBack = new Promise<void>((resolve) => {
      fallbackFailed = resolve;
    });
    const db = new Proxy(env.ORG_READ, {
      get(target, prop) {
        if (prop === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const n = ++batches;
            if (n === 3) throw new Error("D1 overloaded");
            if (n === 4) await held;
            return target.batch(statements);
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const base = t.testEnv();
    const failingQueue = {
      ...base,
      WEBHOOKS: {
        send: async () => {
          throw new Error("queue unavailable");
        },
        sendBatch: async () => {
          fallbackFailed();
          throw new Error("queue unavailable");
        },
      },
    } as unknown as Env;
    let settled = false;
    const delivering = sink.deliver(effectOf(sink, push as DomainEvent), failingQueue, db);
    delivering.then(
      () => (settled = true),
      () => (settled = true),
    );
    await fellBack;
    for (let i = 0; i < 20; i++) await Promise.resolve();
    // One attempt's failure told only once the other's record is through.
    expect(settled).toBe(false);
    release();
    await expect(delivering).rejects.toThrow("queue unavailable");
    expect(t.received).toHaveLength(2);
    // The other attempt was recorded; the failed one keeps its claim until its lease ends.
    expect((await t.deliveries()).map((d) => [d.state, d.attempts]).sort()).toEqual([
      ["done", 1],
      ["pending", 1],
    ]);
  });

  it("retry later the first attempts whose hooks could not be looked up", async () => {
    for (let i = 0; i < 2; i++) await t.createHook({ events: ["push"] });
    await api("POST", `${t.path}/file-commits`, t.owner.token, {
      message: "first",
      changes: [{ path: "a.txt", content: "a\n" }],
    });
    const [push] = (await t.outbox()).filter((e) => e.type === "refs.updated" && e.webhooks);
    const sink = createWebhookSink({ resolver: () => async () => ["93.184.216.34"] });
    const base = t.testEnv();
    const unavailable = {
      ...base,
      REPO: {
        getByName: () => ({
          hooksForDelivery: async () => {
            throw new Error("repository object overloaded");
          },
        }),
      },
    } as unknown as Env;
    await sink.deliver(effectOf(sink, push as DomainEvent), unavailable, env.ORG_READ);
    expect(t.received).toHaveLength(0);
    expect((await t.deliveries()).map((d) => [d.state, d.attempts])).toEqual([
      ["pending", 1],
      ["pending", 1],
    ]);
    expect(t.sent).toEqual([
      { delivery: expect.any(String), delaySeconds: ATTEMPT_POLICY.backoffMs / 1000 },
      { delivery: expect.any(String), delaySeconds: ATTEMPT_POLICY.backoffMs / 1000 },
    ]);
  });
  it("keep within the calls the sink counts when every record fails and is queued instead", async () => {
    for (let i = 0; i < 3; i++) await t.createHook({ events: ["push"] });
    await api("POST", `${t.path}/file-commits`, t.owner.token, {
      message: "first",
      changes: [{ path: "a.txt", content: "a\n" }],
    });
    const [push] = (await t.outbox()).filter((e) => e.type === "refs.updated" && e.webhooks);
    t.answer = () => new Response("busy", { status: 503 });
    const sink = createWebhookSink({ resolver: () => async () => ["93.184.216.34"] });
    const effect = effectOf(sink, push as DomainEvent);
    const calls = { n: 0 };
    let batches = 0;
    const counted = <T extends object>(target: T, methods: readonly string[]): T =>
      new Proxy(target, {
        get(object, prop) {
          const value = Reflect.get(object, prop);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (methods.includes(String(prop))) calls.n++;
            // Past the rows and the claims, every record is lost.
            if (prop === "batch" && ++batches > 2) throw new Error("D1 overloaded");
            const result = value.apply(object, args);
            if (prop === "prepare" || prop === "bind")
              return counted(result, ["run", "first", "all", "raw"]);
            return result;
          };
        },
      });
    const base = t.testEnv();
    const measured = {
      ...base,
      WEBHOOKS: counted(base.WEBHOOKS, ["send", "sendBatch"]),
      ASSETS: counted(base.ASSETS, ["put", "get", "delete", "head"]),
      REPO: {
        getByName: (name: string) => {
          const stub = base.REPO.getByName(name);
          return {
            hooksForDelivery: (ids: number[]) => {
              calls.n++;
              return stub.hooksForDelivery(ids);
            },
          };
        },
      },
    } as unknown as Env;
    await sink.deliver(effect, measured, counted(env.ORG_READ, ["batch"]));
    expect(t.received).toHaveLength(2);
    // Both attempts queued for when their claims end, the third's at once.
    expect(t.sent).toHaveLength(3);
    expect(calls.n).toBeLessThanOrEqual(
      effectCalls(sink, { target: effect.target, payload: effect.payload }),
    );
  });
  it("make an event's first attempts side by side, and those it claimed even when queuing the others fails", async () => {
    for (let i = 0; i < 3; i++) await t.createHook({ events: ["push"] });
    await api("POST", `${t.path}/file-commits`, t.owner.token, {
      message: "first",
      changes: [{ path: "a.txt", content: "a\n" }],
    });
    const [push] = (await t.outbox()).filter((e) => e.type === "refs.updated" && e.webhooks);
    const sink = createWebhookSink({ resolver: () => async () => ["93.184.216.34"] });
    // The first request is answered only once the second has come: made one after the
    // other, they never would be.
    let entered = 0;
    let bothIn: () => void = () => {};
    const together = new Promise<void>((resolve) => {
      bothIn = resolve;
    });
    t.answer = (async () => {
      if (++entered === 2) bothIn();
      await together;
      return new Response("ok");
    }) as unknown as () => Response;
    const base = t.testEnv();
    const failingQueue = {
      ...base,
      WEBHOOKS: {
        ...base.WEBHOOKS,
        sendBatch: async () => {
          throw new Error("queue unavailable");
        },
      },
    } as unknown as Env;
    await expect(
      sink.deliver(effectOf(sink, push as DomainEvent), failingQueue, env.ORG_READ),
    ).rejects.toThrow("queue unavailable");
    // The two claimed were made and recorded; the third, never queued, waits for the cron.
    expect(t.received).toHaveLength(2);
    expect((await t.deliveries()).map((d) => [d.state, d.attempts]).sort()).toEqual([
      ["done", 1],
      ["done", 1],
      ["pending", 0],
    ]);
  });
});
