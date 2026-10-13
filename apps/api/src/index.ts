import { createApp } from "./app.js";

export { NetworkDO } from "./do/NetworkDO.js";
export { OrgDO } from "./do/OrgDO.js";
export { RepoDO } from "./do/RepoDO.js";
export { RunDO } from "./do/RunDO.js";
export { UserDO } from "./do/UserDO.js";
export { ApiRpc } from "./rpc.js";

const app = createApp();

export default {
  fetch: app.fetch,
  // Repository outboxes produce to the events queue; nothing consumes it
  // yet. Retrying keeps a message that arrives early instead of dropping it.
  async queue(batch) {
    batch.retryAll();
  },
} satisfies ExportedHandler<Env>;
