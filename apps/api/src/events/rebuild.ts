import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import type { RepoExport } from "../do/repo/events.js";
import { epochStatement, repoStatement, type Snapshot } from "../queues/events-consumer.js";
import { DEFAULT_ORG_SHARD, readModelFor } from "./read-model.js";

/**
 * Rebuilds read-model rows from the repositories' own state, never from
 * the outbox (sent events are gone, and queue retention is short). Each
 * exported snapshot goes through the same guarded upsert the consumer
 * uses, so a rebuild running while events still arrive cannot move a row
 * back, and redoing it changes nothing.
 */

/** Repositories rebuilt per call of `rebuildReadModels`, by default and at most. Proposed. */
export const REBUILD_PAGE = 50;
export const MAX_REBUILD_PAGE = 500;

/** Rebuilds one repository's rows; `skipped` when it is not active or has no identity. */
export async function rebuildRepo(
  env: Env,
  repoId: string,
  options: { now?: () => number; metrics?: Metrics } = {},
): Promise<"rebuilt" | "skipped"> {
  options.metrics?.count("d1.query", { db: "directory", op: "rebuild_route" });
  const listed = await env.DIRECTORY.prepare("SELECT state, org_shard FROM repos WHERE id = ?")
    .bind(repoId)
    .first<{ state: string; org_shard: string }>();
  if (listed?.state !== "active") return "skipped";
  const exported = await env.REPO.getByName(repoId).exportSnapshot();
  if (!exported) return "skipped";
  await applyExport(env, listed.org_shard, exported, options);
  return "rebuilt";
}

/**
 * Applies a repository's exported snapshot (a tombstone, once it is
 * deleted) to its shard's read model, through the consumer's guarded upsert.
 */
export async function applyExport(
  env: Env,
  shard: string,
  exported: RepoExport,
  options: { now?: () => number; metrics?: Metrics } = {},
): Promise<void> {
  const now = options.now?.() ?? Date.now();
  const db = readModelFor(env, shard);
  const { sourceId } = exported;
  const snapshots: Snapshot[] = exported.entities.map((entity) => ({
    id: {
      sourceId,
      epochGen: exported.epochGen,
      sourceSeq: Math.max(1, exported.watermark),
    },
    type: `${entity.type}.${entity.deleted ? "deleted" : "updated"}`,
    at: now,
    actor: null,
    actChain: [],
    ownerGen: exported.ownerGen,
    entity: { ...entity, row: entity.row && { ...entity.row } },
    data: null,
    stored: false,
  }));
  const statements = [
    epochStatement(db, sourceId, exported.epochGen, now),
    ...snapshots.map((snapshot) => repoStatement(db, sourceId, snapshot, now)),
  ];
  options.metrics?.count("d1.query", { db: "org", op: "rebuild_apply" }, statements.length);
  await db.batch(statements);
}

/**
 * Rebuilds the next page of a shard's active repositories, in id order,
 * after `cursor`; returns the cursor to continue from, or null when done.
 */
export async function rebuildReadModels(
  env: Env,
  cursor: string | null,
  options: { shard?: string; pageSize?: number; now?: () => number; metrics?: Metrics } = {},
): Promise<{ rebuilt: number; next: string | null }> {
  const pageSize = options.pageSize ?? REBUILD_PAGE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_REBUILD_PAGE)
    throw new RangeError(`page size must be an integer from 1 to ${MAX_REBUILD_PAGE}`);
  options.metrics?.count("d1.query", { db: "directory", op: "rebuild_page" });
  const { results } = await env.DIRECTORY.prepare(
    `SELECT id FROM repos WHERE org_shard = ? AND state = 'active' AND id > ?
     ORDER BY id LIMIT ?`,
  )
    .bind(options.shard ?? DEFAULT_ORG_SHARD, cursor ?? "", pageSize)
    .all<{ id: string }>();
  let rebuilt = 0;
  for (const { id } of results) if ((await rebuildRepo(env, id, options)) === "rebuilt") rebuilt++;
  return { rebuilt, next: results.length === pageSize ? (results.at(-1)?.id ?? null) : null };
}
