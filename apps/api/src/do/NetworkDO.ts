import { DurableObject } from "cloudflare:workers";

/** One fork network: pack refcounts, leases and network-wide GC. */
export class NetworkDO extends DurableObject<Env> {}
