// Which jobs a runner may be given, decided by the server alone: from the
// runner's own access and what the directory says of the job's repository,
// never from labels (the head workflow chooses those).

import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { MAX_RUNNER_REPOS } from "@fyrden/domain";

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
 * of every runner's selection (all its old owner's), and out of the old owner
 * `?4`'s registration tokens still good at `?5`, so a
 * repository that comes back is selected by nobody.
 */
export function transferAccessSql(moved: string): readonly [string, string] {
  return [
    `DELETE FROM ci_runner_repos WHERE repo_id = ?1 AND ${moved}`,
    `UPDATE ci_runner_registrations
       SET selected_repos = (SELECT json_group_array(value) FROM json_each(selected_repos)
         WHERE value <> ?1)
     WHERE account_id = ?4 AND consumed_at IS NULL AND repository_access = 'selected'
       AND expires_at > ?5 AND ${moved}
       AND EXISTS (SELECT 1 FROM json_each(selected_repos) WHERE value = ?1)`,
  ];
}

/** A runner's access, but for the repositories it lists. */
export interface RunnerAccess {
  readonly repositoryAccess: "all" | "selected";
  readonly allowsPublic: boolean;
  readonly allowsForks: boolean;
}

/** Who a change is audited as: an organization's owner, by their own token or session. */
export interface RunnerActor {
  readonly principalId: string;
  readonly requestId: string;
}

/** Access as the API and the audit log name its fields. */
export const accessJson = (access: RunnerAccess) => ({
  repository_access: access.repositoryAccess,
  allows_public: access.allowsPublic,
  allows_forks: access.allowsForks,
});

const boolean = (sql: string) => `json(iif(${sql} = 1, 'true', 'false'))`;

/** `json_object` arguments naming row `r`'s access, as `accessJson` does. */
export const accessFields = (r: string): string =>
  `'repository_access', ${r}.repository_access, 'allows_public', ${boolean(`${r}.allows_public`)},
   'allows_forks', ${boolean(`${r}.allows_forks`)}`;

/** Whether account `account` owns every repository of the JSON array `ids` (SQL), each active. */
export const ownsAll = (account: string, ids: string): string =>
  `NOT EXISTS (SELECT 1 FROM json_each(${ids}) v WHERE NOT EXISTS (SELECT 1 FROM repos e
     WHERE e.id = v.value AND e.owner_id = ${account} AND e.state = 'active'))`;

/** How many repositories runner `r` lists that its account owns, each active (SQL). */
export const listedRepos = (r: string): string =>
  `(SELECT count(*) FROM ci_runner_repos s JOIN repos e ON e.id = s.repo_id
     AND e.owner_id = ${r}.account_id AND e.state = 'active' WHERE s.runner_id = ${r}.id)`;

export type AccessRefusal =
  | "runner_not_found"
  | "runner_revoked"
  | "forks_need_ephemeral"
  | "access_not_selected"
  | "unknown_repository"
  | "too_many_repositories";

export interface AccessChange {
  readonly repositoryAccess?: "all" | "selected" | undefined;
  /** Replaces the list. */
  readonly selectedRepos?: readonly string[] | undefined;
  readonly allowsPublic?: boolean | undefined;
  readonly allowsForks?: boolean | undefined;
}

interface Target {
  readonly accountId: string;
  readonly id: number;
  readonly now: number;
  readonly actor: RunnerActor;
}

/** The repositories runner `r` lists, as stored: a JSON array (SQL). */
export const storedRepos = (r: string): string =>
  `(SELECT json_group_array(repo_id) FROM ci_runner_repos WHERE runner_id = ${r}.id)`;

/**
 * First in a batch changing runner `?1` of account `?2`: drops the
 * repositories it lists that the account no longer has active, so deleted
 * ones never add up.
 */
const PRUNE_LISTED = `DELETE FROM ci_runner_repos WHERE runner_id = ?1
  AND EXISTS (SELECT 1 FROM ci_runners WHERE id = ?1 AND account_id = ?2)
  AND NOT EXISTS (SELECT 1 FROM repos e WHERE e.id = ci_runner_repos.repo_id
    AND e.owner_id = ?2 AND e.state = 'active')`;

const AUDIT =
  "INSERT INTO audit_log (at, actor_id, act_chain, action, target_id, details, request_id)";

/** Makes the idle runners of account `?2` search again, in a batch whose change widens what one may take. */
const bumpIf = (condition: string): string =>
  `INSERT INTO ci_dispatch (account_id, tasks_version) SELECT ?2, 1 WHERE ${condition}
   ON CONFLICT (account_id) DO UPDATE SET tasks_version = tasks_version + 1`;

/**
 * Changes a serving runner's access, keeping the fields not given, in one
 * batch with its audit row (before and after) and, when it widens, the
 * account's version bump. Undefined when it changed, or why not.
 */
export async function changeAccess(
  db: D1Database,
  target: Target,
  change: AccessChange,
  metrics?: Metrics,
): Promise<AccessRefusal | undefined> {
  // ?1 the runner, ?2 its account, ?3 now, ?4 the access, ?5 the list (JSON), ?6 public, ?7 forks
  // (each null to keep it), ?8 the actor, ?9 the request.
  const flag = (value: boolean | undefined) => (value === undefined ? null : value ? 1 : 0);
  const args = [
    target.id,
    target.accountId,
    target.now,
    change.repositoryAccess ?? null,
    change.selectedRepos === undefined ? null : JSON.stringify(change.selectedRepos),
    flag(change.allowsPublic),
    flag(change.allowsForks),
    target.actor.principalId,
    target.actor.requestId,
  ];
  const run = (sql: string, count: number) => db.prepare(sql).bind(...args.slice(0, count));
  const access = "COALESCE(?4, r.repository_access)";
  const owns = ownsAll("?2", "?5");
  // Every statement but the last reads the row before its update, so each decides the same.
  const allowed = `r.id = ?1 AND r.account_id = ?2 AND ${serves("r", "?3")}
    AND (COALESCE(?7, r.allows_forks) = 0 OR r.ephemeral = 1)
    AND (?5 IS NULL OR (${access} = 'selected' AND ${owns}))`;
  const listed = storedRepos("r");
  const widens = `((r.repository_access = 'selected' AND ${access} = 'all')
    OR (r.allows_public = 0 AND ?6 = 1) OR (r.allows_forks = 0 AND ?7 = 1)
    OR (r.repository_access = 'selected' AND EXISTS (SELECT 1 FROM json_each(?5) v
      WHERE v.value NOT IN (SELECT repo_id FROM ci_runner_repos WHERE runner_id = r.id))))`;
  metrics?.count("d1.query", { db: "directory", op: "runner_access_update" }, 7);
  const results = await db.batch([
    run(PRUNE_LISTED, 2),
    run(
      `SELECT ${serves("r", "?3")} AS serves, r.ephemeral, r.allows_forks, ?7 AS forks,
         ${access} AS access, ?5 IS NOT NULL AS listing
       FROM ci_runners r WHERE r.id = ?1 AND r.account_id = ?2`,
      7,
    ),
    run(
      `${AUDIT}
       SELECT ?3, ?8, NULL, 'ci.runner.access', CAST(r.id AS TEXT), json_object(
         'account_id', r.account_id,
         'before', json_object(${accessFields("r")}, 'selected_repository_ids', json(${listed})),
         'after', json_object('repository_access', ${access},
           'allows_public', ${boolean("COALESCE(?6, r.allows_public)")},
           'allows_forks', ${boolean("COALESCE(?7, r.allows_forks)")},
           'selected_repository_ids', json(CASE WHEN ${access} = 'all' THEN '[]'
             WHEN ?5 IS NULL THEN ${listed} ELSE ?5 END))), ?9
       FROM ci_runners r WHERE ${allowed}`,
      9,
    ),
    run(bumpIf(`EXISTS (SELECT 1 FROM ci_runners r WHERE ${allowed} AND ${widens})`), 7),
    run(
      `DELETE FROM ci_runner_repos WHERE runner_id = ?1
         AND EXISTS (SELECT 1 FROM ci_runners r WHERE ${allowed}
           AND (${access} = 'all' OR ?5 IS NOT NULL))`,
      7,
    ),
    run(
      `INSERT INTO ci_runner_repos (runner_id, repo_id)
       SELECT ?1, v.value FROM json_each(?5) v
       WHERE EXISTS (SELECT 1 FROM ci_runners r WHERE ${allowed})`,
      7,
    ),
    run(
      `UPDATE ci_runners AS r SET repository_access = ${access},
         allows_public = COALESCE(?6, r.allows_public), allows_forks = COALESCE(?7, r.allows_forks)
       WHERE ${allowed}`,
      7,
    ),
  ]);
  if ((results.at(-1)?.meta.changes ?? 0) > 0) return undefined;
  const row = results[1]?.results[0] as
    | {
        serves: number;
        ephemeral: number;
        allows_forks: number;
        forks: number | null;
        access: string;
        listing: number;
      }
    | undefined;
  if (!row) return "runner_not_found";
  if (row.serves !== 1) return "runner_revoked";
  if ((row.forks ?? row.allows_forks) === 1 && row.ephemeral !== 1) return "forks_need_ephemeral";
  if (row.listing === 1 && row.access !== "selected") return "access_not_selected";
  return "unknown_repository";
}

/**
 * Adds repository `repoId` to a selected serving runner's list, or takes it
 * out of it, with its audit row and, for an addition, the account's version
 * bump: nothing when the list has it so already. Undefined when the list is
 * as asked, or why not.
 */
export async function changeListed(
  db: D1Database,
  target: Target,
  repoId: string,
  change: "add" | "remove",
  metrics?: Metrics,
): Promise<AccessRefusal | undefined> {
  // ?1 the runner, ?2 its account, ?3 now, ?4 the repository, ?5 the actor, ?6 the request.
  const args = [
    target.id,
    target.accountId,
    target.now,
    repoId,
    target.actor.principalId,
    target.actor.requestId,
  ];
  const run = (sql: string, count: number) => db.prepare(sql).bind(...args.slice(0, count));
  const has = "EXISTS (SELECT 1 FROM ci_runner_repos WHERE runner_id = r.id AND repo_id = ?4)";
  const owned = `EXISTS (SELECT 1 FROM repos e WHERE e.id = ?4 AND e.owner_id = ?2 AND e.state = 'active')`;
  const changes = `r.id = ?1 AND r.account_id = ?2 AND r.repository_access = 'selected'
    AND ${serves("r", "?3")} AND ${
      change === "add"
        ? `NOT ${has} AND ${owned} AND ${listedRepos("r")} < ${MAX_RUNNER_REPOS}`
        : has
    }`;
  const after =
    change === "add"
      ? `(SELECT json_group_array(id) FROM (SELECT repo_id AS id FROM ci_runner_repos
           WHERE runner_id = r.id UNION SELECT ?4))`
      : "(SELECT json_group_array(repo_id) FROM ci_runner_repos WHERE runner_id = r.id AND repo_id <> ?4)";
  const audit = `${AUDIT}
    SELECT ?3, ?5, NULL, 'ci.runner.access', CAST(r.id AS TEXT),
      json_object('account_id', r.account_id,
        'before', json_object(${accessFields("r")}, 'selected_repository_ids', json(${storedRepos("r")})),
        'after', json_object(${accessFields("r")}, 'selected_repository_ids', json(${after}))), ?6
    FROM ci_runners r WHERE ${changes}`;
  metrics?.count(
    "d1.query",
    { db: "directory", op: "runner_repo_change" },
    change === "add" ? 5 : 4,
  );
  const [, state] = await db.batch([
    run(PRUNE_LISTED, 2),
    run(
      `SELECT ${serves("r", "?3")} AS serves, r.repository_access AS access, ${has} AS has,
         ${owned} AS owned, ${listedRepos("r")} AS listed
       FROM ci_runners r WHERE r.id = ?1 AND r.account_id = ?2`,
      4,
    ),
    run(audit, 6),
    ...(change === "add"
      ? [
          run(bumpIf(`EXISTS (SELECT 1 FROM ci_runners r WHERE ${changes})`), 4),
          run(
            `INSERT INTO ci_runner_repos (runner_id, repo_id)
             SELECT r.id, ?4 FROM ci_runners r WHERE ${changes}`,
            4,
          ),
        ]
      : [
          run(
            `DELETE FROM ci_runner_repos WHERE runner_id = ?1 AND repo_id = ?4
               AND EXISTS (SELECT 1 FROM ci_runners r WHERE ${changes})`,
            4,
          ),
        ]),
  ]);
  const row = state?.results[0] as
    | { serves: number; access: string; has: number; owned: number; listed: number }
    | undefined;
  if (!row) return "runner_not_found";
  if (row.serves !== 1) return "runner_revoked";
  if (row.access !== "selected") return "access_not_selected";
  if (change === "remove" || row.has === 1) return undefined;
  if (row.owned !== 1) return "unknown_repository";
  return row.listed >= MAX_RUNNER_REPOS ? "too_many_repositories" : undefined;
}
