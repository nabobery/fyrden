// Webhook deliveries: made from events (row, body, message) within the
// journal's and the consumer's budgets, each attempt signed, posted through
// the SSRF guard and recorded, retried, failed or cancelled as its answer
// says; and the cron's share (late messages sent again, hooks a 410 turns
// off, retention). The cron sees every delivery in this file's database,
// other tests' too: a test that runs it either orders its own rows first
// or runs it until its own are handled.
import { env } from "cloudflare:workers";
import { type DomainEvent, eventKey } from "@fyrden/domain";
import { describe, expect, it, vi } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { effectStatements } from "../src/effects/journal.js";
import { applyEnvelope } from "../src/queues/events-consumer.js";
import { ATTEMPT_POLICY, attemptDelivery, reconcileWebhooks } from "../src/webhooks/deliver.js";
import { signature } from "../src/webhooks/secrets.js";
import { bodyOf, deliveryIdOf, webhookSink } from "../src/webhooks/sink.js";
import { api, json } from "./helpers/api.js";
import { inRepo } from "./helpers/repo-git.js";
import { type HookOut, RECEIVER, webhookTest } from "./helpers/webhooks.js";

const t = webhookTest();

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

  it("leave a message to a later invocation once its D1 queries are spent, never the first", async () => {
    await t.createHook();
    const events = (await t.outbox()).filter((e) => e.webhooks);
    const envelope = { sourceId: t.repo.id, events };
    const spent = { left: 1, applied: true };
    expect(
      await applyEnvelope(t.testEnv(), envelope, { sinks: [webhookSink], queries: spent }),
    ).toBe("deferred");
    const fresh = { left: 1, applied: false };
    expect(
      await applyEnvelope(t.testEnv(), envelope, { sinks: [webhookSink], queries: fresh }),
    ).toBe("applied");
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
    await attemptDelivery({ ...t.deps(), env: failingFor([stuck.id, other.id]) }, byHook(stuck.id));
    await attemptDelivery({ ...t.deps(), env: failingFor([stuck.id, other.id]) }, byHook(other.id));
    // One a run: the stuck one first, then (behind it now) the other.
    const oneARun = {
      ...t.deps(),
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

  it("are cancelled, and leave nothing to turn off, once their repository is erased", async () => {
    const hook = (await t.createHook()).body;
    await t.materialize((await t.outbox()).filter((e) => e.webhooks));
    const [ping] = await t.deliveries();
    const id = (ping as { delivery_id: string }).delivery_id;
    await api("DELETE", `/repos/${t.owner.handle}/${t.repo.name}`, t.owner.token);
    expect(await t.stub().eraseForDeletion()).toBe("erased");
    await attemptDelivery(t.deps(), id);
    expect(t.received).toHaveLength(0);
    expect((await t.deliveries())[0]).toMatchObject({ state: "cancelled", reason: "hook_deleted" });
    expect(await t.stub().disableHook(hook.id, 1, "gone")).toBe(false);
  });
});
