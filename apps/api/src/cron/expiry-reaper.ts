import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { markDeletions } from "../repos/deletion.js";

/** Proposed. */
export const EXPIRY_POLICY = {
  /**
   * Expired repositories one cron run marks for deletion; the deletions
   * themselves advance like any other (`advanceDeletions`).
   */
  perCronRun: 50,
};

/**
 * Starts deleting active repositories whose expiry has passed, oldest
 * expiry first. Returns how many it marked. Marking twice is harmless: a
 * repository already being deleted is not marked again. One a transfer is
 * moving waits for it (and is not chosen, so it holds up no other).
 */
export async function reapExpiredRepos(
  env: Env,
  options: { now: number; limit?: number; metrics?: Metrics },
): Promise<number> {
  options.metrics?.count("d1.query", { db: "directory", op: "repos_expired" });
  const { results } = await env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT r.id, p.handle AS ownerHandle, r.name FROM repos r
       JOIN principals p ON p.id = r.owner_id
       WHERE r.expires_at IS NOT NULL AND r.expires_at <= ? AND r.state = 'active'
         AND NOT EXISTS (SELECT 1 FROM repo_transfers t
           WHERE t.repo_id = r.id AND t.step NOT IN ('done', 'failed'))
       ORDER BY r.expires_at LIMIT ?`,
    )
    .bind(options.now, options.limit ?? EXPIRY_POLICY.perCronRun)
    .all<{ id: string; ownerHandle: string; name: string }>();
  const marked = await markDeletions(env, results, {
    actorId: null,
    // Checked again as they are marked: an expiry cleared since the query keeps its repository.
    expiredBy: options.now,
    ...(options.metrics && { metrics: options.metrics }),
  });
  return marked.size;
}
