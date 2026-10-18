// Effects that cannot be claimed must show: a read model whose `effects`
// table predates the claim columns (a migration file that changed after a
// deployment applied it) fails every claim. The cron and the consumer log
// it as an error and count it, and the cron's other task still runs. This
// file's database is its own, so its schema can be broken for all of it.
import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createFakeDataset } from "@fyrden/adapters-cloudflare/obs/testing";
import { createIdFactory, type DomainEvent, secureRandomBytes } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, it } from "vitest";
import type { EffectSink } from "../src/effects/journal.js";
import worker from "../src/index.js";
import { applyEnvelope } from "../src/queues/events-consumer.js";
import { logs } from "./setup/log-capture.js";

const newId = createIdFactory(Date.now, secureRandomBytes);
const OWNER = "usr_01K742SG00NAWD8WB4RTMJF8H7";
/** The effects cron's trigger (wrangler.jsonc). */
const EFFECTS_CRON = "2-59/5 * * * *";

beforeAll(async () => {
  await env.ORG_READ.batch([
    env.ORG_READ.prepare("ALTER TABLE effects DROP COLUMN lease_token"),
    env.ORG_READ.prepare("ALTER TABLE effects DROP COLUMN lease_until"),
  ]);
});

async function pendingEffect(): Promise<string> {
  const id = uniqueId("effect");
  await env.ORG_READ.prepare(
    `INSERT INTO effects (effect_id, sink, target, payload, next_attempt_at, created_at)
     VALUES (?, 'webhooks', 'hooks', '{}', 0, 0)`,
  )
    .bind(id)
    .run();
  return id;
}

const effectRow = (id: string) =>
  env.ORG_READ.prepare("SELECT state, attempts FROM effects WHERE effect_id = ?").bind(id).first();

/** Counts `name`'s points by their first dimension. */
const counted = (points: { name: string; blobs: string[]; value: number }[], name: string) =>
  points
    .filter((p) => p.name === name)
    .reduce<Record<string, number>>((by, p) => {
      const key = p.blobs[0] ?? "";
      by[key] = (by[key] ?? 0) + p.value;
      return by;
    }, {});

describe("effects that cannot be claimed", () => {
  it("fail the effects cron loudly, and webhook deliveries are still reconciled", async () => {
    const effect = await pendingEffect();
    // A delivery past retention whose body was never stored: reconciling deletes it.
    const delivery = uniqueId("delivery");
    await env.ORG_READ.prepare(
      `INSERT INTO webhook_deliveries (delivery_id, repo_id, hook_id, event, action, private,
         payload_key, state, reason, attempts, next_attempt_at, created_at, updated_at, expires_at)
       VALUES (?, ?, 1, 'push', NULL, 1, ?, 'dropped', 'payload_too_large', 0, 0, 0, 0, 1)`,
    )
      .bind(delivery, uniqueId("rep"), `webhooks/${delivery}.json`)
      .run();
    const metrics = createFakeDataset();

    await expect(
      worker.scheduled?.(createScheduledController({ cron: EFFECTS_CRON }), {
        ...env,
        METRICS: metrics.dataset,
      }),
    ).rejects.toThrow(/lease_token/);

    expect(
      logs.entries().filter((e) => e.level === "error" && e.op === "cron.effects"),
    ).toMatchObject([
      { task: "effects.sweep", error: { message: expect.stringMatching(/lease_token/) } },
    ]);
    expect(counted(metrics.points, "effects.sweep")).toEqual({ error: 1 });
    expect(counted(metrics.points, "webhooks.reconcile")).toEqual({ ok: 1 });
    expect(
      await env.ORG_READ.prepare("SELECT 1 FROM webhook_deliveries WHERE delivery_id = ?")
        .bind(delivery)
        .first(),
    ).toBeNull();
    expect(await effectRow(effect)).toEqual({ state: "pending", attempts: 0 });
  });

  it("are logged as an error and counted by the events consumer, which still acknowledges", async () => {
    const repoId = newId("rep");
    await env.DIRECTORY.prepare(
      "INSERT INTO principals (id, type, handle, created_at) VALUES (?, 'user', 'failures-owner', 0) ON CONFLICT DO NOTHING",
    )
      .bind(OWNER)
      .run();
    await env.DIRECTORY.prepare(
      `INSERT INTO repos (id, owner_id, name, network_id, org_shard, visibility, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'default', 'private', 0, 0)`,
    )
      .bind(repoId, OWNER, repoId.toLowerCase(), newId("net"))
      .run();
    const event: DomainEvent = {
      id: { sourceId: repoId, epochGen: 1, sourceSeq: 1 },
      type: "refs.updated",
      at: 0,
      actor: OWNER,
      actChain: [],
      ownerGen: 1,
      entity: null,
      data: { via: "push", refs: [] },
      stored: false,
    };
    const sink: EffectSink = {
      name: "test_hook",
      plan: () => [{ target: "hook_1", payload: {} }],
      deliver: async () => {},
    };
    const points: string[] = [];
    const outcome = await applyEnvelope(
      env,
      { sourceId: repoId, events: [event] },
      {
        sinks: [sink],
        metrics: { count: (name, dims) => points.push(`${name} ${Object.values(dims)}`) },
      },
    );

    expect(outcome).toBe("applied");
    expect(
      logs.entries().filter((e) => e.level === "error" && e.op === "effects.dispatch"),
    ).toMatchObject([{ msg: "dispatching effects failed", sourceId: repoId }]);
    expect(points.filter((p) => p.startsWith("effects.dispatch"))).toEqual([
      "effects.dispatch error",
    ]);
    expect(await effectRow(`${repoId}:1:1:test_hook:hook_1`)).toEqual({
      state: "pending",
      attempts: 0,
    });
  });
});
