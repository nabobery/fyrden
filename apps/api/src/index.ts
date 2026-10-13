import { createLogger, createMetrics, measureInvocation } from "@fyrden/adapters-cloudflare/obs";
import { createApp } from "./app.js";
import { archiveDirectoryAudit } from "./cron/directory-audit-archiver.js";
import { sweepEffects } from "./effects/dispatcher.js";
import { EFFECT_SINKS } from "./effects/sinks.js";
import { DEFAULT_ORG_SHARD, readModelFor } from "./events/read-model.js";
import { consumeEvents, EVENTS_QUEUE } from "./queues/events-consumer.js";
import { advanceDeletions } from "./repos/deletion.js";

export { NetworkDO } from "./do/NetworkDO.js";
export { OrgDO } from "./do/OrgDO.js";
export { RepoDO } from "./do/RepoDO.js";
export { RunDO } from "./do/RunDO.js";
export { UserDO } from "./do/UserDO.js";
export { ApiRpc } from "./rpc.js";

const app = createApp();

export default {
  fetch: app.fetch,
  async queue(batch, env) {
    if (batch.queue === EVENTS_QUEUE) {
      const metrics = createMetrics(env.METRICS);
      return measureInvocation(metrics, { where: "worker", op: "queue events" }, () =>
        consumeEvents(batch, env, { metrics }),
      );
    }
    // Nothing produces to the other queues yet; retrying keeps a message
    // that arrives early instead of dropping it.
    batch.retryAll();
  },
  async scheduled(_controller, env) {
    const metrics = createMetrics(env.METRICS);
    await measureInvocation(metrics, { where: "worker", op: "cron" }, async () => {
      // Each task on its own: one failing does not stop the other.
      const results = await Promise.allSettled([
        archiveDirectoryAudit({
          db: env.DIRECTORY,
          bucket: env.ASSETS,
          now: () => Date.now(),
          metrics,
        }),
        advanceDeletions(env, { metrics }),
        sweepEffects({
          db: readModelFor(env, DEFAULT_ORG_SHARD),
          env,
          sinks: EFFECT_SINKS,
          now: () => Date.now(),
          log: createLogger({ op: "cron.effects" }),
          metrics,
        }),
      ]);
      const failed = results.filter((r) => r.status === "rejected");
      for (const failure of failed)
        createLogger({ op: "cron" }).error("a scheduled task failed", { error: failure.reason });
      if (failed.length > 0) throw new Error(`${failed.length} scheduled task(s) failed`);
    });
  },
} satisfies ExportedHandler<Env>;
