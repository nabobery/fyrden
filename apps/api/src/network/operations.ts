import type { forkRepo, Input, Output } from "@fyrden/api-contract";
import { repoFor } from "../git/chunked/operations.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { repoOutput } from "../repos/output.js";
import { forkRepository, nameTaken } from "./fork.js";

/** The `repos.fork` operation: the caller forks a repository it can read into one it owns. */
export async function forkRepoOperation(
  ctx: OpContext,
  input: Input<typeof forkRepo>,
): Promise<Output<typeof forkRepo>> {
  const parent = await repoFor(ctx, input.owner, input.repo, "contents:read");
  const name = input.name ?? parent.name;
  ctx.metrics.count("d1.query", { db: "directory", op: "repo_name_check" });
  const existing = await ctx.env.DIRECTORY.withSession("first-primary")
    .prepare(
      "SELECT 1 AS one FROM repos WHERE owner_id = ? AND name = ? COLLATE NOCASE AND state <> 'deleted'",
    )
    .bind(ctx.auth.principalId, name)
    .first();
  if (existing) throw new OperationError(409, "name_taken", nameTaken(name));
  const result = await forkRepository(ctx.env, {
    parent,
    ownerId: ctx.auth.principalId,
    ownerHandle: ctx.auth.principalHandle ?? "",
    name,
    requestId: ctx.requestId,
    metrics: ctx.metrics,
  });
  if (!result.ok) throw new OperationError(result.status, result.code, result.error);
  return repoOutput(result.repo, { defaultBranch: result.defaultBranch, description: null });
}
