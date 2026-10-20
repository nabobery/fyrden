import { createLogger, type Metrics } from "@fyrden/adapters-cloudflare/obs";
import { parseRepoRow, REPO_ENTITY } from "@fyrden/domain";
import type { RepoExport } from "../do/repo/events.js";
import { readModelFor } from "../events/read-model.js";
import { applyExport } from "../events/rebuild.js";
import { clock } from "../services.js";
import { runCleanups } from "./cleanups.js";
import {
  actChain,
  forgetRepo,
  forgetResolved,
  NOT_TRANSFERRING,
  type RepoEntry,
} from "./directory.js";

/*
 * Deleting a repository: a resumable job whose state lives in the
 * directory (`repo_deletions`), outside the storage it erases. Steps, each
 * safe to redo:
 *
 * 1. Marked (one directory batch, `markDeletions`): the repository becomes
 *    `deleting`, so every request misses it (an isolate that cached it
 *    before, for up to the cache's 30 s); its redirects go; audited.
 * 2. `prepare`: the repository object freezes (no ref, HEAD or setting
 *    changes from now on) and emits its tombstone, drops its queued jobs,
 *    sends its events and archives every audit row to R2 (an R2 outage
 *    keeps the job here: no audit row is lost).
 * 3. `purge`: the tombstone goes into the read model through the
 *    consumer's guarded upsert (the consumer drops events of a repository
 *    that is not active), kept with the deletion for later rebuilds.
 * 4. `cleanup`: what the repository left outside its storage (effects,
 *    webhook deliveries and their bodies) goes, a cleanup at a time, each
 *    recorded once done (`cleanups.ts`).
 * 5. `erase`: the object erases its R2 bytes and leaves its fork networks
 *    (forks keep the packs they claim), then deletes its storage.
 * 6. `done`: the repository becomes `deleted`, which frees its name. Its
 *    id is never reused.
 *
 * The request that deletes advances the job as far as it can; the cron
 * advances the rest, oldest first.
 */

export type DeletionStep = "prepare" | "purge" | "cleanup" | "erase" | "done";

/**
 * Keeps a deleted repository's tombstone (its repository entity alone)
 * with its deletion, with the row the read model ended with (an event's
 * tombstone carries none): a rebuild puts the same tombstone into an empty
 * read model.
 */
export async function keepTombstone(
  env: Env,
  shard: string,
  exported: RepoExport,
  metrics?: Metrics,
): Promise<void> {
  const entity = exported.entities.find((e) => e.type === REPO_ENTITY);
  if (exported.entities.length !== 1 || !entity?.deleted)
    throw new Error("a tombstone is the deleted repository entity alone");
  metrics?.count("d1.query", { db: "org", op: "deletion_tombstone_row" });
  const last = await readModelFor(env, shard)
    .prepare(
      `SELECT owner_id AS ownerId, name, visibility, description, default_branch AS defaultBranch,
         pushed_at AS pushedAt, created_at AS createdAt
       FROM repos WHERE repo_id = ?`,
    )
    .bind(exported.sourceId)
    .first<Record<string, unknown>>();
  const row = parseRepoRow(last ?? null) ?? null;
  const tombstone: RepoExport = { ...exported, entities: [{ ...entity, row }] };
  metrics?.count("d1.query", { db: "directory", op: "deletion_tombstone" });
  // Only ever newer (a purge of an older epoch resuming late keeps nothing).
  await env.DIRECTORY.prepare(
    `UPDATE repo_deletions SET tombstone = ?1 WHERE repo_id = ?2
       AND (tombstone IS NULL OR (json_extract(tombstone, '$.epochGen'),
         json_extract(tombstone, '$.entities[0].version')) <= (?3, ?4))`,
  )
    .bind(JSON.stringify(tombstone), exported.sourceId, exported.epochGen, entity.version)
    .run();
}

/** Proposed values. */
export const DELETION_POLICY = {
  /** Time the repository object may spend sending events and archiving, per call. */
  prepareBudgetMs: 5_000,
  /**
   * Deletions one cron run advances: each makes about ten internal calls
   * (D1, Durable Objects) of an invocation's 1,000, and may wait up to
   * `prepareBudgetMs`.
   */
  perCronRun: 10,
  /** Deletions a bulk request advances itself; the cron advances the rest. */
  perBulkRequest: 3,
};

type Deletion = {
  repo_id: string;
  step: DeletionStep;
  requested_by: string | null;
  act_chain: string | null;
  request_id: string | null;
  org_shard: string;
};

/**
 * Starts deleting `repos` (active repositories) in one directory batch.
 * Returns the ids this call marked; one already being deleted is not, nor
 * one a transfer is moving, nor one whose owner is no longer the `ownerId`
 * given (the owner its caller was authorized for).
 */
export async function markDeletions(
  env: Env,
  repos: readonly (Pick<RepoEntry, "id" | "ownerHandle" | "name"> &
    Partial<Pick<RepoEntry, "ownerId">>)[],
  options: {
    /** Who deletes them; null for the instance itself (an expiry). */
    actorId: string | null;
    /** The agents acting for `actorId` (a delegated token's act chain), for the audit rows. */
    act?: readonly string[];
    requestId?: string;
    /**
     * An expiry: only repositories that have expired by this time (Unix
     * ms) are marked, checked in the batch, so one whose expiry was just
     * cleared or extended is kept. Audited as `repo.expire`.
     */
    expiredBy?: number;
    metrics?: Metrics;
  },
): Promise<Set<string>> {
  if (repos.length === 0) return new Set();
  const db = env.DIRECTORY;
  const now = clock();
  const ids = JSON.stringify(repos.map((r) => r.id));
  const owners = JSON.stringify(Object.fromEntries(repos.map((r) => [r.id, r.ownerId ?? null])));
  const inIds = "id IN (SELECT value FROM json_each(?1))";
  // ?6: each repository's owner when it was authorized (null: any).
  const ownedAsAuthorized = "coalesce(json_extract(?6, '$.' || id) = owner_id, 1)";
  // ?5 is the expiry cutoff, or null for any active repository; none a transfer is moving.
  const eligible = `state = 'active' AND (?5 IS NULL OR (expires_at IS NOT NULL AND expires_at <= ?5))
    AND ${NOT_TRANSFERRING} AND ${ownedAsAuthorized}`;
  const expiry = options.expiredBy ?? null;
  options.metrics?.count("d1.query", { db: "directory", op: "repo_delete" }, 6);
  const results = await db.batch<{ id: string }>([
    db
      .prepare(
        `INSERT INTO audit_log (at, actor_id, act_chain, action, target_id, details, request_id)
         SELECT ?2, ?3, ?7, CASE WHEN ?5 IS NULL THEN 'repo.delete' ELSE 'repo.expire' END,
           id, json_object('name', name), ?4 FROM repos
         WHERE ${inIds} AND ${eligible}`,
      )
      .bind(
        ids,
        now,
        options.actorId,
        options.requestId ?? null,
        expiry,
        owners,
        actChain(options.act),
      ),
    db
      .prepare(
        `UPDATE repos SET state = 'deleting', updated_at = ?2
         WHERE ${inIds} AND ${eligible} RETURNING id`,
      )
      .bind(ids, now, null, null, expiry, owners),
    db
      .prepare(
        `INSERT INTO repo_deletions (repo_id, step, attempts, updated_at, requested_by,
           act_chain, request_id)
         SELECT id, 'prepare', 0, ?2, ?3, ?4, ?5 FROM repos
         WHERE ${inIds} AND state = 'deleting'
         ON CONFLICT (repo_id) DO NOTHING`,
      )
      .bind(ids, now, options.actorId, actChain(options.act), options.requestId ?? null),
    db
      .prepare(
        `DELETE FROM repo_redirects WHERE repo_id IN (SELECT value FROM json_each(?1))
         AND EXISTS (SELECT 1 FROM repos WHERE id = repo_redirects.repo_id AND state = 'deleting')`,
      )
      .bind(ids),
    db
      .prepare(
        `DELETE FROM stars WHERE repo_id IN (SELECT value FROM json_each(?1))
         AND EXISTS (SELECT 1 FROM repos WHERE id = stars.repo_id AND state = 'deleting')`,
      )
      .bind(ids),
    db.prepare(`SELECT id FROM repos WHERE ${inIds} AND state <> 'active'`).bind(ids),
  ]);
  const marked = new Set((results[1]?.results ?? []).map((row) => row.id));
  const going = new Set((results[5]?.results ?? []).map((row) => row.id));
  // An expiry leaves what it did not mark alone; a deletion forgets even one already under way
  // (not one a transfer kept).
  for (const repo of repos) {
    if (!(options.expiredBy === undefined ? going : marked).has(repo.id)) continue;
    forgetResolved(repo.ownerHandle, repo.name);
    forgetRepo(repo.id);
  }
  return marked;
}

/**
 * Advances one deletion as far as it can now. Returns `deleted` once done,
 * `deleting` while a step waits or failed (the cron tries again).
 */
export async function advanceDeletion(
  env: Env,
  repoId: string,
  options: { metrics?: Metrics } = {},
): Promise<"deleting" | "deleted"> {
  const { metrics } = options;
  const db = env.DIRECTORY.withSession("first-primary");
  metrics?.count("d1.query", { db: "directory", op: "deletion_read" });
  const deletion = await db
    .prepare(
      `SELECT d.repo_id, d.step, d.requested_by, d.act_chain, d.request_id, r.org_shard FROM repo_deletions d
       JOIN repos r ON r.id = d.repo_id WHERE d.repo_id = ?`,
    )
    .bind(repoId)
    .first<Deletion>();
  if (!deletion) return "deleting";
  const stub = env.REPO.getByName(repoId);
  let step = deletion.step;
  try {
    while (step !== "done") {
      const next = await runStep(env, stub, step, deletion, options);
      if (next === step) {
        // Waiting: to the back of the cron's queue, so it cannot hold it up.
        metrics?.count("d1.query", { db: "directory", op: "deletion_wait" });
        await env.DIRECTORY.prepare("UPDATE repo_deletions SET updated_at = ? WHERE repo_id = ?")
          .bind(clock(), repoId)
          .run();
        break;
      }
      if (!(await saveStep(env, repoId, step, next, metrics))) break;
      step = next;
    }
  } catch (error) {
    createLogger({ op: "repos.delete", repoId }).warn("a deletion step failed", { step, error });
    metrics?.count("d1.query", { db: "directory", op: "deletion_failed" });
    await env.DIRECTORY.prepare(
      `UPDATE repo_deletions SET attempts = attempts + 1, last_error = ?, updated_at = ?
       WHERE repo_id = ?`,
    )
      .bind(error instanceof Error ? error.message : String(error), clock(), repoId)
      .run();
  }
  return step === "done" ? "deleted" : "deleting";
}

async function runStep(
  env: Env,
  stub: DurableObjectStub<import("../do/RepoDO.js").RepoDO>,
  step: Exclude<DeletionStep, "done">,
  deletion: Deletion,
  options: { metrics?: Metrics },
): Promise<DeletionStep> {
  const { metrics } = options;
  switch (step) {
    case "prepare": {
      metrics?.count("do.request", { class: "RepoDO", method: "prepareDeletion" });
      const prepared = await stub.prepareDeletion(
        deletion.requested_by === null
          ? null
          : {
              principal: deletion.requested_by,
              actChain: deletion.act_chain === null ? [] : JSON.parse(deletion.act_chain),
              requestId: deletion.request_id,
            },
        DELETION_POLICY.prepareBudgetMs,
      );
      return prepared.ready ? "purge" : "prepare";
    }
    case "purge": {
      metrics?.count("do.request", { class: "RepoDO", method: "deletionTombstone" });
      const tombstone = await stub.deletionTombstone();
      if (tombstone === "not_frozen")
        throw new Error("the repository was not frozen before its purge");
      if (tombstone) {
        await applyExport(env, deletion.org_shard, tombstone, options);
        // Kept for rebuilds after the erase: the tombstone with the row it ended with.
        await keepTombstone(env, deletion.org_shard, tombstone, metrics);
      }
      return "cleanup";
    }
    case "cleanup": {
      const target = { repoId: deletion.repo_id, shard: deletion.org_shard };
      return (await runCleanups(env, target, options)) ? "erase" : "cleanup";
    }
    case "erase": {
      metrics?.count("do.request", { class: "RepoDO", method: "eraseForDeletion" });
      const outcome = await stub.eraseForDeletion();
      if (outcome === "not_frozen")
        throw new Error("the repository was not frozen before its erase");
      return outcome === "erased" ? "done" : "erase";
    }
  }
}

/** Records the next step, unless another run moved the job meanwhile; `done` also frees the name. */
async function saveStep(
  env: Env,
  repoId: string,
  from: DeletionStep,
  to: DeletionStep,
  metrics?: Metrics,
): Promise<boolean> {
  const db = env.DIRECTORY;
  const now = clock();
  const move = db
    .prepare(
      `UPDATE repo_deletions SET step = ?3, last_error = NULL, updated_at = ?4
       WHERE repo_id = ?1 AND step = ?2`,
    )
    .bind(repoId, from, to, now);
  if (to !== "done") {
    metrics?.count("d1.query", { db: "directory", op: "deletion_step" });
    return ((await move.run()).meta.changes ?? 0) > 0;
  }
  metrics?.count("d1.query", { db: "directory", op: "deletion_step" }, 2);
  const [moved] = await db.batch([
    move,
    db
      .prepare(
        `UPDATE repos SET state = 'deleted', updated_at = ?2 WHERE id = ?1 AND state = 'deleting'
         AND EXISTS (SELECT 1 FROM repo_deletions WHERE repo_id = ?1 AND step = 'done')`,
      )
      .bind(repoId, now),
  ]);
  return (moved?.meta.changes ?? 0) > 0;
}

/** Advances the oldest unfinished deletions (the cron's share). Returns how many finished. */
export async function advanceDeletions(
  env: Env,
  options: { limit?: number; metrics?: Metrics } = {},
): Promise<number> {
  options.metrics?.count("d1.query", { db: "directory", op: "deletion_pending" });
  const { results } = await env.DIRECTORY.prepare(
    "SELECT repo_id FROM repo_deletions WHERE step <> 'done' ORDER BY updated_at LIMIT ?",
  )
    .bind(options.limit ?? DELETION_POLICY.perCronRun)
    .all<{ repo_id: string }>();
  let done = 0;
  for (const { repo_id } of results)
    if ((await advanceDeletion(env, repo_id, options)) === "deleted") done++;
  return done;
}
