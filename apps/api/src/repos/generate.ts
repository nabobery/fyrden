import type { generateRepo, Input, Output } from "@fyrden/api-contract";
import { orgRepoRole, type RepoRole } from "@fyrden/domain";
import { accountRoleOf, canUseAccount, findAccount } from "../accounts/account.js";
import { BASE_ROLE } from "../do/OrgDO.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { checkedExpiry, createRepository } from "./create.js";
import { advanceDeletion, markDeletions } from "./deletion.js";
import { allowedWithRole, authorize, resolveRepo } from "./directory.js";
import { committerOf } from "./file-writes.js";

/**
 * The `repos.generate` operation: a new repository whose first commit
 * holds the template's default-branch tree. The repository is created
 * empty and taking no write, then its object copies the tree from the
 * template's object and commits it through the push path; if that fails,
 * nothing else can have been written, so the new repository is deleted
 * again and the failure answered.
 */
export async function generateRepoOperation(
  ctx: OpContext,
  input: Input<typeof generateRepo>,
): Promise<Output<typeof generateRepo>> {
  const { env, auth, metrics } = ctx;
  const template = await resolveRepo(env, input.template_owner, input.template_repo, {
    consistency: "primary",
    metrics,
  });
  if (!template || !(await authorize(env, auth, template, "contents:read", metrics)))
    throw new OperationError(
      404,
      "repo_not_found",
      `No repository ${input.template_owner}/${input.template_repo} was found.`,
    );
  if (!template.isTemplate)
    throw new OperationError(
      422,
      "not_a_template",
      `${template.ownerHandle}/${template.name} is not a template repository.`,
    );

  const owner = await ownerFor(ctx, input.owner);
  // The first commit is a write to the new repository: the token must be able to make it.
  if (!allowedWithRole(auth, { id: "" }, "contents:write", owner.role))
    throw new OperationError(
      403,
      "missing_permission",
      "Generating a repository writes to it: the token needs contents:write, without a repository list.",
    );

  const created = await createRepository(env, owner, input.name, {
    actorId: auth.principalId,
    requestId: ctx.requestId,
    metrics,
    templateId: template.id,
    expiresAt: checkedExpiry(input.expires_at),
  });
  metrics.count("do.request", { class: "RepoDO", method: "generateFrom" });
  const generated = await env.REPO.getByName(created.id)
    .generateFrom({
      principal: auth.principalId,
      tokenId: auth.id,
      repoId: created.id,
      committer: committerOf(ctx),
      message: "Initial commit",
    })
    .catch(async (error: unknown) => {
      await discard(ctx, created);
      throw error;
    });
  if (!generated.ok) {
    await discard(ctx, created);
    throw new OperationError(generated.status, generated.code, generated.error);
  }
  return created;
}

/** Who will own the new repository, and the role the caller gets on it. */
async function ownerFor(
  ctx: OpContext,
  handle: string | undefined,
): Promise<{ id: string; handle: string; role: RepoRole | null }> {
  const { env, auth, metrics } = ctx;
  const self = auth.principalHandle ?? "";
  if (handle === undefined || handle.toLowerCase() === self.toLowerCase())
    return { id: auth.principalId, handle: self, role: "admin" };
  const org = await findAccount(env, handle, { metrics });
  const role =
    org?.type === "org" ? await accountRoleOf(env, org, auth.principalId, metrics) : null;
  if (org?.type !== "org" || role === null)
    throw new OperationError(404, "org_not_found", `No organization ${handle} was found.`);
  if (!canUseAccount(auth, role, "repos:create"))
    throw new OperationError(403, "forbidden", `You may not use repos:create in ${org.handle}.`);
  return { id: org.id, handle: org.handle, role: orgRepoRole(role, BASE_ROLE) };
}

/** Deletes a repository whose generation failed; the cron finishes what this does not. */
async function discard(ctx: OpContext, repo: Output<typeof generateRepo>): Promise<void> {
  await markDeletions(ctx.env, [{ id: repo.id, ownerHandle: repo.owner, name: repo.name }], {
    actorId: ctx.auth.principalId,
    requestId: ctx.requestId,
    metrics: ctx.metrics,
  });
  // Frees the name now if it can; a deletion it does not finish waits for the cron.
  await advanceDeletion(ctx.env, repo.id, { metrics: ctx.metrics }).catch(() => "deleting");
}
