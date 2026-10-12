import type { RepoGitStorage } from "./repo-git-storage.js";
import { rows } from "./sql.js";

/**
 * The groups the repository's packs are reported in. Every group is written
 * each time, zeros included, so the latest point of a group is its current
 * value.
 *
 * - `live_own`: the packs fetches read and the pack-count cap limits.
 * - `live_borrowed`: live packs shared from the fork network.
 * - `pending`: uploads not committed yet (pending, indexing, indexed).
 * - `superseded`: replaced by maintenance, kept for the retention period.
 * - `garbage`: unreachable objects kept until their time to live ends.
 * - `condemned`: waiting for deletion.
 * - `discarded`: failed or abandoned uploads waiting for the reaper.
 * - `fetch`: stored fetch responses (regenerated or framed packs).
 */
export const REPO_STORAGE_GROUPS = [
  "live_own",
  "live_borrowed",
  "pending",
  "superseded",
  "garbage",
  "condemned",
  "discarded",
  "fetch",
] as const;
export type RepoStorageGroupName = (typeof REPO_STORAGE_GROUPS)[number];

export interface RepoStorageGroup {
  readonly group: RepoStorageGroupName;
  readonly packs: number;
  /** Bytes of the `.pack` files (indexes not included); a pack whose size is not known yet counts 0. */
  readonly bytes: number;
}

/** The repository's packs by group; deleted packs are left out. */
export function repoStorage(git: RepoGitStorage): RepoStorageGroup[] {
  const found = rows<{ grp: string; packs: number; bytes: number }>(
    git.context.storage,
    `SELECT CASE
         WHEN kind = 'fetch' THEN 'fetch'
         WHEN state = 'live' THEN 'live_' || origin
         WHEN state IN ('pending', 'indexing', 'indexed') THEN 'pending'
         ELSE state
       END AS grp,
       count(*) AS packs, coalesce(sum(bytes), 0) AS bytes
     FROM packs WHERE state <> 'deleted'
     GROUP BY grp`,
  );
  const byGroup = new Map(found.map((r) => [r.grp, r]));
  return REPO_STORAGE_GROUPS.map((group) => ({
    group,
    packs: byGroup.get(group)?.packs ?? 0,
    bytes: byGroup.get(group)?.bytes ?? 0,
  }));
}

/**
 * Writes the repository's pack count and storage bytes (`git.repo.packs`,
 * `git.repo.bytes`), one point per group.
 */
export function recordRepoStorage(git: RepoGitStorage, repoId: string): void {
  const { metrics } = git.context;
  for (const { group, packs, bytes } of repoStorage(git)) {
    metrics.count("git.repo.packs", { repo: repoId, group }, packs);
    metrics.count("git.repo.bytes", { repo: repoId, group }, bytes);
  }
}
