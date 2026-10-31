import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { readModelFor } from "../../events/read-model.js";
import type { EpochCheck } from "./events.js";

/** Hooks into the epoch read. For tests. */
export const epochHooks: { beforeRead?: () => Promise<void> } = {};

/**
 * The directory's epoch for repository `repoId`, for `RepoEvents.checkEpoch`
 * (`recorded` is the object's own): newer after a restore, when the
 * object may also predate a transfer or a rename, so its owner, name,
 * transfer under way and the read model's owner fence come with it, or its
 * deletion: a repository the directory has deleted or is deleting has its
 * deletion reopened from the start here, before the object takes the epoch
 * (so a failure leaves it to the next call), once a restore.
 */
export async function readDirectoryEpoch(
  env: Env,
  metrics: Metrics,
  repoId: string,
  recorded: number,
  /** Now (Unix ms), for a reopened deletion's record. */
  now: number,
): Promise<EpochCheck> {
  await epochHooks.beforeRead?.();
  const primary = env.DIRECTORY.withSession("first-primary");
  metrics.count("d1.query", { db: "directory", op: "epoch_read" });
  const epoch = await primary
    .prepare("SELECT epoch_gen FROM source_epochs WHERE source_id = ?")
    .bind(repoId)
    .first<{ epoch_gen: number }>();
  const epochGen = epoch?.epoch_gen ?? null;
  if (epochGen === null || epochGen <= recorded) return { epochGen };
  // Restored: the object may predate a transfer or a rename. What the directory and the
  // read model's fence say now.
  metrics.count("d1.query", { db: "directory", op: "epoch_owner" });
  const row = await primary
    .prepare(
      `SELECT r.owner_id, r.name, r.name_gen, r.org_shard, r.state,
         t.transfer_id, t.from_owner, t.to_owner
       FROM repos r LEFT JOIN repo_transfers t
         ON t.repo_id = r.id AND t.step NOT IN ('done', 'failed')
       WHERE r.id = ?`,
    )
    .bind(repoId)
    .first<{
      owner_id: string;
      name: string;
      name_gen: number;
      org_shard: string;
      state: string;
      transfer_id: string | null;
      from_owner: string | null;
      to_owner: string | null;
    }>();
  if (!row) return { epochGen };
  const deleted = row.state !== "active";
  if (deleted) {
    metrics.count("d1.query", { db: "directory", op: "deletion_reopen" });
    await primary
      .prepare(
        `UPDATE repo_deletions SET step = 'prepare', gen = gen + 1, reopened_epoch = ?2,
           attempts = 0, last_error = NULL, updated_at = ?3
         WHERE repo_id = ?1 AND (reopened_epoch IS NULL OR reopened_epoch < ?2)`,
      )
      .bind(repoId, epochGen, now)
      .run();
  }
  metrics.count("d1.query", { db: "org", op: "owner_fence" });
  const fence = await readModelFor(env, row.org_shard)
    .prepare("SELECT owner_gen FROM source_owner WHERE source_id = ?")
    .bind(repoId)
    .first<{ owner_gen: number }>();
  return {
    epochGen,
    deleted,
    owner: {
      ownerId: row.owner_id,
      name: row.name,
      nameGen: row.name_gen,
      ownerFence: fence?.owner_gen ?? 0,
      transfer:
        row.transfer_id && row.from_owner && row.to_owner
          ? { id: row.transfer_id, from: row.from_owner, to: row.to_owner }
          : null,
    },
  };
}
