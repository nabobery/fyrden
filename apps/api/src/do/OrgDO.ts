import { DurableObject } from "cloudflare:workers";

/** One organization: teams, ACL snapshots, CI secrets and quotas. */
export class OrgDO extends DurableObject<Env> {}
