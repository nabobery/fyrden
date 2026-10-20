import type {
  createReview,
  dismissReview,
  getReview,
  Input,
  listRequestedReviewers,
  listReviews,
  Output,
  removeRequestedReviewers,
  requestReviewers,
} from "@fyrden/api-contract";
import type { ReviewRecord } from "../do/repo/reviews.js";
import { repoFor } from "../git/chunked/operations.js";
import { decodeCursor, encodeCursor } from "../ops/cursor.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import type { RepoEntry } from "./directory.js";
import { actorOf, failure, pullOutput, readable } from "./pulls.js";

type ReviewOutput = Output<typeof getReview>;

function reviewOutput(review: ReviewRecord): ReviewOutput {
  const dismissed = review.dismissedAt !== null;
  return {
    id: review.id,
    user: { id: review.reviewerId },
    performed_via_agents: [...review.actChain],
    state: dismissed ? "DISMISSED" : review.state,
    body: review.body,
    commit_id: review.commitSha,
    submitted_at: review.submittedAt,
    dismissal: dismissed
      ? {
          by: review.dismissedBy as string,
          message: review.dismissalMessage as string,
          at: review.dismissedAt as number,
        }
      : null,
  };
}

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

/** Handles of principals, for showing requested reviewers; one that is gone shows its id. */
async function loginsOf(
  ctx: OpContext,
  ids: readonly string[],
): Promise<{ id: string; login: string }[]> {
  if (ids.length === 0) return [];
  ctx.metrics.count("d1.query", { db: "directory", op: "reviewers_handles" });
  const { results } = await ctx.env.DIRECTORY.prepare(
    `SELECT id, handle FROM principals WHERE id IN (${ids.map(() => "?").join(", ")})`,
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
  const ids = await repo(ctx, entry, "requestedReviewers").requestedReviewers(input.pull_number);
  if (ids === null) throw failure(entry, "repo_not_found");
  if (ids === undefined) throw failure(entry, "not_found", input.pull_number);
  return { users: await loginsOf(ctx, ids), teams: [] };
}

/** The `pulls.requested_reviewers.add` operation. */
export async function requestReviewersOperation(
  ctx: OpContext,
  input: Input<typeof requestReviewers>,
): Promise<Output<typeof requestReviewers>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "pull_requests:write");
  const ids = await reviewersByLogin(ctx, input.reviewers);
  const result = await repo(ctx, entry, "requestReviewers").requestReviewers(
    input.pull_number,
    ids,
    actorOf(ctx),
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
  const ids = [...(await principalsByLogin(ctx, input.reviewers, true)).values()];
  const result = await repo(ctx, entry, "removeRequestedReviewers").removeRequestedReviewers(
    input.pull_number,
    ids,
    actorOf(ctx),
  );
  if (!result.ok) throw failure(entry, result.code, input.pull_number);
  return pullOutput(result.pull, readable(ctx, entry));
}
