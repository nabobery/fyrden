import type { createOrgRepo, Input, listOrgRepos, Output } from "@fyrden/api-contract";
import { orgRepoRole } from "@fyrden/domain";
import { BASE_ROLE } from "../do/OrgDO.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { checkedExpiry, createRepository } from "../repos/create.js";
import { listAccountRepos } from "../repos/listing.js";
import { accountRoleOf, findAccount, orgFor } from "./account.js";

/** The `orgs.repos.create` operation: a member creates a repository the organization owns. */
export async function createOrgRepoOperation(
  ctx: OpContext,
  input: Input<typeof createOrgRepo>,
): Promise<Output<typeof createOrgRepo>> {
  const org = await orgFor(ctx, input.org, "repos:create");
  return createRepository(ctx.env, org, input.name, {
    actorId: ctx.auth.principalId,
    requestId: ctx.requestId,
    metrics: ctx.metrics,
    expiresAt: checkedExpiry(input.expires_at),
  });
}

/**
 * The `orgs.repos.list` operation: every repository of the organization,
 * for its members (owners administer them, members get the base role).
 */
export async function listOrgReposOperation(
  ctx: OpContext,
  input: Input<typeof listOrgRepos>,
): Promise<Output<typeof listOrgRepos>> {
  const { env, auth, metrics } = ctx;
  const org = await findAccount(env, input.org, { metrics });
  const accountRole =
    org?.type === "org" ? await accountRoleOf(env, org, auth.principalId, metrics) : null;
  if (org?.type !== "org" || accountRole === null)
    throw new OperationError(404, "org_not_found", `No organization ${input.org} was found.`);
  return listAccountRepos(
    env,
    auth,
    { id: org.id, role: orgRepoRole(accountRole, BASE_ROLE) },
    { perPage: input.per_page, cursor: input.cursor },
    metrics,
  );
}
