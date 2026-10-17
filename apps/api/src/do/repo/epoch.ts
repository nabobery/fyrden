import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { readModelFor } from "../../events/read-model.js";
import type { EpochCheck } from "./events.js";

/**
 * The directory's epoch for repository `repoId`, for `RepoEvents.checkEpoch`
 * (`recorded` is the object's own): newer after a restore, when the
 * object may also predate a transfer or a rename, so its owner, name,
 * transfer under way and the read model's owner fence come with it.
 */
export async function readDirectoryEpoch(
  env: Env,
  metrics: Metrics,
  repoId: string,
  recorded: number,
): Promise<EpochCheck> {
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
      `SELECT r.owner_id, r.name, r.name_gen, r.org_shard,
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
      transfer_id: string | null;
      from_owner: string | null;
      to_owner: string | null;
    }>();
  if (!row) return { epochGen };
  metrics.count("d1.query", { db: "org", op: "owner_fence" });
  const fence = await readModelFor(env, row.org_shard)
    .prepare("SELECT owner_gen FROM source_owner WHERE source_id = ?")
    .bind(repoId)
    .first<{ owner_gen: number }>();
  return {
    epochGen,
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
