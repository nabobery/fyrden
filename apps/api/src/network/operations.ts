import type { forkRepo, Input, listForks, Output } from "@fyrden/api-contract";
import { isId } from "@fyrden/domain";
import { repoFor } from "../git/chunked/operations.js";
import { decodeCursor, encodeCursor } from "../ops/cursor.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { defaultBranchOf, listOwnedForks } from "../repos/directory.js";
import { readModelDetails } from "../repos/listing.js";
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
  return repoOutput(result.repo, {
    defaultBranch: result.defaultBranch,
    description: null,
    // The caller can read the repository it forked.
    parentVisible: true,
  });
}

/** A forks page cursor: the last fork of the page, `<created_at>:<id>` (one the caller owns). */
function decodeForkCursor(cursor: string | undefined) {
  if (cursor === undefined) return null;
  const text = decodeCursor(cursor, (value) => {
    const at = value.indexOf(":");
    const time = value.slice(0, at);
    return (
      /^(0|[1-9][0-9]{0,15})$/.test(time) &&
      Number.isSafeInteger(Number(time)) &&
      isId(value.slice(at + 1), "rep")
    );
  });
  const at = text.indexOf(":");
  return { createdAt: Number(text.slice(0, at)), id: text.slice(at + 1) };
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
      after: decodeForkCursor(input.cursor),
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
  const last = page.at(-1);
  return {
    repos: page.map((entry) =>
      repoOutput(entry, {
        defaultBranch: defaultBranchOf(details.get(entry.id)?.default_branch ?? null),
        description: details.get(entry.id)?.description ?? null,
        // The caller just read it.
        parentVisible: true,
      }),
    ),
    next_cursor:
      rows.length > input.per_page && last ? encodeCursor(`${last.createdAt}:${last.id}`) : null,
  };
}
