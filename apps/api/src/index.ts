import { createMetrics, measureInvocation } from "@fyrden/adapters-cloudflare/obs";
import { rearmDeletions } from "./accounts/deletion-runner.js";
import { app } from "./app-instance.js";
import { runEffectsCron } from "./cron/effects.js";
import { MAINTENANCE_OBJECT } from "./cron/maintenance.js";
import { effectQueues } from "./effects/sinks.js";
import { consumeEffects, sinkOfQueue } from "./queues/effects-consumer.js";
import { consumeEvents, EVENTS_QUEUE } from "./queues/events-consumer.js";
import { consumeFailedEvents, EVENTS_DLQ } from "./queues/events-dlq.js";
import { putBack, readModelMaintenance } from "./read-model/maintenance.js";
import { consumeWebhooks, WEBHOOKS_QUEUE } from "./webhooks/deliver.js";
import type { DeliveryMessage } from "./webhooks/sink.js";

export { DeletionDO } from "./do/DeletionDO.js";
export { MaintenanceDO } from "./do/MaintenanceDO.js";
export { NetworkDO } from "./do/NetworkDO.js";
export { OrgDO } from "./do/OrgDO.js";
export { RepoDO } from "./do/RepoDO.js";
export { RunDO } from "./do/RunDO.js";
export { UserDO } from "./do/UserDO.js";
export { ApiRpc } from "./rpc.js";

/** The cron trigger that recovers effects and reconciles webhook deliveries (wrangler.jsonc). */
const EFFECTS_CRON = "2-59/5 * * * *";
/** The user deletions' recovery: re-arms one job whose alarm was lost, a run. */
const DELETIONS_CRON = "4-59/5 * * * *";

/** The producer of each queue whose consumer writes the read model: its messages wait out maintenance. */
function readModelQueue(env: Env, queue: string): Queue | undefined {
  if (queue === EVENTS_QUEUE) return env.EVENTS;
  if (queue === EVENTS_DLQ) return env.EVENTS_DLQ;
  if (queue === WEBHOOKS_QUEUE) return env.WEBHOOKS;
  const sink = sinkOfQueue(queue);
  return sink === undefined ? undefined : effectQueues(env)[sink];
}

export default {
  fetch: app.fetch,
  async queue(batch, env) {
    const held = readModelMaintenance(env) ? readModelQueue(env, batch.queue) : undefined;
    if (held) return putBack(batch, held);
    if (batch.queue === EVENTS_QUEUE) {
      const metrics = createMetrics(env.METRICS);
      return measureInvocation(metrics, { where: "worker", op: "queue events" }, () =>
        consumeEvents(batch, env, { metrics }),
      );
    }
    if (batch.queue === EVENTS_DLQ) {
      const metrics = createMetrics(env.METRICS);
      return measureInvocation(metrics, { where: "worker", op: "queue events dead letters" }, () =>
        consumeFailedEvents(batch, env, { metrics }),
      );
    }
    if (batch.queue === WEBHOOKS_QUEUE) {
      const metrics = createMetrics(env.METRICS);
      return measureInvocation(metrics, { where: "worker", op: "queue webhooks" }, () =>
        consumeWebhooks(batch as MessageBatch<DeliveryMessage>, env, { metrics }),
      );
    }
    const sink = sinkOfQueue(batch.queue);
    if (sink !== undefined) {
      const metrics = createMetrics(env.METRICS);
      return measureInvocation(metrics, { where: "worker", op: `queue effects ${sink}` }, () =>
        consumeEffects(batch, env, { metrics }),
      );
    }
    // Nothing produces to the other queues yet; retrying keeps a message
    // that arrives early instead of dropping it.
    batch.retryAll();
  },
  async scheduled(controller, env) {
    const metrics = createMetrics(env.METRICS);
    // Each cron an invocation of its own, its D1 queries its budget.
    if (controller.cron === DELETIONS_CRON)
      return measureInvocation(metrics, { where: "worker", op: "cron deletions" }, () =>
        rearmDeletions(env, { metrics }).then(() => {}),
      );
    if (controller.cron === EFFECTS_CRON) {
      // It writes the read model: not while its maintenance holds ordinary work back.
      if (readModelMaintenance(env)) return;
      return measureInvocation(metrics, { where: "worker", op: "cron effects" }, () =>
        runEffectsCron(env, { metrics }),
      );
    }
    // The rest in the maintenance object: a Free cron trigger's 10 ms of CPU is too little.
    await measureInvocation(metrics, { where: "worker", op: "cron" }, async () => {
      const maintenance = env.MAINTENANCE.getByName(MAINTENANCE_OBJECT);
      metrics.count("do.request", { class: "MaintenanceDO", method: "run" }, 4);
      // Search repairs, suppression rechecks and revocation sweeps in requests of their own, so
      // their D1 calls, lookups and feed calls are an invocation's own.
      const outcomes = await Promise.allSettled([
        maintenance.run(),
        maintenance.repairSearch(),
        maintenance.recheckSuppressions(),
        maintenance.sweepRevocations(),
      ]);
      for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
    });
  },
} satisfies ExportedHandler<Env>;
