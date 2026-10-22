import { createMetrics, measureInvocation } from "@fyrden/adapters-cloudflare/obs";
import { rearmDeletions } from "./accounts/deletion-runner.js";
import { app } from "./app-instance.js";
import { runEffectsCron } from "./cron/effects.js";
import { MAINTENANCE_OBJECT } from "./cron/maintenance.js";
import { consumeEffects, sinkOfQueue } from "./queues/effects-consumer.js";
import { consumeEvents, EVENTS_QUEUE } from "./queues/events-consumer.js";
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

export default {
  fetch: app.fetch,
  async queue(batch, env) {
    if (batch.queue === EVENTS_QUEUE) {
      const metrics = createMetrics(env.METRICS);
      return measureInvocation(metrics, { where: "worker", op: "queue events" }, () =>
        consumeEvents(batch, env, { metrics }),
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
    if (controller.cron === EFFECTS_CRON)
      return measureInvocation(metrics, { where: "worker", op: "cron effects" }, () =>
        runEffectsCron(env, { metrics }),
      );
    // The rest in the maintenance object: a Free cron trigger's 10 ms of CPU is too little.
    await measureInvocation(metrics, { where: "worker", op: "cron" }, () => {
      metrics.count("do.request", { class: "MaintenanceDO", method: "run" });
      return env.MAINTENANCE.getByName(MAINTENANCE_OBJECT).run();
    });
  },
} satisfies ExportedHandler<Env>;
