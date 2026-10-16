// Webhook retention: the cron deletes deliveries past retention at least as
// fast as a deployment can make them, their bodies first, and spends no R2
// deletion on a body that was never stored. This file's database holds only
// the deliveries its tests make, so a cron run here meets nothing else.
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import { HOOK_POLICY } from "../src/do/repo/hooks.js";
import { EFFECT_POLICY, INLINE_EFFECTS } from "../src/effects/journal.js";
import { ATTEMPT_POLICY, reconcileWebhooks } from "../src/webhooks/deliver.js";

/** Runs of the effects cron a day (wrangler.jsonc: `2-59/5 * * * *`, every 5 minutes). */
const CRON_RUNS_A_DAY = (24 * 60) / 5;
/** Events a run's worth of deliveries comes from, each to every hook a repository has. */
const EVENTS = ATTEMPT_POLICY.pruneBatch / HOOK_POLICY.maxHooks;

/**
 * Admits a run's worth of deliveries (`pruneBatch`), expiring at
 * `expiresAt`: of each five events, one dropped for every hook (its body
 * never stored), one dropped for half of them (its body stored for the
 * others), three sent, each sent delivery with an attempt recorded.
 * Returns the bodies stored.
 */
async function admit(repoId: string, run: number, expiresAt: number): Promise<string[]> {
  const prefix = `webhooks/${repoId}/${run}-`;
  const dropped = "(i % 5 = 0 OR (i % 5 = 1 AND j % 2 = 0))";
  await env.ORG_READ.prepare(
    `WITH RECURSIVE e(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM e WHERE i < ?3 - 1),
       h(j) AS (SELECT 1 UNION ALL SELECT j + 1 FROM h WHERE j < ?4)
     INSERT INTO webhook_deliveries (delivery_id, repo_id, hook_id, event, action, private,
       payload_key, state, reason, attempts, next_attempt_at, created_at, updated_at, expires_at)
     SELECT ?1 || '-' || ?2 || '-' || i || '-' || j, ?1, j, 'push', NULL, 1, ?5 || i || '.json',
       CASE WHEN ${dropped} THEN 'dropped' ELSE 'done' END,
       CASE WHEN ${dropped} THEN 'payload_too_large' END,
       CASE WHEN ${dropped} THEN 0 ELSE 1 END, ?6, ?6, ?6, ?7
     FROM e, h`,
  )
    .bind(repoId, run, EVENTS, HOOK_POLICY.maxHooks, prefix, expiresAt - 1, expiresAt)
    .run();
  await env.ORG_READ.prepare(
    `INSERT INTO webhook_attempts (delivery_id, n, at, status, response_excerpt)
     SELECT delivery_id, 1, created_at, 200, 'ok' FROM webhook_deliveries
     WHERE repo_id = ?1 AND substr(payload_key, 1, length(?2)) = ?2 AND state = 'done'`,
  )
    .bind(repoId, prefix)
    .run();
  const stored: string[] = [];
  for (let i = 0; i < EVENTS; i++) {
    if (i % 5 === 0) continue;
    stored.push(`${prefix}${i}.json`);
    await env.ASSETS.put(`${prefix}${i}.json`, "{}");
  }
  return stored;
}

const count = async (sql: string, ...values: unknown[]) =>
  (
    await env.ORG_READ.prepare(sql)
      .bind(...values)
      .first<{ n: number }>()
  )?.n;

describe("webhook retention", () => {
  it("deletes at least as many deliveries a day as Workers Free lets a deployment make", () => {
    // Free's queues: 10,000 operations a day, three a message (verified:
    // https://developers.cloudflare.com/queues/platform/pricing/), so at most a third as many
    // events consumer invocations. Each delivers INLINE_EFFECTS webhook effects itself at most,
    // the effects cron sweepBatch a run, and an effect makes a delivery for each hook it names.
    const invocations = Math.floor(10_000 / 3);
    const made =
      (invocations * INLINE_EFFECTS + CRON_RUNS_A_DAY * EFFECT_POLICY.sweepBatch) *
      HOOK_POLICY.maxHooks;
    expect(CRON_RUNS_A_DAY * ATTEMPT_POLICY.pruneBatch).toBeGreaterThanOrEqual(made);
    // One bulk R2 delete a run holds every body it deletes (R2 takes up to 1,000 keys a call).
    expect(ATTEMPT_POLICY.pruneBatch).toBeLessThanOrEqual(1_000);
  });

  it("keep no backlog across cron runs that each admit a run's worth", async () => {
    const repoId = uniqueId("rep");
    const deleted: string[][] = [];
    const deps = (now: number) => ({
      env: {
        ...env,
        ASSETS: {
          delete: async (keys: string | string[]) => {
            const list = typeof keys === "string" ? [keys] : keys;
            deleted.push(list);
            await env.ASSETS.delete(list);
          },
        },
      } as unknown as Env,
      db: env.ORG_READ,
      now: () => now,
    });
    const start = Date.now();
    // Not expired: kept throughout.
    const kept = await admit(repoId, -1, start + 365 * 24 * 60 * 60_000);
    const mine = "repo_id = ? AND expires_at <= ?";
    for (let run = 0; run < 3; run++) {
      const now = start + run * 5 * 60_000;
      const stored = await admit(repoId, run, now);
      deleted.length = 0;
      expect(await reconcileWebhooks(deps(now))).toMatchObject({
        pruned: ATTEMPT_POLICY.pruneBatch,
      });
      expect(
        await count(`SELECT count(*) AS n FROM webhook_deliveries WHERE ${mine}`, repoId, now),
      ).toBe(0);
      expect(
        await count(
          "SELECT count(*) AS n FROM webhook_attempts WHERE substr(delivery_id, 1, length(?1)) = ?1",
          `${repoId}-${run}-`,
        ),
      ).toBe(0);
      // One bulk delete, of the stored bodies alone.
      expect(deleted).toHaveLength(1);
      expect([...(deleted[0] ?? [])].sort()).toEqual([...stored].sort());
      for (const key of stored) expect(await env.ASSETS.head(key)).toBeNull();
    }
    expect(
      await count("SELECT count(*) AS n FROM webhook_deliveries WHERE repo_id = ?", repoId),
    ).toBe(ATTEMPT_POLICY.pruneBatch);
    for (const key of kept) expect(await env.ASSETS.head(key)).not.toBeNull();
  });
});
