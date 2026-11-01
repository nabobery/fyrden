import { ReadModelWriter, writerDatabase } from "../read-model/executor.js";

/**
 * The organization shard every repository is in until multi-tenant routing
 * exists: a single-organization deployment binds one read-model database.
 */
export const DEFAULT_ORG_SHARD = "default";

/**
 * The read-model database of an organization shard, as it is bound: for
 * the executor and reads only (writes through it bypass admission).
 */
export function rawReadModel(env: Pick<Env, "ORG_READ">, shard: string): D1Database {
  if (shard !== DEFAULT_ORG_SHARD) throw new Error(`no read model is bound for shard ${shard}`);
  return env.ORG_READ;
}

/**
 * The read-model database of an organization shard. All read-model code
 * takes its database from here, so routing shards to several databases
 * later is a change in one place. Its writes go through the executor, each
 * under a lease of its own; work that writes often holds one writer for
 * all of them instead (`withReadModel`).
 */
export function readModelFor(env: Pick<Env, "ORG_READ" | "DIRECTORY">, shard: string): D1Database {
  // One a binding and shard, so code that groups work by its database keeps doing so.
  let byShard = models.get(env.ORG_READ);
  if (!byShard) {
    byShard = new Map();
    models.set(env.ORG_READ, byShard);
  }
  let db = byShard.get(shard);
  if (!db) {
    db = writerDatabase(
      rawReadModel(env, shard),
      new ReadModelWriter(env, shard, Date.now, { leasePerWrite: true }),
    );
    byShard.set(shard, db);
  }
  return db;
}

const models = new WeakMap<D1Database, Map<string, D1Database>>();
