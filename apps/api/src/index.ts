import { createLogger, createMetrics, measureInvocation } from "@fyrden/adapters-cloudflare/obs";
import { rearmDeletions } from "./accounts/deletion-runner.js";
import { app } from "./app-instance.js";
import { archiveDirectoryAudit } from "./cron/directory-audit-archiver.js";
import { runEffectsCron } from "./cron/effects.js";
import { reapExpiredRepos } from "./cron/expiry-reaper.js";
import { reapOAuth } from "./oauth/reaper.js";
import { consumeEffects, sinkOfQueue } from "./queues/effects-consumer.js";
import { consumeEvents, EVENTS_QUEUE } from "./queues/events-consumer.js";
import { advanceDeletions } from "./repos/deletion.js";
import { settleStaleGenerations } from "./repos/generate.js";
import { advanceTransfers } from "./repos/transfer.js";
import { reapIdempotencyKeys } from "./rest/idempotency.js";
import { consumeWebhooks, WEBHOOKS_QUEUE } from "./webhooks/deliver.js";
import type { DeliveryMessage } from "./webhooks/sink.js";

export { DeletionDO } from "./do/DeletionDO.js";
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
    // Effects and webhook deliveries: an invocation of their own, its D1 queries their budget.
    if (controller.cron === DELETIONS_CRON)
      return measureInvocation(metrics, { where: "worker", op: "cron deletions" }, () =>
        rearmDeletions(env, { metrics }).then(() => {}),
      );
    if (controller.cron === EFFECTS_CRON)
      return measureInvocation(metrics, { where: "worker", op: "cron effects" }, () =>
        runEffectsCron(env, { metrics }),
      );
    await measureInvocation(metrics, { where: "worker", op: "cron" }, async () => {
      // Each task on its own: one failing does not stop the other.
      const results = await Promise.allSettled([
        archiveDirectoryAudit({
          db: env.DIRECTORY,
          bucket: env.ASSETS,
          now: () => Date.now(),
          metrics,
        }),
        // Expired repositories and abandoned generations first, so their
        // deletions start in the same run; deletions advance even when those fail.
        (async () => {
          const started = await Promise.allSettled([
            reapExpiredRepos(env, { now: Date.now(), metrics }),
            settleStaleGenerations(env, { now: Date.now(), metrics }),
          ]);
          await advanceDeletions(env, { metrics });
          const failed = started.find((r) => r.status === "rejected");
          if (failed) throw failed.reason;
        })(),
        reapIdempotencyKeys(env, { now: Date.now(), metrics }),
        advanceTransfers(env, { metrics }),
        reapOAuth(env, { now: Date.now(), metrics }),
      ]);
      const failed = results.filter((r) => r.status === "rejected");
      for (const failure of failed)
        createLogger({ op: "cron" }).error("a scheduled task failed", { error: failure.reason });
      if (failed.length > 0) throw new Error(`${failed.length} scheduled task(s) failed`);
    });
  },
} satisfies ExportedHandler<Env>;
