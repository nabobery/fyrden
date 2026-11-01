import { createLogger, type Metrics } from "@fyrden/adapters-cloudflare/obs";
import { type DispatchDeps, pruneEffects, recoverEffects } from "../effects/dispatcher.js";
import type { EffectSink } from "../effects/journal.js";
import { type Publish, publisher } from "../effects/queues.js";
import { EFFECT_SINKS, effectQueues } from "../effects/sinks.js";
import { DEFAULT_ORG_SHARD } from "../events/read-model.js";
import { withReadModel } from "../read-model/executor.js";
import { reconcileWebhooks } from "../webhooks/deliver.js";

/**
 * The effects cron: reconciles webhook deliveries, sends a message again
 * for overdue effects, and deletes effects past retention. It delivers
 * nothing itself: the sinks' queues do. Each task runs whether or not
 * another failed. A failure is logged as an error and counted
 * (`webhooks.reconcile` and `effects.recover`, by outcome), then thrown
 * once all have run, so the invocation still ends as an exception (an
 * `AggregateError` when several failed).
 */
export async function runEffectsCron(
  env: Env,
  options: {
    metrics: Metrics;
    now?: () => number;
    sinks?: readonly EffectSink[];
    publish?: Publish;
  },
): Promise<void> {
  const { metrics, sinks = EFFECT_SINKS } = options;
  const now = options.now ?? (() => Date.now());
  const failures: unknown[] = [];
  // One writer for the run's writes.
  await withReadModel(env, DEFAULT_ORG_SHARD, async (db) => {
    const log = createLogger({ op: "cron.effects" });
    const deps: DispatchDeps = {
      db,
      env,
      sinks,
      now,
      publish: options.publish ?? publisher(effectQueues(env), sinks, metrics),
      log,
      metrics,
    };
    const task = async (
      name: "effects.recover" | "webhooks.reconcile",
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
    await task("webhooks.reconcile", () => reconcileWebhooks({ env, db, now, metrics }));
    await task("effects.recover", async () => {
      // The prune first: a recovery that fails (a queue refusing sends) leaves it done.
      await pruneEffects(deps);
      await recoverEffects(deps);
    });
  });
  const [failure, ...more] = failures;
  if (more.length > 0) throw new AggregateError(failures, "effects cron: tasks failed");
  if (failure !== undefined) throw failure;
}
