import { createMetrics, type Metrics, type RequestMeta } from "@fyrden/adapters-cloudflare/obs";
import type { HealthCheck, HealthReport, HealthResult } from "@fyrden/api-contract";

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
 * Round-trips each storage tier the API depends on: a D1 read, a RepoDO
 * SQLite write and read, and an R2 put, get and delete. The probe nonce is
 * random per call; the caller's request id is tracing metadata only, so two
 * concurrent probes never share an R2 key.
 */
async function checkHealth(env: Env, meta: RequestMeta, metrics: Metrics): Promise<HealthReport> {
  const nonce = crypto.randomUUID();
  // Cost counters, each counted as its operation is attempted;
  // the R2 delete is free and not counted.
  const [d1, durableObject, r2] = await Promise.all([
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
  ]);
  return { ok: d1.ok && durableObject.ok && r2.ok, checks: { d1, durableObject, r2 } };
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
