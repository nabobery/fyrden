import type { forkRepo, Input, listForks, Output } from "@fyrden/api-contract";
import { accountLimits } from "../accounts/quotas.js";
import { repoFor } from "../git/chunked/operations.js";
import { decodeSeekCursor, encodeSeekCursor } from "../ops/cursor.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { checkedExpiry } from "../repos/create.js";
import { checkNewRepo, defaultBranchOf, listOwnedForks } from "../repos/directory.js";
import { readModelDetails } from "../repos/listing.js";
import { repoOutput, starCounts } from "../repos/output.js";
import { forkRepository } from "./fork.js";

/** The `repos.fork` operation: the caller forks a repository it can read into one it owns. */
export async function forkRepoOperation(
  ctx: OpContext,
  input: Input<typeof forkRepo>,
): Promise<Output<typeof forkRepo>> {
  const parent = await repoFor(ctx, input.owner, input.repo, "contents:read");
  const name = input.name ?? parent.name;
  const owner = { id: ctx.auth.principalId, handle: ctx.auth.principalHandle ?? "" };
  const { maxRepos } = await accountLimits(ctx.env, owner.id, ctx.metrics);
  await checkNewRepo(ctx.env, owner, name, maxRepos, ctx.metrics);
  const result = await forkRepository(ctx.env, {
    parent,
    ownerId: ctx.auth.principalId,
    ownerHandle: ctx.auth.principalHandle ?? "",
    name,
    expiresAt: checkedExpiry(input.expires_at),
    maxRepos,
    requestId: ctx.requestId,
    metrics: ctx.metrics,
  });
  if (!result.ok) throw new OperationError(result.status, result.code, result.error);
  return repoOutput(result.repo, {
    defaultBranch: result.defaultBranch,
    description: null,
    // The caller can read the repository it forked.
    parentVisible: true,
    stars: 0,
  });
}

/**
 * The `repos.forks.list` operation: the forks of a repository that the
 * caller owns (and its token may see), oldest first. Forks of other
 * accounts are not listed: each would need its own authorization, and
 * pages and cursors must not depend on what the caller cannot see.
 */
export async function listForksOperation(
  ctx: OpContext,
  input: Input<typeof listForks>,
): Promise<Output<typeof listForks>> {
  const parent = await repoFor(ctx, input.owner, input.repo, "metadata:read");
  const rows = await listOwnedForks(
    ctx.env,
    parent.id,
    ctx.auth.principalId,
    {
      after: decodeSeekCursor(input.cursor),
      limit: input.per_page + 1,
      onlyIds: ctx.auth.repoIds,
    },
    ctx.metrics,
  );
  const page = rows.slice(0, input.per_page);
  const details = await readModelDetails(
    ctx.env,
    page.map((entry) => entry.id),
    ctx.metrics,
  );
  const stars = await starCounts(
    ctx.env,
    page.map((entry) => entry.id),
    ctx.metrics,
  );
  const last = page.at(-1);
  return {
    repos: page.map((entry) =>
      repoOutput(entry, {
        defaultBranch: defaultBranchOf(details.get(entry.id)?.default_branch ?? null),
        description: details.get(entry.id)?.description ?? null,
        // The caller just read it.
        parentVisible: true,
        stars: stars.get(entry.id) ?? 0,
      }),
    ),
    next_cursor:
      rows.length > input.per_page && last
        ? encodeSeekCursor({ at: last.createdAt, id: last.id })
        : null,
  };
}
