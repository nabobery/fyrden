import { createLogger, type Metrics } from "@fyrden/adapters-cloudflare/obs";
import { applyExport } from "../events/rebuild.js";
import { clock } from "../services.js";
import { forgetRepo, forgetResolved, type RepoEntry } from "./directory.js";

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
 *    that is not active).
 * 4. `erase`: the object erases its R2 bytes and leaves its fork networks
 *    (forks keep the packs they claim), then deletes its storage.
 * 5. `done`: the repository becomes `deleted`, which frees its name. Its
 *    id is never reused.
 *
 * The request that deletes advances the job as far as it can; the cron
 * advances the rest, oldest first.
 */

export type DeletionStep = "prepare" | "purge" | "erase" | "done";

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

type Deletion = { step: DeletionStep; requested_by: string | null; org_shard: string };

/**
 * Starts deleting `repos` (active repositories) in one directory batch.
 * Returns the ids this call marked; one already being deleted is not.
 */
export async function markDeletions(
  env: Env,
  repos: readonly Pick<RepoEntry, "id" | "ownerHandle" | "name">[],
  options: { actorId: string; requestId?: string; metrics?: Metrics },
): Promise<Set<string>> {
  if (repos.length === 0) return new Set();
  const db = env.DIRECTORY;
  const now = clock();
  const ids = JSON.stringify(repos.map((r) => r.id));
  const inIds = "id IN (SELECT value FROM json_each(?1))";
  options.metrics?.count("d1.query", { db: "directory", op: "repo_delete" }, 5);
  const results = await db.batch<{ id: string }>([
    db
      .prepare(
        `INSERT INTO audit_log (at, actor_id, action, target_id, details, request_id)
         SELECT ?2, ?3, 'repo.delete', id, json_object('name', name), ?4 FROM repos
         WHERE ${inIds} AND state = 'active'`,
      )
      .bind(ids, now, options.actorId, options.requestId ?? null),
    db
      .prepare(
        `UPDATE repos SET state = 'deleting', updated_at = ?2
         WHERE ${inIds} AND state = 'active' RETURNING id`,
      )
      .bind(ids, now),
    db
      .prepare(
        `INSERT INTO repo_deletions (repo_id, step, attempts, updated_at, requested_by)
         SELECT id, 'prepare', 0, ?2, ?3 FROM repos WHERE ${inIds} AND state = 'deleting'
         ON CONFLICT (repo_id) DO NOTHING`,
      )
      .bind(ids, now, options.actorId),
    db
      .prepare("DELETE FROM repo_redirects WHERE repo_id IN (SELECT value FROM json_each(?1))")
      .bind(ids),
    db
      .prepare(
        `DELETE FROM stars WHERE repo_id IN (SELECT value FROM json_each(?1))
         AND EXISTS (SELECT 1 FROM repos WHERE id = stars.repo_id AND state = 'deleting')`,
      )
      .bind(ids),
  ]);
  for (const repo of repos) {
    forgetResolved(repo.ownerHandle, repo.name);
    forgetRepo(repo.id);
  }
  return new Set((results[1]?.results ?? []).map((row) => row.id));
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
      `SELECT d.step, d.requested_by, r.org_shard FROM repo_deletions d
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
        deletion.requested_by,
        DELETION_POLICY.prepareBudgetMs,
      );
      return prepared.ready ? "purge" : "prepare";
    }
    case "purge": {
      metrics?.count("do.request", { class: "RepoDO", method: "exportSnapshot" });
      const exported = await stub.exportSnapshot();
      if (exported) {
        if (!exported.entities.every((entity) => entity.deleted))
          throw new Error("the repository was not frozen before its purge");
        await applyExport(env, deletion.org_shard, exported, options);
      }
      return "erase";
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
