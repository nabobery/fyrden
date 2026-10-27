import { createLogger, type Metrics } from "@fyrden/adapters-cloudflare/obs";
import { markDeletions } from "../repos/deletion.js";
import { forgetResolved, NOT_TRANSFERRING } from "../repos/directory.js";
import { clock } from "../services.js";

/*
 * A user deletion's job, after its transition (`deletion.ts`). Each run
 * (`runDeletionSlice`, from the job's `DeletionDO` alarm) takes the job's
 * lease with a token of its own, does one bounded slice of its step, and
 * saves where it got to: every checkpoint is conditioned on that token and
 * on the step and cursors it read, so a run that lost its lease (it ran
 * past it, and another took the job) changes nothing more. Every call it
 * makes is safe to make again. Steps:
 *
 * 1. `repositories`: has the existing repository deletion delete the
 *    user's active repositories, those a transfer is moving away waiting
 *    until it lands (no transfer can move one to the user any more).
 * 2. `accounts`: every account recorded before the job began (a
 *    `source_epochs` rowid up to `scan_until`), in rowid order, retires the
 *    set (`OrgDO.retirePrincipals`), 100 principals a call, a page of rows
 *    at a time; an organization the user solely owns blocks the job until
 *    an administrator adds an owner (`PUT /admin/organizations/{org}/owners/
 *    {username}`).
 * 3. `stars`: the set's stars go.
 * 4. `feeds`: each principal's feed is retired.
 * 5. `finalize`: once no repository is the user's but those whose deletion
 *    is done (a deletion reopened by a restore is not, whatever the
 *    repository's state), the set becomes `deleted`.
 */

/** Proposed values. */
export const DELETION_RUN_POLICY = {
  /** How long a run holds the job. */
  leaseMs: 5 * 60_000,
  /** Repositories a run hands to repository deletion. */
  reposPerRun: 50,
  /** Account-object calls a run makes. */
  accountCallsPerRun: 50,
  /** Principals of the set one account-object call retires. */
  principalsPerCall: 100,
  /** Rows one account-object call removes at most. */
  rowsPerCall: 500,
  /** Stars a run deletes. */
  starsPerRun: 500,
  /** Feeds a run retires. */
  feedsPerRun: 25,
  /** When a job waiting on repositories or transfers runs again. */
  waitMs: 5 * 60_000,
  /** When a blocked job runs again. */
  blockedMs: 60 * 60_000,
  /** A failed run's first backoff, doubling to `maxBackoffMs`. */
  backoffMs: 60_000,
  maxBackoffMs: 60 * 60_000,
  /** How long the recovery cron leaves a job it re-armed before re-arming it again. */
  rearmMs: 10 * 60_000,
};

type Step = "repositories" | "accounts" | "stars" | "feeds" | "finalize" | "done";

type Job = {
  user_id: string;
  step: Step;
  requested_by: string | null;
  request_id: string | null;
  scan_until: number;
  account_cursor: number;
  batch_cursor: number;
  feed_cursor: number;
  attempts: number;
  released_handles: string;
};

/** Where a slice leaves the job: its new step and cursors, and when it runs again. */
type Progress = {
  readonly step: Step;
  readonly accountCursor?: number;
  readonly batchCursor?: number;
  readonly feedCursor?: number;
  readonly blocked?: string | null;
  /** Delay before it runs again (0: at once). */
  readonly againInMs: number;
};

/** What a run did: the job's time to run again (null: done, or not this run's to do). */
export type SliceOutcome = { readonly next: number | null };

/** Hooks into a run. For tests. */
export const deletionRunHooks: { beforeCheckpoint?: () => Promise<void> } = {};

/**
 * One run of `userId`'s deletion: takes the lease if the job is due and
 * free, does a slice, saves its progress (only while it still holds the
 * lease and the job is where it read it), releases the lease. A failure
 * backs off. Returns when the job runs next.
 */
export async function runDeletionSlice(
  env: Env,
  userId: string,
  options: { metrics?: Metrics } = {},
): Promise<SliceOutcome> {
  const { metrics } = options;
  const db = env.DIRECTORY.withSession("first-primary");
  const now = clock();
  const lease = crypto.randomUUID();
  metrics?.count("d1.query", { db: "directory", op: "user_deletion_lease" });
  const job = await db
    .prepare(
      `UPDATE user_deletions SET lease_id = ?2, lease_until = ?3, updated_at = ?4
       WHERE user_id = ?1 AND step <> 'done' AND next_attempt_at <= ?4
         AND (lease_until IS NULL OR lease_until <= ?4)
       RETURNING user_id, step, requested_by, request_id, scan_until, account_cursor,
         batch_cursor, feed_cursor, attempts, released_handles`,
    )
    .bind(userId, lease, now + DELETION_RUN_POLICY.leaseMs, now)
    .first<Job>();
  if (!job) return { next: await nextAttemptOf(env, userId) };
  let progress: Progress;
  try {
    progress = await slice(env, job, metrics);
  } catch (error) {
    createLogger({ op: "users.delete", userId }).warn("a deletion run failed", {
      step: job.step,
      error,
    });
    const backoff = Math.min(
      DELETION_RUN_POLICY.backoffMs * 2 ** job.attempts,
      DELETION_RUN_POLICY.maxBackoffMs,
    );
    const at = clock() + backoff;
    await db
      .prepare(
        `UPDATE user_deletions SET attempts = attempts + 1, last_error = ?3, next_attempt_at = ?4,
           lease_id = NULL, lease_until = NULL, updated_at = ?5
         WHERE user_id = ?1 AND lease_id = ?2`,
      )
      .bind(userId, lease, error instanceof Error ? error.message : String(error), at, clock())
      .run();
    return { next: at };
  }
  await deletionRunHooks.beforeCheckpoint?.();
  const at = progress.step === "done" ? null : clock() + progress.againInMs;
  metrics?.count("d1.query", { db: "directory", op: "user_deletion_checkpoint" });
  const saved = await db
    .prepare(
      `UPDATE user_deletions SET step = ?3, account_cursor = ?4, batch_cursor = ?5,
         feed_cursor = ?6, blocked = ?7, next_attempt_at = ?8, attempts = 0, last_error = NULL,
         lease_id = NULL, lease_until = NULL, updated_at = ?9
       WHERE user_id = ?1 AND lease_id = ?2 AND step = ?10 AND account_cursor = ?11
         AND batch_cursor = ?12 AND feed_cursor = ?13`,
    )
    .bind(
      userId,
      lease,
      progress.step,
      progress.accountCursor ?? job.account_cursor,
      progress.batchCursor ?? job.batch_cursor,
      progress.feedCursor ?? job.feed_cursor,
      progress.blocked ?? null,
      at ?? clock(),
      clock(),
      job.step,
      job.account_cursor,
      job.batch_cursor,
      job.feed_cursor,
    )
    .run();
  // Lost: another run holds the job now and decides when it runs.
  if ((saved.meta.changes ?? 0) === 0) return { next: null };
  return { next: at };
}

/** When the job may run next (null: done or gone). */
async function nextAttemptOf(env: Env, userId: string): Promise<number | null> {
  const row = await env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT max(next_attempt_at, coalesce(lease_until, 0)) AS at FROM user_deletions
       WHERE user_id = ? AND step <> 'done'`,
    )
    .bind(userId)
    .first<{ at: number }>();
  return row?.at ?? null;
}

async function slice(env: Env, job: Job, metrics: Metrics | undefined): Promise<Progress> {
  switch (job.step) {
    case "repositories":
      return repositories(env, job, metrics);
    case "accounts":
      return accounts(env, job, metrics);
    case "stars":
      return stars(env, job, metrics);
    case "feeds":
      return feeds(env, job);
    case "finalize":
      return finalize(env, job, metrics);
    case "done":
      return { step: "done", againInMs: 0 };
  }
}

const SET = "(SELECT principal_id FROM user_retirements WHERE user_id = ?1)";

/** The set, in order. */
async function retirementSet(env: Env, userId: string): Promise<string[]> {
  const { results } = await env.DIRECTORY.withSession("first-primary")
    .prepare(
      "SELECT principal_id FROM user_retirements WHERE user_id = ? ORDER BY ord, principal_id",
    )
    .bind(userId)
    .all<{ principal_id: string }>();
  return results.map((r) => r.principal_id);
}

async function repositories(env: Env, job: Job, metrics: Metrics | undefined): Promise<Progress> {
  const db = env.DIRECTORY.withSession("first-primary");
  // The active ones no transfer is moving (those wait for it to land, never holding up others).
  metrics?.count("d1.query", { db: "directory", op: "user_deletion_owned" });
  const { results: markable } = await db
    .prepare(
      `SELECT id, name FROM repos WHERE owner_id = ?1 AND state = 'active' AND ${NOT_TRANSFERRING}
       ORDER BY id LIMIT ?2`,
    )
    .bind(job.user_id, DELETION_RUN_POLICY.reposPerRun)
    .all<{ id: string; name: string }>();
  const handle =
    (JSON.parse(job.released_handles) as { id: string; handle: string }[]).find(
      (h) => h.id === job.user_id,
    )?.handle ?? job.user_id;
  if (markable.length > 0)
    await markDeletions(
      env,
      markable.map((r) => ({ id: r.id, ownerHandle: handle, name: r.name, ownerId: job.user_id })),
      {
        actorId: job.requested_by,
        ...(job.request_id !== null && { requestId: job.request_id }),
        ...(metrics && { metrics }),
      },
    );
  for (const r of markable) forgetResolved(handle, r.name);
  // More to hand over: again at once.
  if (markable.length > 0) return { step: "repositories", againInMs: 0 };
  // Only ones a transfer is moving left: again once they may have landed.
  const moving = await db
    .prepare("SELECT 1 AS one FROM repos WHERE owner_id = ? AND state = 'active' LIMIT 1")
    .bind(job.user_id)
    .first();
  if (moving) return { step: "repositories", againInMs: DELETION_RUN_POLICY.waitMs };
  return { step: "accounts", againInMs: 0 };
}

async function accounts(env: Env, job: Job, metrics: Metrics | undefined): Promise<Progress> {
  const db = env.DIRECTORY.withSession("first-primary");
  const set = await retirementSet(env, job.user_id);
  const batches = Math.ceil(set.length / DELETION_RUN_POLICY.principalsPerCall);
  let accountCursor = job.account_cursor;
  let batchCursor = job.batch_cursor;
  // The accounts in two reads a run: the one it starts on, then, once that is done, as many
  // as its calls left could reach (each takes at least one). A round trip to the primary an
  // account would be most of the run's time; a run that stays on its first (blocked, or more
  // of the set there) reads no further.
  const budget = DELETION_RUN_POLICY.accountCallsPerRun;
  const after = async (limit: number) => {
    metrics?.count("d1.query", { db: "directory", op: "user_deletion_account" });
    const { results } = await db
      .prepare(
        `SELECT e.rowid AS seq, e.source_id AS id, p.type FROM source_epochs e
           LEFT JOIN principals p ON p.id = e.source_id
         WHERE e.rowid > ?1 AND e.rowid <= ?2
           AND (e.source_id LIKE 'usr\\_%' ESCAPE '\\' OR e.source_id LIKE 'org\\_%' ESCAPE '\\')
         ORDER BY e.rowid LIMIT ?3`,
      )
      .bind(accountCursor, job.scan_until, limit)
      .all<{ seq: number; id: string; type: string | null }>();
    return results;
  };
  let calls = 0;
  let page = await after(1);
  let at = 0;
  let rest = false;
  while (calls < budget) {
    if (!rest && at === page.length && at > 0) {
      page = await after(budget - calls);
      at = 0;
      rest = true;
    }
    const next = page[at];
    // Only a page shorter than the calls left can run out first: there are no more.
    if (!next) return { step: "stars", accountCursor, batchCursor: 0, againInMs: 0 };
    const ids = set.slice(
      batchCursor * DELETION_RUN_POLICY.principalsPerCall,
      (batchCursor + 1) * DELETION_RUN_POLICY.principalsPerCall,
    );
    calls++;
    metrics?.count("do.request", { class: "OrgDO", method: "retirePrincipals" });
    const answer = await env.ORG.getByName(next.id).retirePrincipals({
      ids,
      jobId: job.user_id,
      actor: {
        principalId: job.requested_by ?? job.user_id,
        ...(job.request_id !== null && { requestId: job.request_id }),
      },
      // An organization whose directory rows never landed has no one to keep.
      ownerCheck: next.type === "org",
      budget: DELETION_RUN_POLICY.rowsPerCall,
    });
    if (answer.state === "sole_owner")
      return {
        step: "accounts",
        accountCursor,
        batchCursor,
        blocked: `sole_owner:${next.id}`,
        againInMs: DELETION_RUN_POLICY.blockedMs,
      };
    // The account's repositories are not told the new access version: the retired can no
    // longer authenticate, and snapshots refresh within their window anyway.
    if (answer.state === "more") continue;
    if (batchCursor + 1 < batches) batchCursor++;
    else {
      accountCursor = next.seq;
      batchCursor = 0;
      at++;
    }
  }
  return { step: "accounts", accountCursor, batchCursor, againInMs: 0 };
}

async function stars(env: Env, job: Job, metrics: Metrics | undefined): Promise<Progress> {
  metrics?.count("d1.query", { db: "directory", op: "user_deletion_stars" });
  // And the set's watch levels and thread preferences (repositories clear their own rows of
  // deleted principals when they next count those of a cap), and its email addresses: a
  // verified claim given up makes its mailbox's outstanding proofs stale, a mailbox no one
  // else names goes idle (reaped later), then the confirmations and addresses go.
  const now = Date.now();
  const [starred, watched, threads, , , confirmations, unsubscribes, addresses] =
    await env.DIRECTORY.batch([
      env.DIRECTORY.prepare(
        `DELETE FROM stars WHERE rowid IN (SELECT rowid FROM stars WHERE user_id IN ${SET} LIMIT ?2)`,
      ).bind(job.user_id, DELETION_RUN_POLICY.starsPerRun),
      env.DIRECTORY.prepare(
        `DELETE FROM watch_preferences WHERE (principal_id, repo_id) IN
         (SELECT principal_id, repo_id FROM watch_preferences WHERE principal_id IN ${SET} LIMIT ?2)`,
      ).bind(job.user_id, DELETION_RUN_POLICY.starsPerRun),
      env.DIRECTORY.prepare(
        `DELETE FROM thread_preferences WHERE (principal_id, repo_id, conversation) IN
         (SELECT principal_id, repo_id, conversation FROM thread_preferences
          WHERE principal_id IN ${SET} LIMIT ?2)`,
      ).bind(job.user_id, DELETION_RUN_POLICY.starsPerRun),
      env.DIRECTORY.prepare(
        `UPDATE email_mailboxes SET claim = lower(hex(randomblob(16)))
       WHERE address_key IN (SELECT address_key FROM user_emails WHERE principal_id IN ${SET}
         AND removed_at IS NULL AND verified_at IS NOT NULL)`,
      ).bind(job.user_id),
      env.DIRECTORY.prepare(
        `UPDATE email_mailboxes SET idle_since = ?2
       WHERE idle_since IS NULL AND address_key IN (SELECT address_key FROM user_emails
           WHERE principal_id IN ${SET} AND removed_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM user_emails o WHERE o.address_key = email_mailboxes.address_key
           AND o.removed_at IS NULL AND o.principal_id NOT IN ${SET})`,
      ).bind(job.user_id, now),
      env.DIRECTORY.prepare(
        `DELETE FROM email_confirmations WHERE token_hash IN (SELECT c.token_hash
         FROM email_confirmations c JOIN user_emails e ON e.id = c.email_id
         WHERE e.principal_id IN ${SET} LIMIT ?2)`,
      ).bind(job.user_id, DELETION_RUN_POLICY.starsPerRun),
      env.DIRECTORY.prepare(
        `DELETE FROM email_unsubscribes WHERE (email_id, scope) IN (SELECT u.email_id, u.scope
         FROM email_unsubscribes u JOIN user_emails e ON e.id = u.email_id
         WHERE e.principal_id IN ${SET} LIMIT ?2)`,
      ).bind(job.user_id, DELETION_RUN_POLICY.starsPerRun),
      // An address after its confirmations and unsubscribes (found through it), so none is left.
      env.DIRECTORY.prepare(
        `DELETE FROM user_emails WHERE id IN (SELECT id FROM user_emails e
         WHERE principal_id IN ${SET}
           AND NOT EXISTS (SELECT 1 FROM email_confirmations c WHERE c.email_id = e.id)
           AND NOT EXISTS (SELECT 1 FROM email_unsubscribes u WHERE u.email_id = e.id)
         LIMIT ?2)`,
      ).bind(job.user_id, DELETION_RUN_POLICY.starsPerRun),
      env.DIRECTORY.prepare(`DELETE FROM email_preferences WHERE principal_id IN ${SET}`).bind(
        job.user_id,
      ),
    ]);
  const left = [starred, watched, threads, confirmations, unsubscribes, addresses].some(
    (r) => (r?.meta.changes ?? 0) >= DELETION_RUN_POLICY.starsPerRun,
  );
  return left ? { step: "stars", againInMs: 0 } : { step: "feeds", againInMs: 0 };
}

async function feeds(env: Env, job: Job): Promise<Progress> {
  const set = await retirementSet(env, job.user_id);
  const end = Math.min(job.feed_cursor + DELETION_RUN_POLICY.feedsPerRun, set.length);
  for (const id of set.slice(job.feed_cursor, end)) await env.USER.getByName(id).retire();
  return end >= set.length
    ? { step: "finalize", feedCursor: end, againInMs: 0 }
    : { step: "feeds", feedCursor: end, againInMs: 0 };
}

async function finalize(env: Env, job: Job, metrics: Metrics | undefined): Promise<Progress> {
  const db = env.DIRECTORY;
  const now = clock();
  // A transfer that had moved one to the user landed since: back to hand it over to deletion.
  metrics?.count("d1.query", { db: "directory", op: "user_deletion_owned" });
  const owned = await db
    .prepare("SELECT 1 AS one FROM repos WHERE owner_id = ? AND state = 'active' LIMIT 1")
    .bind(job.user_id)
    .first();
  if (owned) return { step: "repositories", againInMs: 0 };
  // Waiting for: a repository still the user's whose deletion is not done (a reopened deletion
  // is back at `prepare`, whatever the repository's state; one moved away is someone else's).
  const waiting = `EXISTS (SELECT 1 FROM repos r WHERE r.owner_id = ?1
      AND NOT EXISTS (SELECT 1 FROM repo_deletions d WHERE d.repo_id = r.id AND d.step = 'done'))`;
  metrics?.count("d1.query", { db: "directory", op: "user_deletion_finalize" }, 3);
  const [finished] = await db.batch([
    db
      .prepare(
        `UPDATE principals SET lifecycle = 'deleted', lifecycle_gen = lifecycle_gen + 1,
           is_instance_admin = 0
         WHERE id IN ${SET} AND lifecycle = 'deleting' AND NOT ${waiting}`,
      )
      .bind(job.user_id),
    db
      .prepare(
        `INSERT INTO principal_lifecycle (principal_id, gen, from_state, to_state, at, actor_id,
           request_id)
         SELECT id, lifecycle_gen, 'deleting', 'deleted', ?2, ?3, ?4 FROM principals
         WHERE id = ?1 AND lifecycle = 'deleted'
           AND NOT EXISTS (SELECT 1 FROM principal_lifecycle l WHERE l.principal_id = ?1
             AND l.to_state = 'deleted')`,
      )
      .bind(job.user_id, now, job.requested_by, job.request_id),
    db
      .prepare(
        `INSERT INTO audit_log (at, actor_id, action, target_id, details, request_id)
         SELECT ?2, ?3, 'user.deleted', ?1, NULL, ?4 FROM principals
         WHERE id = ?1 AND lifecycle = 'deleted'
           AND NOT EXISTS (SELECT 1 FROM audit_log WHERE target_id = ?1 AND action = 'user.deleted')`,
      )
      .bind(job.user_id, now, job.requested_by, job.request_id),
  ]);
  if ((finished?.meta.changes ?? 0) > 0) return { step: "done", againInMs: 0 };
  const user = await db
    .prepare("SELECT lifecycle FROM principals WHERE id = ?")
    .bind(job.user_id)
    .first<{ lifecycle: string }>();
  if (user?.lifecycle === "deleted") return { step: "done", againInMs: 0 };
  return { step: "finalize", againInMs: DELETION_RUN_POLICY.waitMs };
}

/**
 * Deletions blocked on `orgId` (it had no owner but the user) run again at
 * once, after an administrator gave it another owner, rather than at their
 * next hourly try. A run that read the organization before the handoff may
 * still save its block after this; it then waits for that try.
 */
export async function wakeDeletionsBlockedOn(
  env: Env,
  orgId: string,
  options: { metrics?: Metrics } = {},
): Promise<void> {
  const now = clock();
  options.metrics?.count("d1.query", { db: "directory", op: "user_deletion_wake" });
  const { results } = await env.DIRECTORY.prepare(
    `UPDATE user_deletions SET next_attempt_at = ?2
     WHERE step <> 'done' AND blocked = ?1 AND next_attempt_at > ?2
     RETURNING user_id`,
  )
    .bind(`sole_owner:${orgId}`, now)
    .all<{ user_id: string }>();
  // A lost one is set by the recovery cron: the job is due now.
  await Promise.all(
    results.map(({ user_id }) => {
      options.metrics?.count("do.request", { class: "DeletionDO", method: "arm" });
      return env.DELETION.getByName(user_id)
        .arm(now)
        .catch((error: unknown) =>
          createLogger({ op: "users.delete", userId: user_id }).warn("arming the deletion failed", {
            error,
          }),
        );
    }),
  );
}

/**
 * The recovery cron's share: re-arms the alarm of the job longest due
 * whose run is not under way, the job's turn moved back first (so a job
 * whose alarm cannot be set, or that keeps failing, goes behind the
 * others). One claim and one call a run.
 */
export async function rearmDeletions(
  env: Env,
  options: { metrics?: Metrics } = {},
): Promise<string | null> {
  const now = clock();
  options.metrics?.count("d1.query", { db: "directory", op: "user_deletion_rearm" });
  const claimed = await env.DIRECTORY.prepare(
    `UPDATE user_deletions SET rearm_after = ?2
     WHERE user_id = (SELECT user_id FROM user_deletions
       WHERE step <> 'done' AND rearm_after <= ?1 AND next_attempt_at <= ?1
         AND (lease_until IS NULL OR lease_until <= ?1)
       ORDER BY rearm_after, user_id LIMIT 1)
     RETURNING user_id`,
  )
    .bind(now, now + DELETION_RUN_POLICY.rearmMs)
    .first<{ user_id: string }>();
  if (!claimed) return null;
  options.metrics?.count("do.request", { class: "DeletionDO", method: "arm" });
  await env.DELETION.getByName(claimed.user_id).arm(now);
  return claimed.user_id;
}
