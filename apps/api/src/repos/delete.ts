import type { deleteRepo, deleteRepos, Input, Output } from "@fyrden/api-contract";
import { repoFor } from "../git/chunked/operations.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { advanceDeletion, DELETION_POLICY, markDeletions } from "./deletion.js";
import { findOwnedRepos, forgetResolved, ownAccessible, ownershipChange } from "./directory.js";

/** The `repos.delete` operation: marks the deletion, then advances it as far as it can. */
export async function deleteRepoOperation(
  ctx: OpContext,
  input: Input<typeof deleteRepo>,
): Promise<Output<typeof deleteRepo>> {
  const { env, auth, metrics } = ctx;
  const entry = await repoFor(ctx, input.owner, input.repo, "administration:write");
  const marked = await markDeletions(env, [entry], {
    actorId: auth.principalId,
    act: auth.act,
    requestId: ctx.requestId,
    metrics,
  });
  const changed = marked.has(entry.id)
    ? undefined
    : await ownershipChange(env, entry.id, entry.ownerId, metrics);
  if (changed === "transferring")
    throw new OperationError(
      409,
      "repo_transferring",
      "The repository is being transferred; delete it once it lands.",
    );
  if (changed === "moved")
    throw new OperationError(
      404,
      "repo_not_found",
      `No repository ${input.owner}/${input.repo} was found.`,
    );
  // The name the caller used may be one a redirect held.
  forgetResolved(entry.ownerHandle, input.repo);
  return {
    id: entry.id,
    full_name: `${entry.ownerHandle}/${entry.name}`,
    state: await advanceDeletion(env, entry.id, { metrics }),
  };
}

/**
 * The `repos.delete_many` operation: one lookup and one directory batch
 * for every name; the first few deletions advance here, the cron the rest.
 */
export async function deleteReposOperation(
  ctx: OpContext,
  input: Input<typeof deleteRepos>,
): Promise<Output<typeof deleteRepos>> {
  const { env, auth, metrics } = ctx;
  const names = [...new Map(input.names.map((name) => [name.toLowerCase(), name])).values()];
  const found = await findOwnedRepos(env, auth.principalId, names, metrics);
  const byName = new Map(
    (await ownAccessible(env, auth, found, "administration:write", metrics)).map((entry) => [
      entry.name.toLowerCase(),
      entry,
    ]),
  );
  const marked = await markDeletions(env, [...byName.values()], {
    actorId: auth.principalId,
    act: auth.act,
    requestId: ctx.requestId,
    metrics,
  });
  const states = new Map<string, "deleting" | "deleted">();
  for (const id of marked) {
    states.set(
      id,
      states.size < DELETION_POLICY.perBulkRequest
        ? await advanceDeletion(env, id, { metrics })
        : "deleting",
    );
  }
  return {
    results: names.map((name) => {
      const entry = byName.get(name.toLowerCase());
      // Deleted by a concurrent request since the lookup: not this one's.
      const state = entry && states.get(entry.id);
      return entry && state
        ? { name: entry.name, id: entry.id, state }
        : { name, id: null, state: "not_found" as const };
    }),
  };
}
