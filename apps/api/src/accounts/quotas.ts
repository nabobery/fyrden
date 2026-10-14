import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import type { getOrgQuota, getUserQuota, Input, Output, setQuota } from "@fyrden/api-contract";
import type { QuotaLimits } from "../do/org/quotas.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { findAccount, orgFor } from "./account.js";

/** The quota limits in force for account `accountId` (a user or an organization), from its object. */
export function accountLimits(
  env: Env,
  accountId: string,
  metrics?: Metrics,
): Promise<QuotaLimits> {
  metrics?.count("do.request", { class: "OrgDO", method: "quotaLimits" });
  return env.ORG.getByName(accountId).quotaLimits();
}

/** An account's quota and its use: limits and storage from its object, repositories from the directory. */
async function quotaOutput(
  env: Env,
  account: { readonly id: string; readonly handle: string },
  metrics: Metrics,
): Promise<Output<typeof getUserQuota>> {
  metrics.count("do.request", { class: "OrgDO", method: "quotaStatus" });
  metrics.count("d1.query", { db: "directory", op: "repo_count" });
  const [status, row] = await Promise.all([
    env.ORG.getByName(account.id).quotaStatus(),
    env.DIRECTORY.withSession("first-primary")
      .prepare(
        // `state <> 'deleted'` lets the partial (owner_id, name) index serve it.
        "SELECT count(*) AS n FROM repos WHERE owner_id = ? AND state <> 'deleted' AND state = 'active'",
      )
      .bind(account.id)
      .first<{ n: number }>(),
  ]);
  return {
    account: account.handle,
    max_repos: status.limits.maxRepos,
    repos: row?.n ?? 0,
    max_storage_bytes: status.limits.maxStorageBytes,
    storage_bytes: status.usedBytes,
    reserved_bytes: status.reservedBytes,
  };
}

/** The `quotas.user.get` operation. */
export function getUserQuotaOperation(
  ctx: OpContext,
  _input: Input<typeof getUserQuota>,
): Promise<Output<typeof getUserQuota>> {
  return quotaOutput(
    ctx.env,
    { id: ctx.auth.principalId, handle: ctx.auth.principalHandle ?? "" },
    ctx.metrics,
  );
}

/** The `quotas.org.get` operation: for the organization's members. */
export async function getOrgQuotaOperation(
  ctx: OpContext,
  input: Input<typeof getOrgQuota>,
): Promise<Output<typeof getOrgQuota>> {
  const org = await orgFor(ctx, input.org, "members:read");
  return quotaOutput(ctx.env, org, ctx.metrics);
}

/** The `admin.quotas.set` operation (instance administrators; the executor checked it). */
export async function setQuotaOperation(
  ctx: OpContext,
  input: Input<typeof setQuota>,
): Promise<Output<typeof setQuota>> {
  const { env, metrics } = ctx;
  const account = await findAccount(env, input.account, { metrics });
  if (!account)
    throw new OperationError(404, "account_not_found", `No account ${input.account} was found.`);
  const stub = env.ORG.getByName(account.id);
  metrics.count("do.request", { class: "OrgDO", method: "setQuotaLimits" });
  // Audited in the same transaction, and delivered to the directory now or by the object's alarm.
  await stub.setQuotaLimits(
    {
      ...(input.max_repos !== undefined && { maxRepos: input.max_repos }),
      ...(input.max_storage_bytes !== undefined && { maxStorageBytes: input.max_storage_bytes }),
    },
    {
      accountId: account.id,
      actor: { principalId: ctx.auth.principalId, requestId: ctx.requestId },
    },
  );
  metrics.count("do.request", { class: "OrgDO", method: "deliverAudit" });
  await stub.deliverAudit().catch(() => {});
  return quotaOutput(env, account, metrics);
}
