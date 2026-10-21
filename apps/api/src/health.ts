import { createMetrics, type Metrics, type RequestMeta } from "@fyrden/adapters-cloudflare/obs";
import type { EffectsCheck, HealthCheck, HealthReport, HealthResult } from "@fyrden/api-contract";
import { DEFAULT_ORG_SHARD, readModelFor } from "./events/read-model.js";

async function timed(check: () => Promise<boolean>): Promise<HealthCheck> {
  const start = performance.now();
  try {
    const ok = await check();
    return { ok, ms: Math.round(performance.now() - start) };
  } catch (error) {
    return {
      ok: false,
      ms: Math.round(performance.now() - start),
      error: error instanceof Error ? error.name : "unknown",
    };
  }
}

/**
 * How late the oldest pending effect (a webhook delivery or feed entry to
 * make) may be before the effects check reports it: its queue delivers it
 * within seconds, and the effects cron sends a lost one's message again
 * every five minutes, so this is a queue that does not deliver, or a
 * recovery that does not work. Proposed.
 */
export const EFFECTS_OVERDUE_MS = 15 * 60 * 1000;

/**
 * How long an effect that failed for good (its attempts spent, or its sink
 * unknown) is reported: until an operator has had the chance to see it, on
 * a check run every few minutes. Proposed.
 */
export const EFFECTS_FAILED_MS = 60 * 60 * 1000;

/** The oldest pending effect's due time, through the `effects_due_order` index: one row read. */
export const OLDEST_PENDING_EFFECT =
  "SELECT next_attempt_at FROM effects WHERE state = 'pending' ORDER BY next_attempt_at LIMIT 1";

/**
 * Whether an effect failed for good since `?1`, through the
 * `effects_failed_reportable` index (its terms repeated as they are there):
 * one row read, whatever the number of effects ended because their source
 * went (not failures).
 */
export const RECENTLY_FAILED_EFFECT = `SELECT EXISTS (SELECT 1 FROM effects
  WHERE state = 'failed' AND coalesce(last_error, '') NOT LIKE 'invalidated:%'
    AND next_attempt_at > ?1) AS failed`;

/**
 * Whether effects are being delivered: how long the oldest pending one
 * has been due, in seconds (0 when none is), and whether one failed for
 * good lately. Only that age and that flag are reported (a public
 * endpoint), and they do not fail the deep check: the API serves without
 * effects, so it reads as degraded.
 */
async function checkEffects(env: Env, metrics: Metrics): Promise<EffectsCheck> {
  let overdueS = 0;
  let failed = false;
  const check = await timed(async () => {
    const db = readModelFor(env, DEFAULT_ORG_SHARD);
    const now = Date.now();
    metrics.count("d1.query", { db: "org", op: "healthz_effects" }, 2);
    const [oldest, recent] = await db.batch<Record<string, number | null>>([
      db.prepare(OLDEST_PENDING_EFFECT),
      db.prepare(RECENTLY_FAILED_EFFECT).bind(now - EFFECTS_FAILED_MS),
    ]);
    const due = oldest?.results[0]?.next_attempt_at ?? null;
    const overdueMs = due === null ? 0 : Math.max(0, now - due);
    overdueS = Math.floor(overdueMs / 1000);
    failed = recent?.results[0]?.failed === 1;
    return overdueMs <= EFFECTS_OVERDUE_MS && !failed;
  });
  return check.error === undefined ? { ...check, overdueS, failed } : check;
}

/**
 * Round-trips each storage tier the API depends on: a D1 read, a RepoDO
 * SQLite write and read, and an R2 put, get and delete; and reports how
 * late effects are (`checkEffects`). The probe nonce is random per call;
 * the caller's request id is tracing metadata only, so two concurrent
 * probes never share an R2 key.
 */
async function checkHealth(env: Env, meta: RequestMeta, metrics: Metrics): Promise<HealthReport> {
  const nonce = crypto.randomUUID();
  // Cost counters, each counted as its operation is attempted;
  // the R2 delete is free and not counted.
  const [d1, durableObject, r2, effects] = await Promise.all([
    timed(async () => {
      metrics.count("d1.query", { db: "directory", op: "healthz" });
      return (await env.DIRECTORY.prepare("SELECT 1 AS one").first("one")) === 1;
    }),
    timed(() => {
      metrics.count("do.request", { class: "RepoDO", method: "healthProbe" });
      return env.REPO.getByName("_healthz").healthProbe(nonce, meta);
    }),
    timed(async () => {
      const key = `_healthz/${nonce}`;
      metrics.count("r2.class_a", { bucket: "fyrden-assets", op: "put" });
      await env.ASSETS.put(key, nonce);
      try {
        metrics.count("r2.class_b", { bucket: "fyrden-assets", op: "get" });
        return (await (await env.ASSETS.get(key))?.text()) === nonce;
      } finally {
        await env.ASSETS.delete(key);
      }
    }),
    checkEffects(env, metrics),
  ]);
  return { ok: d1.ok && durableObject.ok && r2.ok, checks: { d1, durableObject, r2, effects } };
}

/**
 * The deep health check behind GET /healthz and the web Worker's RPC call.
 * Each call writes to R2 and a Durable Object, so every entry point shares
 * one global rate-limit bucket.
 */
export async function deepHealth(
  env: Env,
  meta: RequestMeta = {},
  metrics: Metrics = createMetrics(env.METRICS),
): Promise<HealthResult> {
  const { success } = await env.RATE_LIMIT_HEALTHZ.limit({ key: "healthz" });
  if (!success) return { rateLimited: true };
  return { rateLimited: false, report: await checkHealth(env, meta, metrics) };
}
