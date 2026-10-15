import type {
  applySuggestions,
  createReviewComment,
  deleteReviewComment,
  getReviewComment,
  Input,
  listReviewComments,
  listReviewThreads,
  Output,
  resolveReviewThread,
  unresolveReviewThread,
  updateReviewComment,
} from "@fyrden/api-contract";
import { coAuthorTrailers } from "@fyrden/domain";
import { appendTrailers } from "@fyrden/git-core";
import type { ReviewCommentRecord, ThreadRecord } from "../do/repo/review-comments.js";
import { repoFor } from "../git/chunked/operations.js";
import { decodeCursor, encodeCursor } from "../ops/cursor.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { resolveOne } from "../signing/verification.js";
import type { RepoEntry } from "./directory.js";
import { commitIdentityOf, noReplyPeople } from "./file-writes.js";
import { actorOf, failure } from "./pulls.js";

/** A diff comment as the API returns it; `headSha` is its pull request's head now. */
function commentOutput(
  comment: ReviewCommentRecord,
  headSha: string | null,
): Output<typeof getReviewComment> {
  const { anchor } = comment;
  const outdated = anchor.commitSha !== headSha;
  return {
    id: comment.id,
    pull_request_review_id: null,
    ...(comment.inReplyTo !== null && { in_reply_to_id: comment.inReplyTo }),
    thread_id: comment.threadId,
    user: { id: comment.authorId },
    performed_via_agents: [...comment.actChain],
    body: comment.body,
    commit_id: anchor.commitSha,
    original_commit_id: anchor.commitSha,
    path: anchor.path,
    side: anchor.side,
    line: outdated ? null : anchor.line,
    original_line: anchor.line,
    start_line: anchor.startLine,
    start_side: anchor.startLine === null ? null : anchor.side,
    outdated,
    resolved: comment.resolved,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

function threadOutput(
  thread: ThreadRecord,
  headSha: string | null,
): Output<typeof resolveReviewThread> {
  return {
    id: thread.id,
    path: thread.path,
    side: thread.side,
    line: thread.line,
    start_line: thread.startLine,
    commit_id: thread.commitSha,
    outdated: thread.commitSha !== headSha,
    resolved: thread.resolvedAt !== null,
    resolved_by: thread.resolvedBy === null ? null : { id: thread.resolvedBy },
    comments: thread.comments,
  };
}

const repo = (ctx: OpContext, entry: RepoEntry, method: string) => {
  ctx.metrics.count("do.request", { class: "RepoDO", method });
  return ctx.env.REPO.getByName(entry.id);
};

const commentNotFound = (id: number) =>
  new OperationError(404, "comment_not_found", `The repository has no review comment ${id}.`);

const ANCHOR_REFUSALS: Record<string, string> = {
  path_not_found: "The file is not in the commit (the merge base, for the LEFT side).",
  line_out_of_range: "The file does not have the lines named.",
  invalid_range: "start_line must come before line.",
  commit_unavailable:
    "That earlier head is no longer stored (it was force-pushed away); comment on the current head.",
};

/** The problem for a refusal of the repository object. */
function refusal(
  entry: RepoEntry,
  result: { code: string; status?: 403 | 404 | 405 | 409 | 422; error?: string },
  ids: { readonly comment?: number; readonly number?: number },
): OperationError {
  // A failure reading the file the anchor names, with its own status (a busy read is 409).
  if (result.error !== undefined)
    return new OperationError(result.status ?? 422, result.code, result.error);
  const anchor = ANCHOR_REFUSALS[result.code];
  if (anchor !== undefined) return new OperationError(422, result.code, anchor);
  if (result.code === "comment_not_found") return commentNotFound(ids.comment ?? 0);
  if (result.code === "thread_not_found")
    return new OperationError(404, "thread_not_found", "The pull request has no such thread.");
  return failure(entry, result.code, ids.number);
}

/** The cursor of a listing by id: the last one's id. */
const afterOf = (cursor: string | undefined) => {
  const after = decodeCursor(cursor, (n) => /^[1-9][0-9]{0,15}$/.test(n));
  return after === "" ? 0 : Number(after);
};

/** The `pulls.comments.list` operation. */
export async function listReviewCommentsOperation(
  ctx: OpContext,
  input: Input<typeof listReviewComments>,
): Promise<Output<typeof listReviewComments>> {
  const after = afterOf(input.cursor);
  const entry = await repoFor(ctx, input.owner, input.repo, "pull_requests:read");
  const listed = await repo(ctx, entry, "listReviewComments").listReviewComments(
    input.pull_number,
    after,
    input.per_page + 1,
  );
  if (listed === null) throw failure(entry, "repo_not_found");
  if (listed === undefined) throw failure(entry, "not_found", input.pull_number);
  const page = listed.comments.slice(0, input.per_page);
  const last = page.at(-1);
  return {
    comments: page.map((c) => commentOutput(c, listed.headSha)),
    next_cursor:
      listed.comments.length > input.per_page && last ? encodeCursor(String(last.id)) : null,
  };
}

/** The `pulls.comments.get` operation. */
export async function getReviewCommentOperation(
  ctx: OpContext,
  input: Input<typeof getReviewComment>,
): Promise<Output<typeof getReviewComment>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "pull_requests:read");
  const found = await repo(ctx, entry, "getReviewComment").getReviewComment(input.comment_id);
  if (found === null) throw failure(entry, "repo_not_found");
  if (!found) throw commentNotFound(input.comment_id);
  return commentOutput(found.comment, found.headSha);
}

/** The `pulls.comments.create` operation: a new thread, or a reply in one. */
export async function createReviewCommentOperation(
  ctx: OpContext,
  input: Input<typeof createReviewComment>,
): Promise<Output<typeof createReviewComment>> {
  const anchored =
    input.commit_id !== undefined || input.path !== undefined || input.line !== undefined;
  if (input.in_reply_to !== undefined && (anchored || input.start_line !== undefined))
    throw new OperationError(422, "invalid_input", "A reply takes no commit_id, path or lines.");
  if (input.in_reply_to === undefined && (!input.commit_id || !input.path || !input.line))
    throw new OperationError(422, "invalid_input", "A comment needs commit_id, path and line.");
  if (input.start_side !== undefined && input.start_side !== input.side)
    throw new OperationError(422, "invalid_input", "A range stays on one side.");
  const entry = await repoFor(ctx, input.owner, input.repo, "pull_requests:write");
  const stub = repo(ctx, entry, "createReviewComment");
  const result =
    input.in_reply_to !== undefined
      ? await stub.replyReviewComment(
          input.pull_number,
          input.in_reply_to,
          input.body,
          actorOf(ctx),
        )
      : await stub.createReviewComment(
          input.pull_number,
          {
            body: input.body,
            commitId: input.commit_id as string,
            path: input.path as string,
            side: input.side,
            line: input.line as number,
            ...(input.start_line !== undefined && { startLine: input.start_line }),
          },
          actorOf(ctx),
        );
  if (!result.ok)
    throw refusal(entry, result, {
      ...(input.in_reply_to !== undefined && { comment: input.in_reply_to }),
      number: input.pull_number,
    });
  return commentOutput(result.comment, result.headSha);
}

/** The `pulls.comments.update` operation. */
export async function updateReviewCommentOperation(
  ctx: OpContext,
  input: Input<typeof updateReviewComment>,
): Promise<Output<typeof updateReviewComment>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "pull_requests:write");
  const result = await repo(ctx, entry, "editReviewComment").editReviewComment(
    input.comment_id,
    input.body,
    actorOf(ctx),
  );
  if (!result.ok) throw refusal(entry, result, { comment: input.comment_id });
  return commentOutput(result.comment, result.headSha);
}

/** The `pulls.comments.delete` operation. */
export async function deleteReviewCommentOperation(
  ctx: OpContext,
  input: Input<typeof deleteReviewComment>,
): Promise<Output<typeof deleteReviewComment>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "pull_requests:write");
  const result = await repo(ctx, entry, "deleteReviewComment").deleteReviewComment(
    input.comment_id,
    actorOf(ctx),
  );
  if (!result.ok) throw refusal(entry, result, { comment: input.comment_id });
  return { id: input.comment_id, state: "deleted" };
}

/** The `pulls.threads.list` operation. */
export async function listReviewThreadsOperation(
  ctx: OpContext,
  input: Input<typeof listReviewThreads>,
): Promise<Output<typeof listReviewThreads>> {
  const after = afterOf(input.cursor);
  const entry = await repoFor(ctx, input.owner, input.repo, "pull_requests:read");
  const listed = await repo(ctx, entry, "listReviewThreads").listReviewThreads(
    input.pull_number,
    after,
    input.per_page + 1,
  );
  if (listed === null) throw failure(entry, "repo_not_found");
  if (listed === undefined) throw failure(entry, "not_found", input.pull_number);
  const page = listed.threads.slice(0, input.per_page);
  const last = page.at(-1);
  return {
    threads: page.map((t) => threadOutput(t, listed.headSha)),
    next_cursor:
      listed.threads.length > input.per_page && last ? encodeCursor(String(last.id)) : null,
  };
}

async function resolution(
  ctx: OpContext,
  input: Input<typeof resolveReviewThread>,
  resolved: boolean,
): Promise<Output<typeof resolveReviewThread>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "pull_requests:write");
  const result = await repo(ctx, entry, "resolveReviewThread").resolveReviewThread(
    input.pull_number,
    input.thread_id,
    resolved,
    actorOf(ctx),
  );
  if (!result.ok) throw refusal(entry, result, { number: input.pull_number });
  return threadOutput(result.thread, result.headSha);
}

/** The `pulls.threads.resolve` operation. */
export const resolveReviewThreadOperation = (
  ctx: OpContext,
  input: Input<typeof resolveReviewThread>,
) => resolution(ctx, input, true);

/** The `pulls.threads.unresolve` operation. */
export const unresolveReviewThreadOperation = (
  ctx: OpContext,
  input: Input<typeof unresolveReviewThread>,
) => resolution(ctx, input, false);

/** GitHub's message for applied suggestions. */
const SUGGESTIONS_MESSAGE = "Apply suggestions from code review";

/** The `pulls.suggestions.apply` operation. */
export async function applySuggestionsOperation(
  ctx: OpContext,
  input: Input<typeof applySuggestions>,
): Promise<Output<typeof applySuggestions>> {
  const message = input.commit_message ?? SUGGESTIONS_MESSAGE;
  if (message.trim() === "")
    throw new OperationError(422, "invalid_input", "A commit needs a message.");
  // git stops reading a message at a NUL (and fsck warns of one).
  if (message.includes("\0"))
    throw new OperationError(422, "invalid_input", "A commit message must not contain NUL.");
  const entry = await repoFor(ctx, input.owner, input.repo, "contents:write");
  const stub = repo(ctx, entry, "applySuggestions");
  const authors = await stub.reviewCommentAuthors(input.comment_ids);
  if (authors === null) throw failure(entry, "repo_not_found");
  // The suggestions' authors are co-authors (the one applying them is the author).
  const identity = await commitIdentityOf(ctx);
  const suggesters = (
    await noReplyPeople(ctx, [...new Set(authors.map((a) => a.authorId))])
  ).filter((p) => p.email !== identity.author.email);
  const result = await stub.applySuggestions(
    {
      number: input.pull_number,
      commentIds: input.comment_ids,
      message: appendTrailers(
        message,
        coAuthorTrailers(message, [...identity.coAuthors, ...suggesters]),
      ),
      committer: identity.committer,
      author: identity.author,
    },
    actorOf(ctx),
  );
  if (!result.ok) throw new OperationError(result.status, result.code, result.error);
  return {
    branch: result.value.branch,
    commit: await resolveOne(ctx, result.value.commit),
    files: result.value.paths.map((path, i) => ({ path, sha: result.value.blobs[i] ?? null })),
  };
}
