import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
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
  const now = options.now?.() ?? Date.now();
  const db = readModelFor(env, listed.org_shard);
  const snapshots: Snapshot[] = exported.entities.map((entity) => ({
    id: {
      sourceId: repoId,
      epochGen: exported.epochGen,
      sourceSeq: Math.max(1, exported.watermark),
    },
    type: `${entity.type}.updated`,
    at: now,
    actor: null,
    actChain: [],
    ownerGen: exported.ownerGen,
    entity: { ...entity, row: { ...entity.row } },
    data: null,
    stored: false,
  }));
  const statements = [
    epochStatement(db, repoId, exported.epochGen, now),
    ...snapshots.map((snapshot) => repoStatement(db, repoId, snapshot, now)),
  ];
  options.metrics?.count("d1.query", { db: "org", op: "rebuild_apply" }, statements.length);
  await db.batch(statements);
  return "rebuilt";
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
