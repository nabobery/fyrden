import type {
  createReview,
  dismissReview,
  getPullCodeOwners,
  getReview,
  Input,
  listRequestedReviewers,
  listReviews,
  Output,
  removeRequestedReviewers,
  requestReviewers,
} from "@fyrden/api-contract";
import { SHOWN_HANDLE } from "../accounts/handles.js";
import { repoFor } from "../git/chunked/operations.js";
import { decodeCursor, encodeCursor } from "../ops/cursor.js";
import { hasPermission, type OpContext, OperationError } from "../ops/execute.js";
import type { RepoEntry } from "./directory.js";
import { authorize } from "./directory.js";
import { actorOf, failure, readable } from "./pulls.js";
import { pullOutput, reviewOutput } from "./shapes.js";

const repo = (ctx: OpContext, entry: RepoEntry, method: string) => {
  ctx.metrics.count("do.request", { class: "RepoDO", method });
  return ctx.env.REPO.getByName(entry.id);
};

/**
 * Users and agents by handle (ignoring case): lower-cased handle to id.
 * Enabled ones only (an agent with its owner enabled too), unless
 * `includeDisabled` (to withdraw a request made of one disabled since).
 */
export async function principalsByLogin(
  ctx: OpContext,
  logins: readonly string[],
  includeDisabled = false,
): Promise<Map<string, string>> {
  const wanted = [...new Set(logins.map((l) => l.toLowerCase()))];
  ctx.metrics.count("d1.query", { db: "directory", op: "reviewers_find" });
  const { results } = await ctx.env.DIRECTORY.withSession("first-primary")
    .prepare(
      // An agent whose owner is disabled cannot act (its tokens are refused): not enabled either.
      `SELECT p.id, p.handle FROM principals p LEFT JOIN principals o ON o.id = p.owner_id
       WHERE p.handle COLLATE NOCASE IN (${wanted.map((_, i) => `?${i + 2}`).join(", ")})
         AND p.type IN ('user', 'agent')
         AND (?1 OR (p.disabled_at IS NULL AND o.disabled_at IS NULL))`,
    )
    .bind(includeDisabled ? 1 : 0, ...wanted)
    .all<{ id: string; handle: string }>();
  return new Map(results.map((r) => [r.handle.toLowerCase(), r.id]));
}

/** Every login's principal; one that names no enabled user or agent is refused. */
async function reviewersByLogin(ctx: OpContext, logins: readonly string[]): Promise<string[]> {
  const found = await principalsByLogin(ctx, logins);
  return [...new Set(logins.map((l) => l.toLowerCase()))].map((login) => {
    const id = found.get(login);
    if (!id)
      throw new OperationError(
        422,
        "reviewer_no_access",
        `No user or agent ${login} can review here.`,
      );
    return id;
  });
}

/**
 * Handles of principals, for showing requested reviewers: `ghost` for one
 * being deleted or deleted; one unknown shows its id.
 */
async function loginsOf(
  ctx: OpContext,
  ids: readonly string[],
): Promise<{ id: string; login: string }[]> {
  if (ids.length === 0) return [];
  ctx.metrics.count("d1.query", { db: "directory", op: "reviewers_handles" });
  const { results } = await ctx.env.DIRECTORY.prepare(
    `SELECT p.id, ${SHOWN_HANDLE} AS handle FROM principals p
     WHERE p.id IN (${ids.map(() => "?").join(", ")})`,
  )
    .bind(...ids)
    .all<{ id: string; handle: string | null }>();
  const handles = new Map(results.map((r) => [r.id, r.handle]));
  return ids.map((id) => ({ id, login: handles.get(id) ?? id }));
}

/** The `pulls.reviews.list` operation. */
export async function listReviewsOperation(
  ctx: OpContext,
  input: Input<typeof listReviews>,
): Promise<Output<typeof listReviews>> {
  // The cursor is the last review's id.
  const after = decodeCursor(input.cursor, (n) => /^[1-9][0-9]{0,15}$/.test(n));
  const entry = await repoFor(ctx, input.owner, input.repo, "pull_requests:read");
  const reviews = await repo(ctx, entry, "listReviews").listReviews(
    input.pull_number,
    after === "" ? 0 : Number(after),
    input.per_page + 1,
  );
  if (reviews === null) throw failure(entry, "repo_not_found");
  if (reviews === undefined) throw failure(entry, "not_found", input.pull_number);
  const page = reviews.slice(0, input.per_page);
  const last = page.at(-1);
  return {
    reviews: page.map(reviewOutput),
    next_cursor: reviews.length > input.per_page && last ? encodeCursor(String(last.id)) : null,
  };
}

/** The `pulls.reviews.get` operation. */
export async function getReviewOperation(
  ctx: OpContext,
  input: Input<typeof getReview>,
): Promise<Output<typeof getReview>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "pull_requests:read");
  const review = await repo(ctx, entry, "getReview").getReview(input.pull_number, input.review_id);
  if (review === null) throw failure(entry, "repo_not_found");
  if (!review) throw failure(entry, "review_not_found");
  return reviewOutput(review);
}

/** The `pulls.reviews.create` operation. */
export async function createReviewOperation(
  ctx: OpContext,
  input: Input<typeof createReview>,
): Promise<Output<typeof createReview>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "pull_requests:write");
  const result = await repo(ctx, entry, "submitReview").submitReview(
    input.pull_number,
    { event: input.event, body: input.body ? input.body : null, commitSha: input.commit_id },
    actorOf(ctx),
  );
  if (!result.ok) throw failure(entry, result.code, input.pull_number);
  return reviewOutput(result.review);
}

/** The `pulls.reviews.dismiss` operation. */
export async function dismissReviewOperation(
  ctx: OpContext,
  input: Input<typeof dismissReview>,
): Promise<Output<typeof dismissReview>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "pull_requests:write");
  const result = await repo(ctx, entry, "dismissReview").dismissReview(
    input.pull_number,
    input.review_id,
    input.message,
    actorOf(ctx),
  );
  if (!result.ok) throw failure(entry, result.code, input.pull_number);
  return reviewOutput(result.review);
}

/** The `pulls.requested_reviewers.list` operation. */
export async function listRequestedReviewersOperation(
  ctx: OpContext,
  input: Input<typeof listRequestedReviewers>,
): Promise<Output<typeof listRequestedReviewers>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "pull_requests:read");
  const requested = await repo(ctx, entry, "requestedReviewers").requestedReviewers(
    input.pull_number,
  );
  if (requested === null) throw failure(entry, "repo_not_found");
  if (requested === undefined) throw failure(entry, "not_found", input.pull_number);
  return { users: await loginsOf(ctx, requested.users), teams: requested.teams };
}

/** The `pulls.requested_reviewers.add` operation. */
export async function requestReviewersOperation(
  ctx: OpContext,
  input: Input<typeof requestReviewers>,
): Promise<Output<typeof requestReviewers>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "pull_requests:write");
  const ids = await reviewersByLogin(ctx, input.reviewers ?? []);
  const result = await repo(ctx, entry, "requestReviewers").requestReviewers(
    input.pull_number,
    ids,
    actorOf(ctx),
    input.team_reviewers ?? [],
  );
  if (!result.ok) throw failure(entry, result.code, input.pull_number);
  return pullOutput(result.pull, readable(ctx, entry));
}

/** The `pulls.requested_reviewers.remove` operation. */
export async function removeRequestedReviewersOperation(
  ctx: OpContext,
  input: Input<typeof removeRequestedReviewers>,
): Promise<Output<typeof removeRequestedReviewers>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "pull_requests:write");
  // A handle that names no one cannot have been requested: nothing to withdraw for it.
  const ids = [...(await principalsByLogin(ctx, input.reviewers ?? [], true)).values()];
  const result = await repo(ctx, entry, "removeRequestedReviewers").removeRequestedReviewers(
    input.pull_number,
    ids,
    actorOf(ctx),
    input.team_reviewers ?? [],
  );
  if (!result.ok) throw failure(entry, result.code, input.pull_number);
  return pullOutput(result.pull, readable(ctx, entry));
}

/** A code-owners page's cursor: the evaluation and the last rule's line. */
const CODE_OWNERS_CURSOR = /^([1-9][0-9]{0,15})\.([1-9][0-9]{0,15})$/;

const invalidCursor = () =>
  new OperationError(
    422,
    "invalid_cursor",
    "The cursor is for a result the pull request no longer shows; start again without it.",
  );

/** The `pulls.code_owners.get` operation (Fyrden's). */
export async function getPullCodeOwnersOperation(
  ctx: OpContext,
  input: Input<typeof getPullCodeOwners>,
): Promise<Output<typeof getPullCodeOwners>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "pull_requests:read");
  // Owners are the file's content: the token reads contents too.
  if (!hasPermission("contents:read", ctx.auth))
    throw new OperationError(
      403,
      "missing_permission",
      "pulls.code_owners.get needs the contents:read permission too.",
    );
  if (!(await authorize(ctx.env, ctx.auth, entry, "contents:read", ctx.metrics)))
    throw failure(entry, "repo_not_found");
  const cursor = decodeCursor(input.cursor, (c) => CODE_OWNERS_CURSOR.test(c));
  const [, evalId, line] = CODE_OWNERS_CURSOR.exec(cursor) ?? [];
  const page = evalId && line ? { evalId: Number(evalId), after: Number(line) } : null;
  const view = await repo(ctx, entry, "pullCodeOwners").pullCodeOwners(
    input.pull_number,
    page,
    input.per_page,
  );
  if (view === null) throw failure(entry, "repo_not_found");
  if (view === undefined) throw failure(entry, "not_found", input.pull_number);
  if (view === "closed")
    throw new OperationError(
      422,
      "pull_not_open",
      "Code owners are worked out for open pull requests only.",
    );
  if (view === "stale_cursor") throw invalidCursor();
  const empty = {
    reason: null,
    retry_at: null,
    file: null,
    errors: 0,
    rules: [],
    ownerless_paths: 0,
    unmatched_paths: 0,
    unmatchable_paths: 0,
    unmatchable_example: null,
    next_cursor: null,
  };
  if (view.state === "pending") return { ...empty, state: "pending" };
  return {
    state: view.state,
    reason: view.reason,
    retry_at: view.retryAt,
    file: view.file,
    errors: view.errors,
    rules: view.rules.map((r) => ({
      line: r.line,
      owners: [...r.owners],
      paths: r.paths,
      example_path: r.example,
    })),
    ownerless_paths: view.ownerlessPaths,
    unmatched_paths: view.unmatchedPaths,
    unmatchable_paths: view.unmatchablePaths,
    unmatchable_example: view.unmatchableExample,
    next_cursor: view.next ? encodeCursor(`${view.next.evalId}.${view.next.line}`) : null,
  };
}
