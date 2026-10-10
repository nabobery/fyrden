import { DurableObject } from "cloudflare:workers";

/** One CI run: job graph, job state and log fan-out. */
export class RunDO extends DurableObject<Env> {}
