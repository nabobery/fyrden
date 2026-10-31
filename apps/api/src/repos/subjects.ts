import type { RepoPermission } from "@fyrden/domain";
import type { SubjectKind } from "../do/repo/issues.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { allowedWithRole, authorize, type RepoEntry, resolveRepo } from "./directory.js";

/*
 * Operations that serve issues and pull requests alike (the issue
 * listing, comments, locks) pass the executor's check with
 * `metadata:read`; here each kind takes its own permission: issues
 * `issues:*`, pull requests `pull_requests:*`. The repository object is
 * told the kinds the caller may act on, and answers any other as not
 * found, so nothing of a kind the caller may not read shows.
 */

const PERMISSIONS: Record<"read" | "write", Record<SubjectKind, RepoPermission>> = {
  read: { issue: "issues:read", pull: "pull_requests:read" },
  write: { issue: "issues:write", pull: "pull_requests:write" },
};

/**
 * The kinds the token's limits let the caller `purpose` in `entry`. Every
 * kind's permission takes the same role (read), so once the caller's role
 * is checked for one, this is all that differs between them.
 */
export function tokenKinds(
  ctx: OpContext,
  entry: Pick<RepoEntry, "id">,
  purpose: "read" | "write",
): SubjectKind[] {
  return (["issue", "pull"] as const).filter((kind) =>
    allowedWithRole(ctx.auth, entry, PERMISSIONS[purpose][kind], "admin"),
  );
}

/**
 * The repository `owner/repo` and the kinds the caller may `purpose` in
 * it: the token's limits decide the kinds (both take the same role), then
 * one authorization of the first checks the caller's role (a write reads
 * the directory's primary and checks the role for writing). 404 when the
 * repository is not found or not readable; 403 when it is, but the token
 * may act on neither kind.
 */
export async function subjectAccess(
  ctx: OpContext,
  owner: string,
  repo: string,
  purpose: "read" | "write",
): Promise<{ entry: RepoEntry; kinds: SubjectKind[] }> {
  const entry = await resolveRepo(ctx.env, owner, repo, {
    consistency: purpose === "write" ? "primary" : "cached",
    metrics: ctx.metrics,
  });
  const notFound = new OperationError(
    404,
    "repo_not_found",
    `No repository ${owner}/${repo} was found.`,
  );
  if (!entry) throw notFound;
  const kinds = tokenKinds(ctx, entry, purpose);
  const first = kinds[0];
  if (!first) {
    if (!(await authorize(ctx.env, ctx.auth, entry, "metadata:read", ctx.metrics))) throw notFound;
    const [issues, pulls] = [PERMISSIONS[purpose].issue, PERMISSIONS[purpose].pull];
    throw new OperationError(
      403,
      "missing_permission",
      `This needs the ${issues} or the ${pulls} permission.`,
    );
  }
  if (!(await authorize(ctx.env, ctx.auth, entry, PERMISSIONS[purpose][first], ctx.metrics)))
    throw notFound;
  return { entry, kinds };
}

/** No issue or pull request `number` the caller may see. */
export const subjectNotFound = (number: number) =>
  new OperationError(
    404,
    "issue_not_found",
    `The repository has no issue or pull request ${number}.`,
  );
