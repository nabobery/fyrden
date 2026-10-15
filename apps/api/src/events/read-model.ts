/**
 * The organization shard every repository is in until multi-tenant routing
 * exists: a single-organization deployment binds one read-model database.
 */
export const DEFAULT_ORG_SHARD = "default";

/**
 * The read-model database of an organization shard. All read-model code
 * takes its database from here, so routing shards to several databases
 * later is a change in one place.
 */
export function readModelFor(env: Pick<Env, "ORG_READ">, shard: string): D1Database {
  if (shard !== DEFAULT_ORG_SHARD) throw new Error(`no read model is bound for shard ${shard}`);
  return env.ORG_READ;
}
