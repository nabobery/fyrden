import { createMetrics, measureInvocation } from "@fyrden/adapters-cloudflare/obs";
import { createApp } from "./app.js";
import { consumeEvents, EVENTS_QUEUE } from "./queues/events-consumer.js";

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
} satisfies ExportedHandler<Env>;
