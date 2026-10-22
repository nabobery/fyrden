// Webhook bodies made from an event's capture: made once, before any
// delivery, from the capture's tree, its long text read back from the
// repository object while the event is still the repository's, and its
// users' logins; a payload row owns the stored body from before it is
// stored, and from then on the stored body is the body. Past the event's
// deadline none is made; a body found gone is gone; the cron and a
// repository's deletion remove bodies and their rows.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type DomainEvent, eventKey } from "@fyrden/domain";
import { describe, expect, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import type { Effect, EffectSink, PlannedEffect } from "../src/effects/journal.js";
import { type CaptureValue, captureTree } from "../src/webhooks/capture.js";
import { attemptDelivery, reconcileWebhooks } from "../src/webhooks/deliver.js";
import { bodyKeyOf, createWebhookSink, DELIVERY_POLICY } from "../src/webhooks/sink.js";
import { user } from "./helpers/api.js";
import { webhookTest } from "./helpers/webhooks.js";

const t = webhookTest();
const DAY = 86_400_000;

const sink = (firstAttempts = 0) =>
  createWebhookSink({ firstAttempts, resolver: () => async () => ["93.184.216.34"] });

/** The repository's ping event, its data a capture of `tree` (its blobs stored unless not). */
async function captured(
  tree: Record<string, CaptureValue>,
  options: { at?: number; store?: boolean; version?: number } = {},
): Promise<DomainEvent> {
  await t.createHook();
  const ping = (await t.outbox()).find((e) => e.webhooks) as DomainEvent;
  const capture = captureTree(tree);
  const at = options.at ?? ping.at;
  if (options.store !== false)
    await runInDurableObject(t.stub(), (instance: RepoDO, state) =>
      state.storage.transactionSync(() =>
        instance.webhookBlobStore.store(capture.blobs, at + DELIVERY_POLICY.captureDeadlineMs),
      ),
    );
  return {
    ...ping,
    at,
    data: {
      ...ping.data,
      webhook: { v: options.version ?? 1, tree: capture.tree, blobBytes: capture.blobBytes },
    },
  };
}

/** The effect the sink plans for `event`. */
function effectOf(event: DomainEvent, claimedAt = Date.now()): Effect & { planned: PlannedEffect } {
  const [planned] = sink().plan(event);
  if (!planned) throw new Error("the event makes no webhook effect");
  return {
    id: `effect_${eventKey(event.id)}`,
    sink: "webhooks",
    ...planned,
    attempts: 1,
    claimedAt,
    planned,
  };
}

/** Delivers `event`'s effect as the dispatcher would, claimed at `claimedAt`. */
const deliver = (
  event: DomainEvent,
  options: { claimedAt?: number; firstAttempts?: number; env?: Env; db?: D1Database } = {},
): ReturnType<EffectSink["deliver"]> =>
  sink(options.firstAttempts).deliver(
    effectOf(event, options.claimedAt),
    options.env ?? t.testEnv(),
    options.db ?? env.ORG_READ,
  );

const payloadOf = (event: DomainEvent) =>
  env.ORG_READ.prepare(
    "SELECT state, bytes, expires_at, payload_key FROM webhook_payloads WHERE event_key = ?",
  )
    .bind(eventKey(event.id))
    .first<{ state: string; bytes: number | null; expires_at: number; payload_key: string }>();

const deliveryRows = () =>
  env.ORG_READ.prepare(
    "SELECT delivery_id, state, reason, expires_at FROM webhook_deliveries WHERE repo_id = ?",
  )
    .bind(t.repo.id)
    .all<{ delivery_id: string; state: string; reason: string | null; expires_at: number }>()
    .then((r) => r.results);

const stored = async (event: DomainEvent) => {
  const object = await env.ASSETS.get(await bodyKeyOf(t.repo.id, eventKey(event.id)));
  return object ? await object.text() : null;
};

/** `env` whose R2 runs `before` ahead of each put. */
function puttingAfter(before: () => Promise<void>): Env {
  const base = t.testEnv();
  const assets = new Proxy(env.ASSETS, {
    get(target, prop) {
      if (prop !== "put") return Reflect.get(target, prop).bind(target);
      return async (...args: Parameters<R2Bucket["put"]>) => {
        await before();
        return target.put(...args);
      };
    },
  });
  return new Proxy(base, {
    get: (target, prop) => (prop === "ASSETS" ? assets : Reflect.get(target, prop)),
  });
}

/** A property of `target`, its methods bound to it. */
const forward = (target: object, prop: string | symbol) => {
  const value = Reflect.get(target, prop);
  return typeof value === "function" ? value.bind(target) : value;
};

/** `db` whose first `first()` of a statement starting with `sql` answers `answer()` instead. */
function withFirst(db: D1Database, sql: string, answer: () => Promise<unknown>): D1Database {
  let answered = false;
  return new Proxy(db, {
    get(target, prop) {
      if (prop !== "prepare") return forward(target, prop);
      return (query: string) => {
        const statement = target.prepare(query);
        if (!query.startsWith(sql)) return statement;
        return new Proxy(statement, {
          get(inner, key) {
            if (key !== "bind") return forward(inner, key);
            return (...values: unknown[]) =>
              new Proxy(inner.bind(...values), {
                get(bound, k) {
                  if (k !== "first" || answered) return forward(bound, k);
                  answered = true;
                  return answer;
                },
              });
          },
        });
      };
    },
  });
}

describe("webhook bodies made from captures", () => {
  it("are made once, before any delivery, exactly as captured, users shown by login", async () => {
    // Quotes, escapes and a lone surrogate, long enough to be kept as a blob.
    const body = `"quoted" \\   \ud800 ${"b".repeat(4_000)}`;
    const event = await captured({
      action: "opened",
      issue: { number: 7, title: "Short", body, user: { $user: t.owner.principalId } },
      sender: { $user: t.owner.principalId },
    });
    expect(await deliver(event, { firstAttempts: 1 })).toBeUndefined();

    const expected = {
      fyrden_payload: 1,
      action: "opened",
      issue: {
        number: 7,
        title: "Short",
        body,
        user: { id: t.owner.principalId, login: t.owner.handle },
      },
      sender: { id: t.owner.principalId, login: t.owner.handle },
    };
    const text = await stored(event);
    // Compared as JSON (lone surrogates escaped), so a failure can be reported.
    expect(JSON.stringify(JSON.parse(text ?? "null"))).toBe(JSON.stringify(expected));
    // The first attempt posts the stored bytes.
    expect(t.received.map((r) => r.body)).toEqual([text]);
    const payload = await payloadOf(event);
    expect(payload).toMatchObject({
      state: "established",
      bytes: new TextEncoder().encode(text ?? "").length,
    });
    expect(payload?.expires_at).toBeGreaterThan(Date.now() + DELIVERY_POLICY.retentionMs - 60_000);
    // Its deliveries are kept as long as it.
    expect((await deliveryRows()).map((r) => r.expires_at)).toEqual([payload?.expires_at]);
  });

  it("made again, use the stored body, whatever changed since", async () => {
    const event = await captured({
      body: "c".repeat(2_000),
      sender: { $user: t.owner.principalId },
    });
    await deliver(event);
    const first = await stored(event);
    // The blobs gone and the login changed: the stored body is used, not made again.
    await runInDurableObject(t.stub(), (_, state) => {
      state.storage.sql.exec("DELETE FROM webhook_blobs");
    });
    await env.DIRECTORY.prepare("UPDATE principals SET handle = ? WHERE id = ?")
      .bind(`renamed-${t.owner.handle}`, t.owner.principalId)
      .run();
    await env.ORG_READ.prepare("DELETE FROM webhook_deliveries WHERE repo_id = ?")
      .bind(t.repo.id)
      .run();
    // Kept until the body's time, not their own.
    await env.ORG_READ.prepare("UPDATE webhook_payloads SET expires_at = 4e12 WHERE event_key = ?")
      .bind(eventKey(event.id))
      .run();
    expect(await deliver(event)).toBeUndefined();
    expect(await stored(event)).toBe(first);
    expect((await deliveryRows()).map((r) => r.expires_at)).toEqual([4e12]);
  });

  it("stored first by another run, use that run's bytes", async () => {
    const event = await captured({ body: "d".repeat(2_000) });
    const key = await bodyKeyOf(t.repo.id, eventKey(event.id));
    // Another run stored its body, then died before establishing it.
    await env.ASSETS.put(key, '{"theirs":true}');
    await deliver(event, { firstAttempts: 1 });
    expect(await stored(event)).toBe('{"theirs":true}');
    expect(t.received.map((r) => r.body)).toEqual(['{"theirs":true}']);
    expect(await payloadOf(event)).toMatchObject({ state: "established", bytes: 15 });
  });

  it("are not made past the event's deadline", async () => {
    const old = Date.now() - DELIVERY_POLICY.captureDeadlineMs - DAY;
    const event = await captured({ body: "e".repeat(2_000) }, { at: old });
    expect(await deliver(event)).toEqual({ ended: expect.stringMatching(/^expired:/) });
    expect(await payloadOf(event)).toMatchObject({ state: "expired" });
    expect(await deliveryRows()).toEqual([]);
    expect(await stored(event)).toBeNull();
  });

  it("are closed past the deadline, so a run claimed before it cannot establish one after", async () => {
    const old = Date.now() - DELIVERY_POLICY.captureDeadlineMs - DAY;
    const event = await captured({ body: "n".repeat(2_000) }, { at: old });
    // A run claimed before the deadline, still storing its body when a later run expires it.
    let late: unknown;
    const expiring = puttingAfter(async () => {
      late = await deliver(event);
    });
    expect(await deliver(event, { claimedAt: old + DAY, env: expiring })).toEqual({
      ended: expect.stringMatching(/^expired:/),
    });
    expect(late).toEqual({ ended: expect.stringMatching(/^expired:/) });
    expect(await payloadOf(event)).toMatchObject({ state: "expired" });
    expect(await stored(event)).toBeNull();
    expect(await deliveryRows()).toEqual([]);
    // Closed, it stays so: no run makes it (nor stores a body), whenever it was claimed.
    let puts = 0;
    const counting = puttingAfter(async () => {
      puts++;
    });
    expect(await deliver(event, { claimedAt: old + DAY, env: counting })).toEqual({
      ended: expect.stringMatching(/^expired:/),
    });
    expect(puts).toBe(0);
  });

  it("past the deadline, are not closed once established, even after the late run looked", async () => {
    const old = Date.now() - DELIVERY_POLICY.captureDeadlineMs - DAY;
    const event = await captured({ body: "p".repeat(2_000) }, { at: old });
    // The late run's lookup finds nothing; a run claimed before the deadline then establishes
    // the body (and stops before its deliveries) before the late run closes the row.
    const racing = withFirst(
      env.ORG_READ,
      "SELECT state, expires_at FROM webhook_payloads",
      async () => {
        await deliver(event, { claimedAt: old + DAY });
        await env.ORG_READ.prepare("DELETE FROM webhook_deliveries WHERE repo_id = ?")
          .bind(t.repo.id)
          .run();
        return null;
      },
    );
    expect(await deliver(event, { db: racing })).toBeUndefined();
    expect(await payloadOf(event)).toMatchObject({ state: "established" });
    expect(await deliveryRows()).toHaveLength(1);
  });

  it("past the deadline, are delivered from a body established by a run that then stopped", async () => {
    const old = Date.now() - DELIVERY_POLICY.captureDeadlineMs - DAY;
    const event = await captured({ body: "o".repeat(2_000) }, { at: old });
    // Established, then stopped before its deliveries (they are lost the same way here).
    await deliver(event, { claimedAt: old + DAY });
    await env.ORG_READ.prepare("DELETE FROM webhook_deliveries WHERE repo_id = ?")
      .bind(t.repo.id)
      .run();
    expect(await deliver(event)).toBeUndefined();
    expect(await deliveryRows()).toHaveLength(1);
    expect(await payloadOf(event)).toMatchObject({ state: "established" });
  });

  it("are not made once the event is no longer the repository's, or its text is gone", async () => {
    const event = await captured({ body: "f".repeat(2_000) });
    expect(await deliver({ ...event, ownerGen: event.ownerGen + 1 })).toEqual({
      ended: "invalidated: its source was transferred",
    });
    const restored = { ...event, id: { ...event.id, epochGen: event.id.epochGen + 1 } };
    expect(await deliver(restored)).toEqual({ ended: "invalidated: its source was restored" });
    const lost = await captured({ body: "g".repeat(2_000) }, { store: false });
    expect(await deliver(lost)).toEqual({ ended: expect.stringMatching(/^payload_missing:/) });
    expect(await deliveryRows()).toEqual([]);
  });

  it("show a deleted, being deleted or unknown user as ghost, a suspended one by login", async () => {
    const [deleted, deleting, suspended] = await Promise.all([user(), user(), user()]);
    for (const [who, lifecycle] of [
      [deleted, "deleted"],
      [deleting, "deleting"],
      [suspended, "suspended"],
    ] as const)
      await env.DIRECTORY.prepare(
        "UPDATE principals SET lifecycle = ?, disabled_at = 1 WHERE id = ?",
      )
        .bind(lifecycle, who.principalId)
        .run();
    const event = await captured({
      users: [
        { $user: deleted.principalId },
        { $user: deleting.principalId },
        { $user: suspended.principalId },
        { $user: "usr_unknown" },
      ],
    });
    await deliver(event);
    expect(JSON.parse((await stored(event)) ?? "null").users).toEqual([
      { id: deleted.principalId, login: "ghost" },
      { id: deleting.principalId, login: "ghost" },
      { id: suspended.principalId, login: suspended.handle },
      { id: "usr_unknown", login: "ghost" },
    ]);
  });

  it("are dropped, not sent, when the capture is not one this version reads", async () => {
    const event = await captured({ body: "h".repeat(2_000) }, { version: 2 });
    // Nor one that would set the body's version marker itself.
    const marked = await captured({ fyrden_payload: 999 });
    await t.materialize([event, { ...marked, id: { ...marked.id, sourceSeq: 99 } }]);
    expect(await t.deliveries()).toEqual([
      expect.objectContaining({ state: "dropped", reason: "payload_invalid" }),
      expect.objectContaining({ state: "dropped", reason: "payload_invalid" }),
    ]);
    expect(await payloadOf(event)).toBeNull();
  });

  it("are not made for a deleted repository, nor left behind when it is deleted meanwhile", async () => {
    const tombstone = () =>
      env.ORG_READ.prepare(
        `INSERT INTO repos (repo_id, deleted, epoch_gen, version, owner_gen, updated_seq, updated_at)
         VALUES (?, 1, 1, 1, 1, 1, 0)
         ON CONFLICT (repo_id) DO UPDATE SET deleted = 1`,
      )
        .bind(t.repo.id)
        .run()
        .then(() => {});
    const event = await captured({ body: "i".repeat(2_000) });
    // Deleted while its body was being stored: the body and its row go, no delivery is made.
    expect(await deliver(event, { env: puttingAfter(tombstone) })).toBeUndefined();
    expect(await stored(event)).toBeNull();
    expect(await payloadOf(event)).toBeNull();
    expect(await deliveryRows()).toEqual([]);
    // Deleted before: none is started.
    expect(await deliver(event)).toEqual({ ended: "invalidated: its source was deleted" });
    expect(await stored(event)).toBeNull();
  });

  it("found gone at an attempt, fail it at once rather than wait for them", async () => {
    const event = await captured({ body: "j".repeat(2_000) });
    await deliver(event);
    const payload = await payloadOf(event);
    await env.ASSETS.delete(payload?.payload_key ?? "");
    const [row] = await deliveryRows();
    await attemptDelivery(t.deps(), row?.delivery_id ?? "");
    expect(await deliveryRows()).toEqual([
      expect.objectContaining({ state: "failed", reason: "payload_missing" }),
    ]);
  });

  it("go with their rows past their time, whatever their deliveries, and not with them", async () => {
    const event = await captured({ body: "k".repeat(2_000) });
    await deliver(event);
    const payload = await payloadOf(event);
    // Its deliveries past retention go; the body stays with its row.
    await env.ORG_READ.prepare("UPDATE webhook_deliveries SET expires_at = 0 WHERE repo_id = ?")
      .bind(t.repo.id)
      .run();
    await reconcileWebhooks(t.deps());
    expect(await deliveryRows()).toEqual([]);
    expect(await stored(event)).not.toBeNull();
    // Its row past its time: both go.
    await reconcileWebhooks(t.deps((payload?.expires_at ?? 0) + 1));
    expect(await payloadOf(event)).toBeNull();
    expect(await stored(event)).toBeNull();

    // An intent whose run died before establishing it, its object stored: both go a day past
    // the event's deadline.
    const orphan = await captured({ body: "l".repeat(2_000) });
    const key = await bodyKeyOf(t.repo.id, eventKey(orphan.id));
    const expires = orphan.at + DELIVERY_POLICY.captureDeadlineMs + DELIVERY_POLICY.intentGraceMs;
    await env.ORG_READ.prepare(
      `INSERT INTO webhook_payloads (event_key, repo_id, payload_key, state, expires_at)
       VALUES (?, ?, ?, 'intent', ?)`,
    )
      .bind(eventKey(orphan.id), t.repo.id, key, expires)
      .run();
    await env.ASSETS.put(key, "{}");
    await reconcileWebhooks(t.deps(expires - 1));
    expect(await stored(orphan)).toBe("{}");
    await reconcileWebhooks(t.deps(expires));
    expect(await payloadOf(orphan)).toBeNull();
    expect(await stored(orphan)).toBeNull();
  });

  it("are planned with their blobs' bytes counted, and their calls reserved", async () => {
    // One text in three places: read once, but in the body three times.
    const text = "m".repeat(5_000);
    const event = await captured({
      body: text,
      changes: { body: { from: text } },
      quoted: [text],
      users: [{ $user: t.owner.principalId }],
    });
    const { planned } = effectOf(event);
    const bytes = new TextEncoder().encode(JSON.stringify(text)).length;
    expect(planned.payload).toMatchObject({ occurredAt: event.at, externalBytes: 4 * bytes });
    const calls = (effect: PlannedEffect) => sink().calls?.(effect);
    const legacy = calls(sink().plan({ ...event, data: null })[0] as PlannedEffect);
    // The payload's row, its intent, the blobs, a login query, the conditional put, the winner's
    // body and the establishment, in place of the body's put.
    expect(calls(planned)).toBe((legacy ?? 0) + 6);
  });
});
