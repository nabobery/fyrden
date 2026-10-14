import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import type { generateRepo, Input, Output } from "@fyrden/api-contract";
import { orgRepoRole, type RepoRole } from "@fyrden/domain";
import { actingRoleIn, canUseAccount, findAccount } from "../accounts/account.js";
import { BASE_ROLE } from "../do/OrgDO.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { checkedExpiry, createRepository } from "./create.js";
import { advanceDeletion, markDeletions } from "./deletion.js";
import { allowedWithRole, authorize, resolveRepo } from "./directory.js";
import { committerOf } from "./file-writes.js";

/** Proposed. */
export const GENERATION_POLICY = {
  /**
   * How long a generation may stay unconfirmed before the cron settles it
   * (well past any request's own run time).
   */
  timeoutMs: 15 * 60 * 1000,
  /** Overdue generations one cron run settles. */
  perCronRun: 20,
};

/**
 * The `repos.generate` operation: a new repository whose first commit
 * holds the template's default-branch tree. The repository is created
 * empty and taking no write, then its object copies the tree from the
 * template's object and commits it through the push path. When that is
 * not confirmed (refused, or an error that may have come after the commit),
 * the object settles it: a generation that committed is kept, any other
 * is abandoned (its commit refused from then on) and the repository
 * deleted, nothing else having been written to it. One the request could
 * not settle is settled by the cron once overdue.
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
  const stub = env.REPO.getByName(created.id);
  let failure: unknown;
  const generated = await stub
    .generateFrom({
      principal: auth.principalId,
      tokenId: auth.id,
      repoId: created.id,
      committer: committerOf(ctx),
      message: "Initial commit",
      requestId: ctx.requestId ?? null,
    })
    .catch((error: unknown) => {
      failure = error;
      return undefined;
    });
  if (generated?.ok) {
    await generationDone(ctx, created.id);
    return created;
  }
  // Not confirmed. An error may have come after the commit was made: the object knows.
  metrics.count("do.request", { class: "RepoDO", method: "abandonGeneration" });
  const settled = await stub.abandonGeneration().catch(() => undefined);
  if (settled === "committed") {
    await generationDone(ctx, created.id);
    return created;
  }
  if (settled === "abandoned") await discard(ctx, created);
  if (generated) throw new OperationError(generated.status, generated.code, generated.error);
  throw failure;
}

/** Records that a generation's first commit was made (the cron settles it otherwise). */
async function generationDone(ctx: OpContext, repoId: string): Promise<void> {
  ctx.metrics.count("d1.query", { db: "directory", op: "repo_generated" });
  await ctx.env.DIRECTORY.prepare("UPDATE repos SET generating_since = NULL WHERE id = ?")
    .bind(repoId)
    .run()
    .catch((error: unknown) => ctx.log.warn("generation not recorded", { error, repoId }));
}

/**
 * Settles generations whose request never confirmed them, once overdue:
 * one whose first commit was made is kept (and recorded), any other is
 * abandoned and its repository deleted. Returns how many it deleted. One
 * whose object cannot be reached goes behind the others (it is overdue
 * again after the timeout), so it never holds up the rest.
 */
export async function settleStaleGenerations(
  env: Env,
  options: { now: number; limit?: number; metrics?: Metrics },
): Promise<number> {
  options.metrics?.count("d1.query", { db: "directory", op: "repos_generating" });
  const { results } = await env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT r.id, r.owner_id AS ownerId, p.handle AS ownerHandle, r.name FROM repos r
       JOIN principals p ON p.id = r.owner_id
       WHERE r.generating_since IS NOT NULL AND r.generating_since <= ? AND r.state = 'active'
       ORDER BY r.generating_since LIMIT ?`,
    )
    .bind(options.now - GENERATION_POLICY.timeoutMs, options.limit ?? GENERATION_POLICY.perCronRun)
    .all<{ id: string; ownerId: string; ownerHandle: string; name: string }>();
  const abandoned: typeof results = [];
  for (const repo of results) {
    const settled = await env.REPO.getByName(repo.id)
      .abandonGeneration()
      .catch(() => undefined);
    if (settled === "abandoned") abandoned.push(repo);
    else
      await env.DIRECTORY.prepare("UPDATE repos SET generating_since = ? WHERE id = ?")
        .bind(settled === undefined ? options.now : null, repo.id)
        .run();
  }
  if (abandoned.length === 0) return 0;
  const marked = await markDeletions(env, abandoned, {
    actorId: null,
    ...(options.metrics && { metrics: options.metrics }),
  });
  for (const id of marked)
    await advanceDeletion(env, id, options.metrics ? { metrics: options.metrics } : {}).catch(
      () => "deleting",
    );
  return marked.size;
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
  const role = org?.type === "org" ? await actingRoleIn(env, org, auth, metrics) : null;
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
