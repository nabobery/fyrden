// Redelivery: a finished delivery sent once more by an administrator (one
// attempt, its original body and id), refused when it cannot be. The API
// sends to the real webhooks queue; every test here replaces that send
// with a spy (below), so the queue's consumer never makes an attempt behind
// a test's back, in this test or a later one.
import { env } from "cloudflare:workers";
import { D1TokenStore } from "@fyrden/adapters-cloudflare/auth";
import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { createIdFactory, secureRandomBytes } from "@fyrden/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpContext } from "../src/ops/execute.js";
import { redeliverHookDeliveryOperation } from "../src/repos/hooks.js";
import { ATTEMPT_POLICY, attemptDelivery, reconcileWebhooks } from "../src/webhooks/deliver.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { admitted } from "./helpers/read-model.js";
import { webhookTest } from "./helpers/webhooks.js";

const t = webhookTest();

describe("redelivery", () => {
  // What the API queues for an attempt is kept here, not sent: the real queue's consumer would
  // make the attempt whenever it ran (in this test or a later one), and each test makes its own.
  let queued: string[];
  beforeEach(() => {
    queued = [];
    vi.spyOn(env.WEBHOOKS, "send").mockImplementation(async (body: unknown) => {
      queued.push((body as { delivery: string }).delivery);
      return {} as QueueSendResponse;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const redeliver = (hook: number, id: string, who: Who = t.owner) =>
    json<{ id: string; state: string; code?: string }>(
      api("POST", `${t.path}/hooks/${hook}/deliveries/${id}/attempts`, who.token),
    );
  /** A hook, its ping delivered once (answered `status`). */
  const delivered = async (status = 200) => {
    const hook = (await t.createHook()).body;
    await t.materialize((await t.outbox()).filter((e) => e.webhooks));
    const id = ((await t.deliveries())[0] as { delivery_id: string }).delivery_id;
    t.answer = () => new Response("no", { status });
    await attemptDelivery(t.deps(), id);
    return { hook: hook.id, id };
  };

  it("sends a finished delivery once more: the same id and body, signed now", async () => {
    const { hook, id } = await delivered(400);
    expect((await t.deliveries())[0]).toMatchObject({ state: "failed", attempts: 1 });
    const again = await redeliver(hook, id);
    // Queued for its attempt.
    expect(queued).toEqual([id]);
    expect(again.status).toBe(202);
    expect(again.body).toMatchObject({ id, state: "pending" });
    t.answer = () => new Response("ok", { status: 200 });
    await attemptDelivery(t.deps(Date.now() + 1_000), id);
    expect(t.received).toHaveLength(2);
    expect(t.received[1]?.headers.get("webhook-id")).toBe(id);
    expect(t.received[1]?.body).toBe(t.received[0]?.body);
    expect((await t.deliveries())[0]).toMatchObject({ state: "done", attempts: 2 });
    const one = await json<{ attempts_made: { n: number; status_code: number }[] }>(
      api("GET", `${t.path}/hooks/${hook}/deliveries/${id}`, t.owner.token),
    );
    // Newest first.
    expect(one.body.attempts_made.map((a) => [a.n, a.status_code])).toEqual([
      [2, 200],
      [1, 400],
    ]);
  });

  it("counts the message it sends, and none it could not send", async () => {
    const { hook, id } = await delivered(400);
    const checked = await new D1TokenStore(env.DIRECTORY, {
      clock: () => Date.now(),
      newId: createIdFactory(() => Date.now(), secureRandomBytes),
      randomBytes: secureRandomBytes,
    }).verify(t.owner.token, "write");
    if (!checked.ok) throw new Error(`the token is refused: ${checked.reason}`);
    let sent = 0;
    const metrics = {
      count(name: string, dimensions: Record<string, string>, value = 1) {
        if (name === "queue.send" && dimensions.queue === "webhooks") sent += value;
      },
    } as unknown as Metrics;
    const ctx = {
      env,
      auth: checked.record,
      requestId: "req_test",
      metrics,
    } as unknown as OpContext;
    const input = { owner: t.owner.handle, repo: t.repo.name, hook_id: hook, delivery_id: id };
    vi.spyOn(env.WEBHOOKS, "send").mockRejectedValueOnce(new Error("queue down"));
    await expect(redeliverHookDeliveryOperation(ctx, input)).rejects.toThrow(/queue down/);
    expect(sent).toBe(0);
    // Another hook's, sent: counted once.
    const other = (await t.createHook()).body.id;
    await t.materialize((await t.outbox()).filter((e) => e.webhooks));
    const next = (await t.deliveries())
      .map((d) => (d as { delivery_id: string }).delivery_id)
      .find((d) => d !== id);
    if (!next) throw new Error("no second delivery");
    t.answer = () => new Response("no", { status: 400 });
    await attemptDelivery(t.deps(), next);
    await redeliverHookDeliveryOperation(ctx, { ...input, hook_id: other, delivery_id: next });
    expect(queued).toEqual([next]);
    expect(sent).toBe(1);
  });

  it("makes one attempt only, not the automatic retries", async () => {
    const { hook, id } = await delivered(400);
    expect((await redeliver(hook, id)).status).toBe(202);
    t.answer = () => new Response("busy", { status: 503 });
    await attemptDelivery(t.deps(Date.now() + 1_000), id);
    expect((await t.deliveries())[0]).toMatchObject({
      state: "failed",
      reason: "attempts_spent",
      attempts: 2,
    });
    // Nothing more is claimed.
    await attemptDelivery(t.deps(Date.now() + 10 * 60 * 60_000), id);
    expect(t.received).toHaveLength(2);
  });

  it("refuses a pending delivery, a gone body, other hooks and non-administrators", async () => {
    const hook = (await t.createHook()).body;
    await t.materialize((await t.outbox()).filter((e) => e.webhooks));
    const id = ((await t.deliveries())[0] as { delivery_id: string }).delivery_id;
    expect((await redeliver(hook.id, id)).body.code).toBe("delivery_pending");
    await attemptDelivery(t.deps(), id);
    const other = (await t.createHook()).body;
    expect((await redeliver(other.id, id)).body.code).toBe("delivery_not_found");
    const stranger = await user();
    expect((await redeliver(hook.id, id, stranger)).status).toBe(404);
    const key = (
      await admitted()
        .prepare("SELECT payload_key FROM webhook_deliveries WHERE delivery_id = ?")
        .bind(id)
        .first<{ payload_key: string }>()
    )?.payload_key as string;
    await env.ASSETS.delete(key);
    expect((await redeliver(hook.id, id)).body.code).toBe("payload_gone");
  });

  it("waits for a hook a 410 is turning off, and refuses an expired delivery", async () => {
    const { hook, id } = await delivered(400);
    const set = (column: string, value: number) =>
      admitted()
        .prepare(`UPDATE webhook_deliveries SET ${column} = ? WHERE delivery_id = ?`)
        .bind(value, id)
        .run();
    await set("disable_hook_version", 1);
    expect((await redeliver(hook, id)).body.code).toBe("hook_being_disabled");
    await admitted()
      .prepare("UPDATE webhook_deliveries SET disable_hook_version = NULL WHERE delivery_id = ?")
      .bind(id)
      .run();
    await set("expires_at", Date.now() - 1);
    expect((await redeliver(hook, id)).body.code).toBe("payload_gone");
  });

  it("leaves nothing for a claim of an earlier attempt to record", async () => {
    const { hook, id } = await delivered(400);
    // A claim of the first round, still running (its lease long gone) when the delivery is sent again.
    await admitted()
      .prepare("UPDATE webhook_deliveries SET lease_token = 'stale' WHERE delivery_id = ?")
      .bind(id)
      .run();
    expect((await redeliver(hook, id)).status).toBe(202);
    const row = await admitted()
      .prepare(
        "SELECT lease_token, attempt_limit, attempts FROM webhook_deliveries WHERE delivery_id = ?",
      )
      .bind(id)
      .first<{ lease_token: string | null; attempt_limit: number; attempts: number }>();
    expect(row).toEqual({ lease_token: null, attempt_limit: 2, attempts: 1 });
  });

  it("stops once a delivery has made as many attempts as one keeps", async () => {
    const { hook, id } = await delivered(400);
    const attempted = (n: number) =>
      admitted()
        .prepare("UPDATE webhook_deliveries SET attempts = ? WHERE delivery_id = ?")
        .bind(n, id)
        .run();
    // One short of the most: the last one allowed.
    await attempted(ATTEMPT_POLICY.maxTotalAttempts - 1);
    expect((await redeliver(hook, id)).status).toBe(202);
    const limit = await admitted()
      .prepare("SELECT attempt_limit FROM webhook_deliveries WHERE delivery_id = ?")
      .bind(id)
      .first<{ attempt_limit: number }>();
    expect(limit?.attempt_limit).toBe(ATTEMPT_POLICY.maxTotalAttempts);
    // Its last attempt made: no more, by hand either.
    await admitted()
      .prepare(
        "UPDATE webhook_deliveries SET state = 'failed', attempts = attempt_limit WHERE delivery_id = ?",
      )
      .bind(id)
      .run();
    const refused = await redeliver(hook, id);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("too_many_attempts");
    expect(queued).toEqual([id]);
  });

  it("holds the most attempts a delivery makes in the consumer and the cron too", async () => {
    const { id } = await delivered(400);
    const cap = ATTEMPT_POLICY.maxTotalAttempts;
    const row = () =>
      admitted()
        .prepare("SELECT state, reason, attempts FROM webhook_deliveries WHERE delivery_id = ?")
        .bind(id)
        .first();
    // Pending past the most, whatever its own limit says (not by this API): never claimed.
    await admitted()
      .prepare(
        `UPDATE webhook_deliveries SET state = 'pending', reason = NULL, attempts = ?,
         attempt_limit = ?, next_attempt_at = 0 WHERE delivery_id = ?`,
      )
      .bind(cap, cap + 5, id)
      .run();
    await attemptDelivery(t.deps(), id);
    expect(t.received).toHaveLength(1);
    expect(await row()).toEqual({ state: "pending", reason: null, attempts: cap });
    // The cron finishes it instead of sending its message again (it is the first one due).
    t.sent.length = 0;
    await reconcileWebhooks(t.deps());
    expect(t.sent.map((s) => s.delivery)).not.toContain(id);
    expect(await row()).toEqual({ state: "failed", reason: "attempts_spent", attempts: cap });

    // One short of the most: its last attempt, failed, is not retried.
    await admitted()
      .prepare(
        `UPDATE webhook_deliveries SET state = 'pending', reason = NULL, attempts = ?,
         next_attempt_at = 0 WHERE delivery_id = ?`,
      )
      .bind(cap - 1, id)
      .run();
    t.answer = () => new Response("busy", { status: 503 });
    await attemptDelivery(t.deps(), id);
    expect(t.received).toHaveLength(2);
    expect(await row()).toEqual({ state: "failed", reason: "attempts_spent", attempts: cap });
  });
});
