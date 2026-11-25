// Which jobs a runner may be given, decided by the server alone: from the
// runner's own access and what the directory says of the job's repository,
// never from labels (the head workflow chooses those).

import type { Metrics } from "@fyrden/adapters-cloudflare/obs";

/**
 * Whether runner `r` (an alias of `ci_runners`, or of a row with its access
 * columns) may be given a job of repository `repoId` with fork flag `fork`
 * (both SQL), as this statement reads them: the repository is active, and
 * the runner takes its visibility (`internal` is served like `private`);
 * a fork job (whose head is in another repository, whatever the trust) only
 * by an ephemeral runner that takes them; and a runner limited to selected
 * repositories only for one of those. The claim and the re-offer are the
 * cutoff: one assignment whose read passed completes, like a task already
 * running when its runner's access is narrowed.
 */
export function mayTake(r: string, repoId: string, fork: string): string {
  return `EXISTS (SELECT 1 FROM repos e WHERE e.id = ${repoId} AND e.state = 'active'
      AND (e.visibility <> 'public' OR ${r}.allows_public = 1))
    AND (${fork} = 0 OR (${r}.allows_forks = 1 AND ${r}.ephemeral = 1))
    AND (${r}.repository_access = 'all' OR EXISTS (SELECT 1 FROM ci_runner_repos s
      WHERE s.runner_id = ${r}.id AND s.repo_id = ${repoId}))`;
}

/** Whether runner `r` still serves at `now` (SQL). */
export function serves(r: string, now: string): string {
  return `${r}.revoked_at IS NULL AND (${r}.expires_at IS NULL OR ${r}.expires_at > ${now})`;
}

/** Whether ephemeral runner `r` was assigned its one task (the directory stamps it as it records one). */
export function tookItsTask(r: string): string {
  return `(${r}.ephemeral = 1 AND ${r}.task_assigned_at IS NOT NULL)`;
}

/**
 * Whether some runner may be given a job of repository `repoId` with fork
 * flag `fork` (SQL): a runner as registered by default, whether or not one
 * exists yet, or one of the owner's that serves at `now`, was assigned no
 * task and opted in to public or fork jobs. What a run checks before it
 * reserves a job, so it reserves none that no runner may take.
 */
export function anyRunnerMayTake(repoId: string, fork: string, now: string): string {
  return `(EXISTS (SELECT 1 FROM (SELECT 0 AS id, 0 AS ephemeral, 'all' AS repository_access,
        0 AS allows_public, 0 AS allows_forks) r WHERE ${mayTake("r", repoId, fork)})
    OR EXISTS (SELECT 1 FROM ci_runners r INDEXED BY ci_runners_open
      WHERE r.account_id = (SELECT owner_id FROM repos WHERE id = ${repoId})
        AND r.task_assigned_at IS NULL AND (r.allows_public = 1 OR r.allows_forks = 1)
        AND ${serves("r", now)} AND ${mayTake("r", repoId, fork)}))`;
}

/** Clears the access of the runners `ids` (SQL: a list or a subquery), their selections first. */
export function clearAccess(
  db: D1Database,
  ids: string,
  binds: readonly (string | number)[],
): D1PreparedStatement[] {
  return [
    db.prepare(`DELETE FROM ci_runner_repos WHERE runner_id IN (${ids})`).bind(...binds),
    db
      .prepare(
        `UPDATE ci_runners SET allows_public = 0, allows_forks = 0
         WHERE id IN (${ids}) AND (allows_public = 1 OR allows_forks = 1)`,
      )
      .bind(...binds),
  ];
}

/** Revoked runners whose access maintenance clears at once at most. */
export const STALE_ACCESS_PAGE = 256;

/**
 * Clears the access of up to `limit` runners a poll lease revoked, oldest
 * first: the lease writes no access column, so that it writes no index of
 * them. They are given nothing meanwhile.
 */
export async function clearStaleAccess(
  db: D1Database,
  limit = STALE_ACCESS_PAGE,
  metrics?: Metrics,
): Promise<number> {
  metrics?.count("d1.query", { db: "directory", op: "runner_access_clear" }, 2);
  // Both statements read one page: the second one's update takes its rows out of the index.
  const page = `SELECT id FROM ci_runners INDEXED BY ci_runners_stale_access
    WHERE revoked_at IS NOT NULL AND (allows_public = 1 OR allows_forks = 1) ORDER BY id LIMIT ?1`;
  const [, cleared] = await db.batch(clearAccess(db, page, [limit]));
  return cleared?.meta.changes ?? 0;
}

/**
 * In a transfer's batch, under its guard `moved`: takes repository `?1` out
 * of the selections of the runners of its old owner `?4` that may serve, and
 * out of that account's registration tokens still good at `?5`, so a
 * repository that comes back is selected by nobody.
 */
export function transferAccessSql(moved: string): readonly [string, string] {
  return [
    `DELETE FROM ci_runner_repos WHERE repo_id = ?1 AND ${moved}
       AND runner_id IN (SELECT id FROM ci_runners INDEXED BY ci_runners_live
         WHERE revoked_at IS NULL AND account_id = ?4)`,
    `UPDATE ci_runner_registrations
       SET selected_repos = (SELECT json_group_array(value) FROM json_each(selected_repos)
         WHERE value <> ?1)
     WHERE account_id = ?4 AND consumed_at IS NULL AND repository_access = 'selected'
       AND expires_at > ?5 AND ${moved}
       AND EXISTS (SELECT 1 FROM json_each(selected_repos) WHERE value = ?1)`,
  ];
}
