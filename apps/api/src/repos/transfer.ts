import { createLogger, type Metrics } from "@fyrden/adapters-cloudflare/obs";
import type { Input, Output, transferRepo } from "@fyrden/api-contract";
import { accountRoleOf, canUseAccount, findAccount } from "../accounts/account.js";
import { recordedAccount } from "../accounts/grants.js";
import { accountLimits } from "../accounts/quotas.js";
import { readModelFor } from "../events/read-model.js";
import { repoFor } from "../git/chunked/operations.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { clock, newId } from "../services.js";
import {
  checkNewRepo,
  defaultBranchOf,
  findReposById,
  forgetResolved,
  type RepoEntry,
} from "./directory.js";
import { readModelDetails } from "./listing.js";
import { repoOutput, starCounts, visibleParents } from "./output.js";

/*
 * Repository transfers, as resumable jobs (a `repo_transfers` row): the
 * repository's object stops taking changes (`freeze`); one directory batch
 * moves its owner and name, keeping the old path as a redirect, and
 * advances the job with it (`directory`); the old account hands its
 * collaborators and storage usage to the new one, its team grants staying
 * behind (`grants`); the read model refuses events of the old owner
 * generation (`fence`); the object takes its new owner (`repo`). A move the
 * new account cannot take is called off (`cancelling`, then `failed`), the
 * object taking changes again.
 *
 * Every object a step changes records the transfer's id and does its part
 * once, so a runner that is late or runs a step again changes nothing; a
 * lease lets one runner advance a transfer at a time, and each step is
 * saved only by the runner holding it. The request advances the job; the
 * cron finishes what it does not.
 */

export type TransferStep =
  | "freeze"
  | "directory"
  | "grants"
  | "fence"
  | "repo"
  | "done"
  | "cancelling"
  | "failed";

type Transfer = {
  repo_id: string;
  transfer_id: string;
  from_owner: string;
  from_name: string;
  to_owner: string;
  to_name: string;
  step: TransferStep;
  requested_by: string | null;
  last_error: string | null;
  org_shard: string;
};

/** Proposed. */
export const TRANSFER_POLICY = {
  /** Transfers one cron run advances. */
  perCronRun: 10,
  /** How long a runner holds a transfer (one that dies frees it after this). */
  leaseMs: 60_000,
};

/** The `repos.transfer` operation. */
export async function transferRepoOperation(
  ctx: OpContext,
  input: Input<typeof transferRepo>,
): Promise<Output<typeof transferRepo>> {
  const { env, auth, metrics } = ctx;
  const entry = await repoFor(ctx, input.owner, input.repo, "administration:write");
  const to = await targetOf(ctx, input.new_owner);
  if (to.id === entry.ownerId)
    throw new OperationError(422, "same_owner", "The repository already belongs to that account.");
  const name = input.new_name ?? entry.name;
  const { maxRepos, maxStorageBytes } = await accountLimits(env, to.id, metrics);
  await checkNewRepo(env, to, name, maxRepos, metrics);
  // Its storage must fit there too (checked before it freezes; pushes after it are refused).
  metrics.count("do.request", { class: "OrgDO", method: "repoForTransfer" }, 2);
  const [usage, status] = await Promise.all([
    env.ORG.getByName(entry.ownerId).repoForTransfer(entry.id),
    env.ORG.getByName(to.id).quotaStatus(),
  ]);
  if (usage.usageBytes > maxStorageBytes - status.usedBytes - status.reservedBytes)
    throw new OperationError(
      403,
      "quota_exceeded",
      `${to.handle}'s storage quota has no room for this repository's ${usage.usageBytes} bytes.`,
    );
  metrics.count("do.request", { class: "OrgDO", method: "canAdopt" });
  if (!(await env.ORG.getByName(to.id).canAdopt(to.id, usage.collaborators)))
    throw failure("too_many_collaborators");
  const now = clock();
  metrics.count("d1.query", { db: "directory", op: "transfer_start" });
  // Only from the owner the caller was authorized for, with no deletion and no other transfer going.
  const started = await env.DIRECTORY.prepare(
    `INSERT INTO repo_transfers (repo_id, transfer_id, from_owner, from_name, to_owner, to_name,
       step, requested_by, created_at, updated_at)
     SELECT id, ?2, owner_id, name, ?3, ?4, 'freeze', ?5, ?6, ?6 FROM repos
     WHERE id = ?1 AND owner_id = ?7 AND state = 'active'
       AND NOT EXISTS (SELECT 1 FROM repo_deletions WHERE repo_id = ?1)
     ON CONFLICT (repo_id) DO UPDATE SET transfer_id = excluded.transfer_id,
       from_owner = excluded.from_owner, from_name = excluded.from_name,
       to_owner = excluded.to_owner, to_name = excluded.to_name, step = 'freeze',
       requested_by = excluded.requested_by, lease_id = NULL, lease_until = NULL,
       attempts = 0, last_error = NULL,
       created_at = excluded.created_at, updated_at = excluded.updated_at
     WHERE repo_transfers.step IN ('done', 'failed')`,
  )
    .bind(entry.id, newId("trf"), to.id, name, auth.principalId, now, entry.ownerId)
    .run();
  if ((started.meta.changes ?? 0) === 0)
    throw new OperationError(
      409,
      "transfer_in_progress",
      "The repository is being transferred or deleted, or changed owner meanwhile.",
    );
  const outcome = await advanceTransfer(env, entry.id, { metrics });
  if (outcome.state === "failed") throw failure(outcome.error);
  // By its id: the name it moved under may name another repository by now.
  const [current] = await findReposById(env, [entry.id], metrics);
  return { state: outcome.state, repo: await outputOf(ctx, current ?? entry) };
}

/** Who will own the repository: the caller, or an organization it may create repositories in. */
async function targetOf(ctx: OpContext, handle: string): Promise<{ id: string; handle: string }> {
  const { env, auth, metrics } = ctx;
  const self = auth.principalHandle ?? "";
  if (handle.toLowerCase() === self.toLowerCase()) return { id: auth.principalId, handle: self };
  const org = await findAccount(env, handle, { metrics });
  const role =
    org?.type === "org" ? await accountRoleOf(env, org, auth.principalId, metrics) : null;
  if (org?.type !== "org" || role === null)
    throw new OperationError(404, "org_not_found", `No organization ${handle} was found.`);
  if (!canUseAccount(auth, role, "repos:create"))
    throw new OperationError(403, "forbidden", `You may not create repositories in ${org.handle}.`);
  return { id: org.id, handle: org.handle };
}

function failure(reason: string | null): OperationError {
  switch (reason) {
    case "name_taken":
      return new OperationError(
        409,
        "name_taken",
        "The new account has a repository of that name.",
      );
    case "quota_exceeded":
      return new OperationError(
        403,
        "quota_exceeded",
        "The new account's repository quota is full.",
      );
    case "too_many_collaborators":
      return new OperationError(
        422,
        "too_many_collaborators",
        "The new account's members and the repository's collaborators would be more than one repository's access list holds.",
      );
    case "generating":
      return new OperationError(
        409,
        "repo_generating",
        "The repository is still being generated from a template; try again shortly.",
      );
    case "not_owner":
      return new OperationError(
        409,
        "transfer_in_progress",
        "The repository changed owner meanwhile.",
      );
    default:
      return new OperationError(404, "repo_not_found", "The repository is gone.");
  }
}

async function outputOf(ctx: OpContext, entry: RepoEntry) {
  const { env, auth, metrics } = ctx;
  const [details, stars, parents] = await Promise.all([
    readModelDetails(env, [entry.id], metrics),
    starCounts(env, [entry.id], metrics),
    visibleParents(env, auth, [entry], metrics),
  ]);
  return repoOutput(entry, {
    defaultBranch: defaultBranchOf(details.get(entry.id)?.default_branch ?? null),
    description: details.get(entry.id)?.description ?? null,
    parentVisible: parents.has(entry.parentId ?? ""),
    stars: stars.get(entry.id) ?? 0,
  });
}

/**
 * Advances one transfer as far as it can now: `transferred` once done,
 * `transferring` while a step waits, failed for now (the cron tries
 * again) or another runner holds it, `failed` when it cannot happen (the
 * repository was let go, with the reason).
 */
export async function advanceTransfer(
  env: Env,
  repoId: string,
  options: { metrics?: Metrics } = {},
): Promise<{ state: "transferred" | "transferring" | "failed"; error: string | null }> {
  const { metrics } = options;
  const lease = crypto.randomUUID();
  const now = clock();
  metrics?.count("d1.query", { db: "directory", op: "transfer_lease" });
  const claimed = await env.DIRECTORY.prepare(
    `UPDATE repo_transfers SET lease_id = ?2, lease_until = ?3
     WHERE repo_id = ?1 AND step NOT IN ('done', 'failed')
       AND (lease_until IS NULL OR lease_until <= ?4)`,
  )
    .bind(repoId, lease, now + TRANSFER_POLICY.leaseMs, now)
    .run();
  metrics?.count("d1.query", { db: "directory", op: "transfer_read" });
  const transfer = await env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT t.repo_id, t.transfer_id, t.from_owner, t.from_name, t.to_owner, t.to_name, t.step,
         t.requested_by, t.last_error, r.org_shard
       FROM repo_transfers t JOIN repos r ON r.id = t.repo_id WHERE t.repo_id = ?`,
    )
    .bind(repoId)
    .first<Transfer>();
  if (!transfer) return { state: "failed", error: "not_found" };
  if (transfer.step === "done") return { state: "transferred", error: null };
  if (transfer.step === "failed") return { state: "failed", error: transfer.last_error };
  // Another runner holds it.
  if ((claimed.meta.changes ?? 0) === 0) return { state: "transferring", error: null };
  let step: TransferStep = transfer.step;
  let error = transfer.last_error;
  try {
    while (step !== "done" && step !== "failed") {
      const next = await runStep(env, transfer, step, lease, metrics);
      // The directory step saved the next one with the move.
      if (next === "moved") {
        step = "grants";
        continue;
      }
      if (typeof next === "object") {
        if (!(await saveStep(env, transfer, lease, step, "cancelling", next.cancelled, metrics)))
          break;
        error = next.cancelled;
        step = "cancelling";
        continue;
      }
      if (!(await saveStep(env, transfer, lease, step, next, error, metrics))) break;
      step = next;
    }
  } catch (caught) {
    createLogger({ op: "repos.transfer", repoId }).warn("a transfer step failed", {
      step,
      error: caught,
    });
    metrics?.count("d1.query", { db: "directory", op: "transfer_failed_step" });
    await env.DIRECTORY.prepare(
      // Calling it off keeps the reason it was called off for.
      `UPDATE repo_transfers SET attempts = attempts + 1, updated_at = ?4,
         last_error = CASE WHEN step = 'cancelling' THEN last_error ELSE ?3 END
       WHERE repo_id = ?1 AND lease_id = ?2`,
    )
      .bind(repoId, lease, caught instanceof Error ? caught.message : String(caught), clock())
      .run();
  }
  // The lease goes with this runner.
  metrics?.count("d1.query", { db: "directory", op: "transfer_unlease" });
  await env.DIRECTORY.prepare(
    "UPDATE repo_transfers SET lease_id = NULL, lease_until = NULL WHERE repo_id = ? AND lease_id = ?",
  )
    .bind(repoId, lease)
    .run();
  if (step === "done") {
    forgetResolved(await handleOf(env, transfer.from_owner), transfer.from_name);
    forgetResolved(await handleOf(env, transfer.to_owner), transfer.to_name);
  }
  return {
    state: step === "done" ? "transferred" : step === "failed" ? "failed" : "transferring",
    error: step === "failed" ? error : null,
  };
}

async function handleOf(env: Env, principalId: string): Promise<string> {
  const row = await env.DIRECTORY.prepare("SELECT handle FROM principals WHERE id = ?")
    .bind(principalId)
    .first<{ handle: string }>();
  return row?.handle ?? "";
}

/**
 * Runs one step: the next step, a reason to call the transfer off, or
 * `moved` when the directory step saved the next step itself.
 */
async function runStep(
  env: Env,
  transfer: Transfer,
  step: Exclude<TransferStep, "done" | "failed">,
  lease: string,
  metrics: Metrics | undefined,
): Promise<TransferStep | "moved" | { cancelled: string }> {
  const stub = env.REPO.getByName(transfer.repo_id);
  const transferId = transfer.transfer_id;
  switch (step) {
    case "freeze": {
      metrics?.count("do.request", { class: "RepoDO", method: "freezeForTransfer" });
      const frozen = await stub.freezeForTransfer({
        transferId,
        from: transfer.from_owner,
        to: transfer.to_owner,
      });
      if (frozen.ok) return "directory";
      if (frozen.code === "other_transfer")
        throw new Error("another transfer holds the repository");
      return { cancelled: frozen.code };
    }
    case "directory":
      return moveInDirectory(env, transfer, lease, metrics);
    case "grants": {
      // The old account hands over and lets go in one step (no grant changed meanwhile is
      // lost); the new one takes what was handed over. Each once per transfer.
      metrics?.count("do.request", { class: "OrgDO", method: "releaseRepo" });
      const handedOver = await env.ORG.getByName(transfer.from_owner).releaseRepo(
        transferId,
        transfer.repo_id,
      );
      const target = await recordedAccount(
        env,
        { id: transfer.to_owner, handle: await handleOf(env, transfer.to_owner) },
        metrics,
      );
      metrics?.count("do.request", { class: "OrgDO", method: "adoptRepo" });
      await target.adoptRepo(transferId, transfer.repo_id, {
        collaborators: handedOver.collaborators,
        usageBytes: handedOver.usageBytes,
      });
      return "fence";
    }
    case "fence": {
      // Before the repository lands: no event of an older owner generation applies after it.
      metrics?.count("do.request", { class: "RepoDO", method: "transferGeneration" });
      const ownerGen = await stub.transferGeneration(transferId);
      metrics?.count("d1.query", { db: "org", op: "source_owner" });
      await readModelFor(env, transfer.org_shard)
        .prepare(
          `INSERT INTO source_owner (source_id, owner_gen) VALUES (?, ?)
           ON CONFLICT (source_id) DO UPDATE SET owner_gen = max(owner_gen, excluded.owner_gen)`,
        )
        .bind(transfer.repo_id, ownerGen)
        .run();
      return "repo";
    }
    case "repo": {
      metrics?.count("d1.query", { db: "directory", op: "transfer_name" });
      const row = await env.DIRECTORY.withSession("first-primary")
        .prepare("SELECT name, name_gen FROM repos WHERE id = ?")
        .bind(transfer.repo_id)
        .first<{ name: string; name_gen: number }>();
      if (!row) throw new Error("the repository's directory row is gone");
      metrics?.count("do.request", { class: "RepoDO", method: "completeTransfer" });
      await stub.completeTransfer(
        { transferId, ownerId: transfer.to_owner, name: row.name, nameGen: row.name_gen },
        transfer.requested_by,
      );
      return "done";
    }
    case "cancelling":
      metrics?.count("do.request", { class: "RepoDO", method: "unfreezeTransfer" });
      await stub.unfreezeTransfer(transferId);
      return "failed";
  }
}

/**
 * Moves the repository in the directory and advances the job in one
 * batch, while this runner holds the job at this step: its owner and name
 * (only while the new account has room and no repository of that name),
 * the audit row, the old path kept as a redirect, a redirect holding the
 * new path gone, and the next step. Held back, it is a reason to call the
 * transfer off.
 */
async function moveInDirectory(
  env: Env,
  transfer: Transfer,
  lease: string,
  metrics: Metrics | undefined,
): Promise<"moved" | { cancelled: string }> {
  const db = env.DIRECTORY;
  // Last chance to call it off: the new account's snapshots must hold its collaborators.
  if (!(await snapshotFits(env, transfer.from_owner, transfer.to_owner, transfer.repo_id, metrics)))
    return { cancelled: "too_many_collaborators" };
  const { maxRepos } = await accountLimits(env, transfer.to_owner, metrics);
  const now = clock();
  // ?1 repo, ?2 new owner, ?3 new name, ?4 old owner, ?5 now, ?6 the new owner's quota,
  // ?7 the transfer, ?8 this runner's lease.
  const holds = `EXISTS (SELECT 1 FROM repo_transfers WHERE repo_id = ?1 AND transfer_id = ?7
      AND step = 'directory' AND lease_id = ?8)`;
  const eligible = `id = ?1 AND owner_id = ?4 AND state = 'active' AND ${holds}
    AND NOT EXISTS (SELECT 1 FROM repos WHERE owner_id = ?2 AND name = ?3 COLLATE NOCASE
      AND state <> 'deleted' AND id <> ?1)
    AND (SELECT count(*) FROM repos WHERE owner_id = ?2 AND state <> 'deleted'
      AND state = 'active') < ?6`;
  const args = [
    transfer.repo_id,
    transfer.to_owner,
    transfer.to_name,
    transfer.from_owner,
    now,
    maxRepos,
    transfer.transfer_id,
    lease,
  ] as const;
  // Later in the batch: this transfer moved it (the job still at this step).
  const moved = `EXISTS (SELECT 1 FROM repos WHERE id = ?1 AND owner_id = ?2) AND ${holds}`;
  metrics?.count("d1.query", { db: "directory", op: "transfer_move" }, 6);
  const [seen, , , , , saved] = await db.batch([
    db
      .prepare(
        `SELECT
           (SELECT state FROM repos WHERE id = ?1) AS state,
           EXISTS (SELECT 1 FROM repos WHERE owner_id = ?2 AND name = ?3 COLLATE NOCASE
             AND state <> 'deleted' AND id <> ?1) AS taken`,
      )
      .bind(transfer.repo_id, transfer.to_owner, transfer.to_name),
    db
      .prepare(
        `INSERT INTO audit_log (at, actor_id, action, target_id, details, request_id)
         SELECT ?5, ?9, 'repo.transfer', id,
           json_object('from', ?4, 'to', ?2, 'from_name', name, 'to_name', ?3), NULL
         FROM repos WHERE ${eligible}`,
      )
      .bind(...args, transfer.requested_by),
    db
      .prepare(
        `UPDATE repos SET owner_id = ?2, name = ?3, name_gen = name_gen + 1, updated_at = ?5
         WHERE ${eligible}`,
      )
      .bind(...args),
    db
      .prepare(
        `INSERT INTO repo_redirects (owner_id, name, repo_id, created_at)
         SELECT ?4, ?9, ?1, ?5 WHERE ${moved}
         ON CONFLICT (owner_id, name) DO UPDATE SET repo_id = excluded.repo_id,
           created_at = excluded.created_at`,
      )
      .bind(...args, transfer.from_name),
    db
      .prepare(
        `DELETE FROM repo_redirects WHERE owner_id = ?2 AND name = ?3 COLLATE NOCASE
         AND ${moved}`,
      )
      .bind(...args),
    db
      .prepare(
        `UPDATE repo_transfers SET step = 'grants', last_error = NULL, updated_at = ?5,
           lease_until = ?5 + ${TRANSFER_POLICY.leaseMs}
         WHERE repo_id = ?1 AND transfer_id = ?7 AND step = 'directory' AND lease_id = ?8
           AND EXISTS (SELECT 1 FROM repos WHERE id = ?1 AND owner_id = ?2)`,
      )
      .bind(...args),
  ]);
  if ((saved?.meta.changes ?? 0) > 0) return "moved";
  const before = seen?.results[0] as { state: string | null; taken: number } | undefined;
  if (before?.state !== "active") return { cancelled: "repo_deleted" };
  return { cancelled: before.taken ? "name_taken" : "quota_exceeded" };
}

/** Whether the new account's snapshot of the repository would hold its collaborators now. */
async function snapshotFits(
  env: Env,
  from: string,
  to: string,
  repoId: string,
  metrics: Metrics | undefined,
): Promise<boolean> {
  metrics?.count("do.request", { class: "OrgDO", method: "repoForTransfer" });
  const { collaborators } = await env.ORG.getByName(from).repoForTransfer(repoId);
  metrics?.count("do.request", { class: "OrgDO", method: "canAdopt" });
  return env.ORG.getByName(to).canAdopt(to, collaborators);
}

/**
 * Records the next step (and extends the lease), only while this runner
 * holds the transfer at the step it ran; calling it off only while the
 * repository is still the old account's in the directory.
 */
async function saveStep(
  env: Env,
  transfer: Transfer,
  lease: string,
  from: TransferStep,
  to: TransferStep,
  error: string | null,
  metrics: Metrics | undefined,
): Promise<boolean> {
  metrics?.count("d1.query", { db: "directory", op: "transfer_step" });
  const unmoved =
    to === "cancelling" ? "AND EXISTS (SELECT 1 FROM repos WHERE id = ?1 AND owner_id = ?7)" : "";
  const now = clock();
  const saved = await env.DIRECTORY.prepare(
    `UPDATE repo_transfers SET step = ?4, last_error = ?5, updated_at = ?6, lease_until = ?9
     WHERE repo_id = ?1 AND transfer_id = ?2 AND step = ?3 AND lease_id = ?8 ${unmoved}`,
  )
    .bind(
      transfer.repo_id,
      transfer.transfer_id,
      from,
      to,
      error,
      now,
      transfer.from_owner,
      lease,
      now + TRANSFER_POLICY.leaseMs,
    )
    .run();
  return (saved.meta.changes ?? 0) > 0;
}

/** Advances the oldest unfinished transfers (the cron's share). Returns how many finished. */
export async function advanceTransfers(
  env: Env,
  options: { limit?: number; metrics?: Metrics } = {},
): Promise<number> {
  options.metrics?.count("d1.query", { db: "directory", op: "transfer_pending" });
  const { results } = await env.DIRECTORY.prepare(
    `SELECT repo_id FROM repo_transfers WHERE step NOT IN ('done', 'failed')
     ORDER BY updated_at LIMIT ?`,
  )
    .bind(options.limit ?? TRANSFER_POLICY.perCronRun)
    .all<{ repo_id: string }>();
  let done = 0;
  for (const { repo_id } of results)
    if ((await advanceTransfer(env, repo_id, options)).state === "transferred") done++;
  return done;
}
