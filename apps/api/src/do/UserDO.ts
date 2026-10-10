import { DurableObject } from "cloudflare:workers";

/** One user or agent: activity feed, inbox and WebSocket fan-out. */
export class UserDO extends DurableObject<Env> {}
