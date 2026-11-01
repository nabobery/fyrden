import type { backfillSearch, Input, Output, setSearchIndexing } from "@fyrden/api-contract";
import { DEFAULT_ORG_SHARD, readModelFor } from "../events/read-model.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { READ_MODEL_LONE_WRITE, READ_MODEL_PROTOCOL } from "../read-model/executor.js";
import { readModelState } from "../read-model/maintenance.js";
import { recoveryState } from "../read-model/recovery.js";
import { restoreTokenState } from "../read-model/restore-token.js";
import { clock } from "../services.js";
import { spentStatement } from "./admission.js";
import { REQUEST_ROWS, repairStatement, searchIndexing } from "./repairs.js";

/** Repositories one call of the backfill asks for (one batch of requests in each read model). */
const BACKFILL_REPOS = 100;

/**
 * The `admin.search.backfill` operation (instance administrators; the
 * executor checked it): asks for a reconciliation of a page of the active
 * repositories in the directory, in their read models, charged with
 * search's spending in the same batch (as if each wrote its row). The
 * maintenance's repair job then populates (or corrects) their projections
 * within the day's allowance. Only while search indexing is on: a
 * repository published meanwhile (its id may sort before the cursor) is
 * projected from its events, or, published late enough that some may have
 * been dropped, asks for its own reconciliation (`afterPublication`).
 */
export async function backfillSearchOperation(
  ctx: OpContext,
  input: Input<typeof backfillSearch>,
): Promise<Output<typeof backfillSearch>> {
  ctx.metrics.count("d1.query", { db: "directory", op: "search_indexing" });
  if (!(await searchIndexing(ctx.env)))
    throw new OperationError(
      409,
      "search_indexing_off",
      "Search indexing is off: a backfill asked now would miss the repositories made before it is turned on.",
    );
  ctx.metrics.count("d1.query", { db: "directory", op: "search_backfill_repos" });
  const { results } = await ctx.env.DIRECTORY.prepare(
    "SELECT id, org_shard FROM repos WHERE id > ? AND state = 'active' ORDER BY id LIMIT ?",
  )
    .bind(input.cursor ?? "", BACKFILL_REPOS)
    .all<{ id: string; org_shard: string }>();
  const byShard = new Map<string, string[]>();
  for (const { id, org_shard: shard } of results)
    byShard.set(shard, [...(byShard.get(shard) ?? []), id]);
  const now = clock();
  let requested = 0;
  for (const [shard, ids] of byShard) {
    const db = readModelFor(ctx.env, shard);
    ctx.metrics.count("d1.query", { db: "org", op: "search_backfill" }, ids.length + 1);
    const done = await db.batch([
      ...ids.map((id) => repairStatement(db, id, "backfill", now)),
      spentStatement(db, {
        rows: ids.length * REQUEST_ROWS + READ_MODEL_LONE_WRITE.rows,
        reads: READ_MODEL_LONE_WRITE.reads,
      }),
    ]);
    requested += done
      .slice(0, ids.length)
      .filter((result) => (result.meta.changes ?? 0) > 0).length;
  }
  return {
    requested,
    next_cursor: results.length === BACKFILL_REPOS ? (results.at(-1)?.id ?? null) : null,
  };
}

/**
 * The `admin.search.indexing` operation (instance administrators): turns
 * search indexing on or off, raising its generation in the same batch when
 * the state changes (a source known whole under an older one is not whole
 * to search: what happened while indexing was off was not projected); the
 * state it is in changes nothing. Turning it on is refused
 * (`search_not_ready`) while the read model is not running ordinary work
 * at its enforced protocol (in maintenance, its barriers apart), a recovery
 * of it is under way, or it was restored since its last handshake.
 */
export async function setSearchIndexingOperation(
  ctx: OpContext,
  input: Input<typeof setSearchIndexing>,
): Promise<Output<typeof setSearchIndexing>> {
  const { env } = ctx;
  // Turning it on: ready now, and still so (the barrier as read, no recovery) when it is written.
  let ready = "1";
  const binds: unknown[] = [input.enabled ? "on" : "off", clock()];
  if (input.enabled) {
    const checked = await readiness(ctx);
    if (typeof checked === "string") throw new OperationError(409, "search_not_ready", checked);
    binds.push(DEFAULT_ORG_SHARD, checked.generation);
    ready = `EXISTS (SELECT 1 FROM read_model_barriers WHERE shard = ?3 AND phase = 'running'
        AND generation = ?4)
      AND NOT EXISTS (SELECT 1 FROM read_model_recoveries WHERE shard = ?3 AND stage <> 'complete')`;
  }
  ctx.metrics.count("d1.query", { db: "directory", op: "search_indexing_set" });
  // The generation first, while the setting still holds the state it changes from (1 before any
  // change: the first makes it 2).
  const [, , still] = await env.DIRECTORY.batch([
    env.DIRECTORY.prepare(
      `INSERT INTO deployment_settings (name, value, updated_at)
       SELECT 'search_indexing_generation', '2', ?2
       WHERE coalesce((SELECT value FROM deployment_settings WHERE name = 'search_indexing'),
         'off') <> ?1 AND ${ready}
       ON CONFLICT (name) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT),
         updated_at = ?2`,
    ).bind(...binds),
    env.DIRECTORY.prepare(
      `INSERT INTO deployment_settings (name, value, updated_at)
       SELECT 'search_indexing', ?1, ?2 WHERE ${ready}
       ON CONFLICT (name) DO UPDATE SET value = ?1, updated_at = ?2 WHERE value <> ?1`,
    ).bind(...binds),
    ...(input.enabled ? [env.DIRECTORY.prepare(`SELECT ${ready} AS ready`).bind(...binds)] : []),
  ]);
  if (input.enabled && (still?.results[0] as { ready: number } | undefined)?.ready !== 1)
    throw new OperationError(
      409,
      "search_not_ready",
      "The read model's state changed while search indexing was being turned on. Try again.",
    );
  return { enabled: input.enabled };
}

/** Why search indexing cannot be turned on now, or the directory barrier's generation it is ready at. */
async function readiness(ctx: OpContext): Promise<string | { generation: number }> {
  const { env, metrics } = ctx;
  // The barriers and leases (two of each database), the recovery, the restore tokens (one of each).
  metrics.count("d1.query", { db: "directory", op: "read_model_status" }, 5);
  metrics.count("d1.query", { db: "org", op: "read_model_status" }, 3);
  const [state, recovery, token] = await Promise.all([
    readModelState(env, DEFAULT_ORG_SHARD),
    recoveryState(env, DEFAULT_ORG_SHARD),
    restoreTokenState(env, DEFAULT_ORG_SHARD),
  ]);
  const { directory, local } = state;
  if (
    directory?.phase !== "running" ||
    local?.phase !== "running" ||
    directory.generation !== local.generation
  )
    return "The read model is not running ordinary work (maintenance, or its barriers apart): resume it first.";
  if ((local.protocolVersion ?? 0) < READ_MODEL_PROTOCOL)
    return "The read model does not enforce the executor's protocol yet: deploy its migrations first.";
  if (recovery && recovery.stage !== "complete")
    return "A recovery of the read model is under way: finish it first.";
  if (token === "mismatch")
    return "The read model was restored or changed since its last handshake: recover it first.";
  return { generation: directory.generation };
}
