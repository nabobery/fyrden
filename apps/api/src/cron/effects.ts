import { createLogger, type Metrics } from "@fyrden/adapters-cloudflare/obs";
import { sweepEffects } from "../effects/dispatcher.js";
import { EFFECT_SINKS } from "../effects/sinks.js";
import { DEFAULT_ORG_SHARD, readModelFor } from "../events/read-model.js";
import { reconcileWebhooks } from "../webhooks/deliver.js";

/**
 * The effects cron: retries due effects, then reconciles webhook
 * deliveries. Each task runs whether or not the other failed. A failure is
 * logged as an error and counted (`effects.sweep` and `webhooks.reconcile`,
 * by outcome), then thrown once both have run, so the invocation still
 * ends as an exception (an `AggregateError` when both failed).
 */
export async function runEffectsCron(
  env: Env,
  options: { metrics: Metrics; now?: () => number },
): Promise<void> {
  const { metrics } = options;
  const now = options.now ?? (() => Date.now());
  const db = readModelFor(env, DEFAULT_ORG_SHARD);
  const log = createLogger({ op: "cron.effects" });
  const failures: unknown[] = [];
  const task = async (
    name: "effects.sweep" | "webhooks.reconcile",
    run: () => Promise<unknown>,
  ) => {
    try {
      await run();
      metrics.count(name, { outcome: "ok" });
    } catch (error) {
      metrics.count(name, { outcome: "error" });
      log.error("an effects cron task failed", { task: name, error });
      failures.push(error);
    }
  };
  await task("effects.sweep", () =>
    sweepEffects({ db, env, sinks: EFFECT_SINKS, now, log, metrics }),
  );
  await task("webhooks.reconcile", () => reconcileWebhooks({ env, db, now, metrics }));
  const [failure, ...more] = failures;
  if (more.length > 0) throw new AggregateError(failures, "effects cron: both tasks failed");
  if (failure !== undefined) throw failure;
}
