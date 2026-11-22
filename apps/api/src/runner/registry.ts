// Self-hosted runners in the D1 directory: registration tokens, runners and
// their credentials (each stored as its SHA-256 only).

import type { Metrics } from "@fyrden/adapters-cloudflare/obs";

/** A runner as its credentials prove it. */
export interface AuthenticatedRunner {
  readonly id: number;
  readonly uuid: string;
  readonly accountId: string;
  readonly name: string;
  readonly version: string;
  readonly labels: readonly string[];
  readonly ephemeral: boolean;
  /** An ephemeral runner whose task ended: it may only report on that task until its end. */
  readonly spent: boolean;
  /** An ephemeral runner's one task was confirmed. */
  readonly taskConfirmed: boolean;
}

/** A runner as the list operation shows it. */
export interface ListedRunner {
  readonly id: number;
  readonly name: string;
  readonly labels: string[];
  readonly version: string;
  readonly ephemeral: boolean;
  readonly createdAt: number;
  readonly declaredAt: number | null;
  readonly revokedAt: number | null;
}

interface RunnerRow {
  id: number;
  uuid: string;
  account_id: string;
  token_hash: string;
  name: string;
  version: string;
  labels: string;
  ephemeral: number;
  created_at: number;
  declared_at: number | null;
  revoked_at: number | null;
  expires_at: number | null;
}

const count = (metrics: Metrics | undefined, op: string) =>
  metrics?.count("d1.query", { db: "directory", op });

/** Records a registration token (by its hash) that registers one runner for `accountId` until `expiresAt`. */
export async function createRegistration(
  db: D1Database,
  registration: {
    tokenHash: string;
    accountId: string;
    createdBy: string;
    now: number;
    expiresAt: number;
  },
  metrics?: Metrics,
): Promise<void> {
  count(metrics, "runner_registration_create");
  await db
    .prepare(
      `INSERT INTO ci_runner_registrations (token_hash, account_id, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      registration.tokenHash,
      registration.accountId,
      registration.createdBy,
      registration.now,
      registration.expiresAt,
    )
    .run();
}

/**
 * Consumes the registration token whose hash is `registrationHash`, if it is
 * unused and unexpired at `now`, and registers the runner for its account,
 * in one batch: the consumption stamps the registration with `nonce`, and the
 * runner is inserted only from the row bearing it, so a batch that lost a race
 * for the token inserts nothing. Undefined when the token was unknown, spent
 * or expired.
 */
export async function registerRunner(
  db: D1Database,
  runner: {
    registrationHash: string;
    nonce: string;
    now: number;
    uuid: string;
    tokenHash: string;
    name: string;
    version: string;
    labels: readonly string[];
    ephemeral: boolean;
  },
  metrics?: Metrics,
): Promise<{ id: number; accountId: string } | undefined> {
  count(metrics, "runner_register");
  const [, inserted] = await db.batch([
    db
      .prepare(
        `UPDATE ci_runner_registrations SET consumed_at = ?1, consume_nonce = ?2
         WHERE token_hash = ?3 AND consumed_at IS NULL AND expires_at > ?1`,
      )
      .bind(runner.now, runner.nonce, runner.registrationHash),
    db
      .prepare(
        `INSERT INTO ci_runners (uuid, account_id, token_hash, name, version, labels, ephemeral, created_at)
         SELECT ?1, account_id, ?2, ?3, ?4, ?5, ?6, ?7 FROM ci_runner_registrations
         WHERE token_hash = ?8 AND consume_nonce = ?9
         RETURNING id, account_id`,
      )
      .bind(
        runner.uuid,
        runner.tokenHash,
        runner.name,
        runner.version,
        JSON.stringify(runner.labels),
        runner.ephemeral ? 1 : 0,
        runner.now,
        runner.registrationHash,
        runner.nonce,
      ),
  ]);
  const row = inserted?.results[0] as { id: number; account_id: string } | undefined;
  return row && { id: row.id, accountId: row.account_id };
}

/**
 * A live offer of task row `o` at `now` (a SQL parameter): not yet reported
 * on (an ephemeral runner's confirmed task is `ci_runners.task_confirmed_at`),
 * not superseded or ended, and either assigned or within its claim's lease (a
 * claim whose Worker died stops counting when the lease lapses). Its first
 * three terms are `ci_tasks_runner_open`'s condition, so a lookup by runner
 * reads only the runner's open rows, never its history.
 */
function liveOffer(now: string): string {
  return `o.confirmed_at IS NULL AND o.superseded_at IS NULL AND o.ended_at IS NULL
    AND (o.task IS NOT NULL OR o.created_at > ${now} - ${CLAIM_LEASE_MS})`;
}

/**
 * Whether the job of row `x` (a pending job or a task offer, with its
 * `repo_id` and `fork`) may be given to a runner: never a fork job, and
 * only while its repository is active and not public, as this statement
 * reads it. `internal` repositories are served. No runner can opt in yet,
 * and its labels play no part: the head workflow chooses those. The claim
 * and the re-offer are the cutoff; nothing checks again before the answer,
 * so one assignment whose read passed completes, like a task already
 * running when its repository goes public.
 */
function eligible(x: string): string {
  return `${x}.fork = 0 AND EXISTS (SELECT 1 FROM repos e WHERE e.id = ${x}.repo_id
    AND e.visibility <> 'public' AND e.state = 'active')`;
}

/**
 * The runner authentication read, by what the call needs: the runner alone
 * (`?1` uuid), with the task it names (`?2` task id), or FetchTask's view
 * (`?2` now, `?3` the request's version).
 */
export function runnerAuthQuery(kind: "runner" | "task" | "fetch"): string {
  const dispatch =
    kind === "fetch"
      ? `, COALESCE(d.tasks_version, 0) AS tasks_version,
       EXISTS (SELECT 1 FROM ci_pending_jobs p WHERE p.account_id = r.account_id
               AND p.claim_until IS NOT NULL AND p.claim_until < ?2) AS expired_claims,
       (SELECT count(*) FROM ci_tasks o WHERE o.runner_id = r.id AND ${liveOffer("?2")}) AS live_offers,
       CASE WHEN t.id IS NULL THEN 0 WHEN ${eligible("t")} THEN 1 ELSE 0 END AS task_eligible`
      : "";
  const taskJoin =
    kind === "fetch"
      ? `LEFT JOIN ci_dispatch d ON d.account_id = r.account_id
       LEFT JOIN ci_tasks t ON t.id = (SELECT o.id FROM ci_tasks o
         WHERE o.runner_id = r.id AND ${liveOffer("?2")}
           AND o.offered_version = ?3 AND ?3 <> 0 ORDER BY o.id DESC LIMIT 1)`
      : kind === "task"
        ? "LEFT JOIN ci_tasks t ON t.id = ?2"
        : "LEFT JOIN ci_tasks t ON 0";
  return `SELECT r.id, r.uuid, r.account_id, r.token_hash, r.name, r.version, r.labels, r.ephemeral,
              r.revoked_at, r.expires_at, r.task_confirmed_at,
              t.id AS task_id, t.run_id AS task_run_id, t.job_id AS task_job_id, t.task AS task_task,
              t.runner_id AS task_runner_id, t.offered_version AS task_offered_version,
              t.superseded_at AS task_superseded_at${dispatch}
       FROM ci_runners r ${taskJoin}
       WHERE r.uuid = ?1`;
}

/** A task row as the runner protocol routes by it. */
export interface RoutedTask {
  /** The wire task id. */
  readonly id: number;
  readonly runId: string;
  readonly jobId: number;
  readonly runnerId: number;
  readonly offeredVersion: number;
  readonly superseded: boolean;
  /** The run assigned it (its task number is recorded). */
  readonly assigned: boolean;
}

/** What FetchTask reads with the runner. */
export interface DispatchView {
  /** The account's version (0 when nothing was ever published). */
  readonly tasksVersion: number;
  /** Whether a pending job of the account holds a lapsed claim. */
  readonly expiredClaims: boolean;
  /** The runner's live offers: unconfirmed, and assigned or within their claim's lease. */
  readonly liveOffers: number;
  /**
   * The runner's live offer made at the request's version, when it is not
   * 0, and whether its job may still be given to a runner (read with it).
   */
  readonly reoffer: (RoutedTask & { readonly eligible: boolean }) | undefined;
}

export type RunnerAuthentication = {
  readonly runner: AuthenticatedRunner;
  /** The task the call names (`taskId`), or undefined when it has no row. */
  readonly task?: RoutedTask | undefined;
  /** FetchTask's view (`fetch`). */
  readonly dispatch?: DispatchView;
};

/**
 * The runner `uuid` whose credential hashes to `tokenHash`, if it is neither
 * revoked nor past its end at `now`: one read of the primary, so a deletion
 * takes effect on the runner's next call. The same read brings the task a
 * call names (`taskId`) or, for FetchTask (`fetchVersion`, the request's
 * version), the account's dispatch state and the runner's open task.
 */
export async function authenticateRunner(
  db: D1Database,
  credentials: {
    uuid: string;
    tokenHash: string;
    now: number;
    taskId?: number;
    fetchVersion?: number;
  },
  metrics?: Metrics,
): Promise<RunnerAuthentication | undefined> {
  count(metrics, "runner_authenticate");
  const fetching = credentials.fetchVersion !== undefined;
  const named = credentials.taskId !== undefined;
  const binds: (string | number)[] = [credentials.uuid];
  if (fetching) binds.push(credentials.now, credentials.fetchVersion as number);
  else if (named) binds.push(credentials.taskId as number);
  const row = await db
    .withSession("first-primary")
    .prepare(runnerAuthQuery(fetching ? "fetch" : named ? "task" : "runner"))
    .bind(...binds)
    .first<
      RunnerRow & {
        task_confirmed_at: number | null;
        task_id: number | null;
        task_run_id: string | null;
        task_job_id: number | null;
        task_task: number | null;
        task_runner_id: number | null;
        task_offered_version: number | null;
        task_superseded_at: number | null;
        tasks_version?: number;
        expired_claims?: number;
        live_offers?: number;
        task_eligible?: number;
      }
    >();
  if (!row || !sameHash(row.token_hash, credentials.tokenHash)) return undefined;
  if (row.revoked_at !== null) return undefined;
  if (row.expires_at !== null && row.expires_at <= credentials.now) return undefined;
  const task: RoutedTask | undefined =
    row.task_id === null
      ? undefined
      : {
          id: row.task_id,
          runId: row.task_run_id as string,
          jobId: row.task_job_id as number,
          runnerId: row.task_runner_id as number,
          offeredVersion: row.task_offered_version as number,
          superseded: row.task_superseded_at !== null,
          assigned: row.task_task !== null,
        };
  return {
    runner: {
      id: row.id,
      uuid: row.uuid,
      accountId: row.account_id,
      name: row.name,
      version: row.version,
      labels: parseLabels(row.labels),
      ephemeral: row.ephemeral === 1,
      spent: row.expires_at !== null,
      taskConfirmed: row.task_confirmed_at !== null,
    },
    ...(named && { task }),
    ...(fetching && {
      dispatch: {
        tasksVersion: row.tasks_version ?? 0,
        expiredClaims: row.expired_claims === 1,
        liveOffers: row.live_offers ?? 0,
        reoffer: task && { ...task, eligible: row.task_eligible === 1 },
      },
    }),
  };
}

/** Compares two hex hashes in time that does not depend on where they differ. */
function sameHash(stored: string, presented: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(stored);
  const b = encoder.encode(presented);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

/** Records what a runner declared when its daemon started. */
export async function declareRunner(
  db: D1Database,
  declared: { id: number; version: string; labels: readonly string[]; now: number },
  metrics?: Metrics,
): Promise<void> {
  count(metrics, "runner_declare");
  await db
    .prepare("UPDATE ci_runners SET version = ?, labels = ?, declared_at = ? WHERE id = ?")
    .bind(declared.version, JSON.stringify(declared.labels), declared.now, declared.id)
    .run();
}

/** Up to `limit` of an account's runners after the runner `afterId`, oldest first. */
export async function listRunners(
  db: D1Database,
  page: { accountId: string; afterId: number; limit: number },
  metrics?: Metrics,
): Promise<ListedRunner[]> {
  count(metrics, "runners_list");
  const { results } = await db
    .withSession("first-primary")
    .prepare(
      `SELECT id, name, labels, version, ephemeral, created_at, declared_at, revoked_at
       FROM ci_runners WHERE account_id = ? AND id > ? ORDER BY id LIMIT ?`,
    )
    .bind(page.accountId, page.afterId, page.limit)
    .all<Omit<RunnerRow, "uuid" | "account_id" | "token_hash" | "expires_at">>();
  return results.map((row) => ({
    id: row.id,
    name: row.name,
    labels: parseLabels(row.labels),
    version: row.version,
    ephemeral: row.ephemeral === 1,
    createdAt: row.created_at,
    declaredAt: row.declared_at,
    revokedAt: row.revoked_at,
  }));
}

/**
 * Revokes the account's runner `id` at `now` (a runner revoked already keeps
 * its first time). False when the account has no such runner.
 */
export async function revokeRunner(
  db: D1Database,
  revoked: { accountId: string; id: number; now: number },
  metrics?: Metrics,
): Promise<boolean> {
  count(metrics, "runner_revoke");
  const result = await db
    .prepare(
      "UPDATE ci_runners SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND account_id = ?",
    )
    .bind(revoked.now, revoked.id, revoked.accountId)
    .run();
  return result.meta.changes > 0;
}

function parseLabels(json: string): string[] {
  const labels: unknown = JSON.parse(json);
  return Array.isArray(labels) ? labels.filter((l): l is string => typeof l === "string") : [];
}

/** How long a claim on a pending job holds before another poll may take the job. Proposed. */
export const CLAIM_LEASE_MS = 30_000;

/** Every column of `ci_pending_jobs` but its id: a released row written again keeps them. */
export const PENDING_COLUMNS = [
  "account_id",
  "run_id",
  "job_id",
  "attempt",
  "labels",
  "queued_at",
  "claimed_by",
  "claim_until",
  "claim_nonce",
  "repo_id",
  "fork",
] as const;

/**
 * Supersedes the offers of an account's lapsed claims that were never
 * assigned (?1 the account, ?2 now).
 */
export const LAPSED_OFFERS_SQL = `UPDATE ci_tasks SET superseded_at = ?2
         WHERE task IS NULL AND superseded_at IS NULL AND ended_at IS NULL
           AND id IN (SELECT o.id FROM ci_pending_jobs p JOIN ci_tasks o
                        ON o.run_id = p.run_id AND o.job_id = p.job_id AND o.runner_id = p.claimed_by
                      WHERE p.account_id = ?1 AND p.claim_until IS NOT NULL AND p.claim_until < ?2
                        -- The open-task index's predicates, so the join never scans task history.
                        AND o.confirmed_at IS NULL AND o.superseded_at IS NULL AND o.ended_at IS NULL
                        AND o.task IS NULL)`;

/**
 * Releases the account's lapsed claims and, when there were any, bumps its
 * version, so every runner searches again: one batch. Their offers never
 * assigned are superseded first, so none is offered again.
 */
export async function clearLapsedClaims(
  db: D1Database,
  accountId: string,
  now: number,
  metrics?: Metrics,
): Promise<void> {
  count(metrics, "runner_claims_clear");
  await db.batch([
    db.prepare(LAPSED_OFFERS_SQL).bind(accountId, now),
    db
      .prepare(
        `UPDATE ci_pending_jobs SET claimed_by = NULL, claim_until = NULL, claim_nonce = NULL
         WHERE account_id = ? AND claim_until IS NOT NULL AND claim_until < ?`,
      )
      .bind(accountId, now),
    // changes() is the update's, run just before on the same connection.
    db
      .prepare(
        "UPDATE ci_dispatch SET tasks_version = tasks_version + 1 WHERE account_id = ? AND changes() > 0",
      )
      .bind(accountId),
  ]);
}

/** A pending job claimed for a runner, with the task row offered for it. */
export interface Claimed {
  /** The wire task id. */
  readonly taskId: number;
  readonly pendingId: number;
  /** Stamped on the pending row by this claim. */
  readonly nonce: string;
  readonly runId: string;
  readonly jobId: number;
}

/**
 * Claims the account's oldest pending job that may be given to a runner at
 * all (`eligible`, read in this statement) and whose labels are all among the
 * runner's (case-insensitive, ASCII), unclaimed or with a lapsed claim, for
 * `CLAIM_LEASE_MS`, and inserts the task row offered with `version`: one
 * batch, the insert reading only the row stamped with this claim's nonce, so
 * a batch that claimed nothing inserts nothing. Undefined when no job is
 * eligible. The pending row stays until its run withdraws it.
 */
export async function claimPending(
  db: D1Database,
  claim: {
    accountId: string;
    runnerId: number;
    labels: readonly string[];
    /** An ephemeral runner claims only while it holds no task and has confirmed none. */
    ephemeral: boolean;
    version: number;
    now: number;
    /** Assigned jobs this poll cannot re-offer; their existing tokens remain valid. */
    skipJobs?: readonly { runId: string; jobId: number }[];
  },
  metrics?: Metrics,
): Promise<Claimed | undefined> {
  count(metrics, "runner_claim");
  const nonce = crypto.randomUUID();
  const skip = claim.skipJobs && claim.skipJobs.length > 0;
  const [claimed, inserted] = await db.batch([
    db
      .prepare(
        `UPDATE ci_pending_jobs SET claimed_by = ?1, claim_until = ?2, claim_nonce = ?3
         WHERE id = (
           SELECT p.id FROM ci_pending_jobs p
           WHERE p.account_id = ?4 AND (p.claim_until IS NULL OR p.claim_until < ?5)
             ${
               skip
                 ? `AND NOT EXISTS (SELECT 1 FROM json_each(?8) e
               WHERE json_extract(e.value, '$.runId') = p.run_id
                 AND json_extract(e.value, '$.jobId') = p.job_id)`
                 : ""
             }
             -- An ephemeral runner holds one task: decided here, so overlapping polls serialise.
             AND (?7 = 0 OR (
               NOT EXISTS (SELECT 1 FROM ci_tasks o WHERE o.runner_id = ?1 AND ${liveOffer("?5")})
               AND NOT EXISTS (SELECT 1 FROM ci_runners r
                               WHERE r.id = ?1 AND r.task_confirmed_at IS NOT NULL)))
             AND ${eligible("p")}
             AND json_array_length(p.labels) > 0
             AND NOT EXISTS (SELECT 1 FROM json_each(p.labels) l
                             WHERE lower(l.value) NOT IN (SELECT lower(r.value) FROM json_each(?6) r))
           ORDER BY p.id LIMIT 1)
         RETURNING id, run_id, job_id`,
      )
      .bind(
        claim.runnerId,
        claim.now + CLAIM_LEASE_MS,
        nonce,
        claim.accountId,
        claim.now,
        JSON.stringify(claim.labels),
        claim.ephemeral ? 1 : 0,
        ...(skip ? [JSON.stringify(claim.skipJobs)] : []),
      ),
    db
      .prepare(
        `INSERT INTO ci_tasks (run_id, job_id, runner_id, offered_version, created_at, repo_id, fork)
         SELECT run_id, job_id, claimed_by, ?1, ?2, repo_id, fork FROM ci_pending_jobs
         WHERE claim_nonce = ?3
         RETURNING id`,
      )
      .bind(claim.version, claim.now, nonce),
  ]);
  const pending = claimed?.results[0] as { id: number; run_id: string; job_id: number } | undefined;
  const task = inserted?.results[0] as { id: number } | undefined;
  if (!pending || !task) return undefined;
  return {
    taskId: task.id,
    pendingId: pending.id,
    nonce,
    runId: pending.run_id,
    jobId: pending.job_id,
  };
}

/**
 * Records that the run refused task `taskId`: ended when its task had
 * finished, superseded otherwise; for an erased run, its pending row goes too
 * (the run will never withdraw it).
 */
export async function refuseTask(
  db: D1Database,
  refused: { taskId: number; code: string; runId: string; jobId: number; now: number },
  metrics?: Metrics,
): Promise<void> {
  count(metrics, "runner_task_refused");
  const column = refused.code === "task_finished" ? "ended_at" : "superseded_at";
  const statements = [
    db
      .prepare(`UPDATE ci_tasks SET ${column} = COALESCE(${column}, ?) WHERE id = ?`)
      .bind(refused.now, refused.taskId),
  ];
  if (refused.code === "run_not_found")
    statements.push(
      db
        .prepare("DELETE FROM ci_pending_jobs WHERE run_id = ? AND job_id = ?")
        .bind(refused.runId, refused.jobId),
    );
  await db.batch(statements);
}

/**
 * Gives up a claim before its assignment was asked for, unless another poll
 * of the runner had it assigned meanwhile (a re-offer): its still unassigned
 * task row is superseded, so no assignment of it can follow (the run's
 * assignment records the task only on a row not superseded), and the pending
 * row, while it bears this claim, is released and the account's version
 * bumped, so the job is free at once and runners that searched meanwhile
 * search again. One batch. With `notBefore`, the released row is not
 * claimed again before then (`claim_until` without a holder: no claim takes
 * a row before it, and once it passes the row reads as a lapsed claim,
 * whose cleanup bumps the version again so runners search for it), and it
 * is written again under a new id: claims take the oldest id first, so it
 * goes behind every job queued before the release, and jobs held back in
 * turn never keep a later one from its turn.
 */
export async function releaseClaim(
  db: D1Database,
  claim: {
    taskId: number;
    pendingId: number;
    nonce: string;
    now: number;
    accountId: string;
    notBefore?: number;
  },
  metrics?: Metrics,
): Promise<void> {
  count(metrics, "runner_claim_release");
  // ?1 the pending row, ?2 this claim's nonce, ?3 the task row, ?4 when it may be claimed again.
  const held = `id = ?1 AND claim_nonce = ?2
    AND EXISTS (SELECT 1 FROM ci_tasks WHERE id = ?3 AND task IS NULL AND superseded_at IS NOT NULL)`;
  const kept = PENDING_COLUMNS.map((c) =>
    c === "claim_until" ? "?4" : c === "claimed_by" || c === "claim_nonce" ? "NULL" : c,
  );
  await db.batch([
    db
      .prepare(
        "UPDATE ci_tasks SET superseded_at = ? WHERE id = ? AND task IS NULL AND superseded_at IS NULL",
      )
      .bind(claim.now, claim.taskId),
    claim.notBefore === undefined
      ? db
          .prepare(
            `UPDATE ci_pending_jobs SET claimed_by = NULL, claim_until = NULL, claim_nonce = NULL
             WHERE ${held}`,
          )
          .bind(claim.pendingId, claim.nonce, claim.taskId)
      : // The row it replaces (the same run and job) is deleted; every column but the id and the
        // claim is kept.
        db
          .prepare(
            `INSERT OR REPLACE INTO ci_pending_jobs (${PENDING_COLUMNS.join(", ")})
             SELECT ${kept.join(", ")} FROM ci_pending_jobs WHERE ${held}`,
          )
          .bind(claim.pendingId, claim.nonce, claim.taskId, claim.notBefore),
    // changes() is the release's, run just before on the same connection (a replacing insert
    // counts its row once: the row it deletes is not counted).
    db
      .prepare(
        "UPDATE ci_dispatch SET tasks_version = tasks_version + 1 WHERE account_id = ? AND changes() > 0",
      )
      .bind(claim.accountId),
  ]);
}

/**
 * Supersedes offer `taskId` while it was never assigned, so no assignment
 * of it can follow (the run records a task only on an offer not
 * superseded); false when it was assigned or ended meanwhile. Its pending
 * row keeps its claim until the lease lapses.
 */
export async function supersedeOffer(
  db: D1Database,
  offer: { taskId: number; now: number },
  metrics?: Metrics,
): Promise<boolean> {
  count(metrics, "runner_offer_supersede");
  const result = await db
    .prepare(
      "UPDATE ci_tasks SET superseded_at = ? WHERE id = ? AND task IS NULL AND superseded_at IS NULL",
    )
    .bind(offer.now, offer.taskId)
    .run();
  return result.meta.changes > 0;
}

/**
 * The statement that makes every runner of `accountId` search again: an
 * idle runner skips the claim query while its version is the account's.
 * Whatever widens which pending jobs may be claimed without publishing one
 * (a repository made private) runs it in the same batch as that change.
 */
export function bumpTasksVersion(db: D1Database, accountId: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO ci_dispatch (account_id, tasks_version) VALUES (?, 1)
       ON CONFLICT (account_id) DO UPDATE SET tasks_version = tasks_version + 1`,
    )
    .bind(accountId);
}
