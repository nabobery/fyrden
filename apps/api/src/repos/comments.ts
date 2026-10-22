import type {
  createComment,
  deleteComment,
  getComment,
  Input,
  listComments,
  Output,
  updateComment,
} from "@fyrden/api-contract";
import type { CommentRecord } from "../do/repo/comments.js";
import type { Reacted } from "../do/repo/reactions.js";
import { decodeCursor, encodeCursor } from "../ops/cursor.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import type { RepoEntry } from "./directory.js";
import { actorOf, failure } from "./pulls.js";
import { reactionRollup } from "./shapes.js";
import { subjectAccess, subjectNotFound } from "./subjects.js";

function commentOutput(comment: Reacted<CommentRecord>): Output<typeof getComment> {
  return {
    id: comment.id,
    issue_number: comment.number,
    user: { id: comment.authorId },
    performed_via_agents: [...comment.actChain],
    body: comment.body,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    reactions: reactionRollup(comment.reactions),
  };
}

const repo = (ctx: OpContext, entry: RepoEntry, method: string) => {
  ctx.metrics.count("do.request", { class: "RepoDO", method });
  return ctx.env.REPO.getByName(entry.id);
};

const commentNotFound = (id: number) =>
  new OperationError(404, "comment_not_found", `The repository has no comment ${id}.`);

/** The problem for a comment refusal; the rest are as an issue's or pull request's. */
function commentFailure(entry: RepoEntry, code: string, id: number, number?: number) {
  if (code === "comment_not_found") return commentNotFound(id);
  if (code === "not_found") return subjectNotFound(number ?? 0);
  return failure(entry, code, number);
}

/** The `issues.comments.list` operation. */
export async function listCommentsOperation(
  ctx: OpContext,
  input: Input<typeof listComments>,
): Promise<Output<typeof listComments>> {
  // The cursor is the last comment's id.
  const after = decodeCursor(input.cursor, (n) => /^[1-9][0-9]{0,15}$/.test(n));
  const { entry, kinds } = await subjectAccess(ctx, input.owner, input.repo, "read");
  const comments = await repo(ctx, entry, "listComments").listComments(
    input.issue_number,
    after === "" ? 0 : Number(after),
    input.per_page + 1,
    kinds,
  );
  if (comments === null) throw failure(entry, "repo_not_found");
  if (comments === undefined) throw subjectNotFound(input.issue_number);
  const page = comments.slice(0, input.per_page);
  const last = page.at(-1);
  return {
    comments: page.map(commentOutput),
    next_cursor: comments.length > input.per_page && last ? encodeCursor(String(last.id)) : null,
  };
}

/** The `issues.comments.get` operation. */
export async function getCommentOperation(
  ctx: OpContext,
  input: Input<typeof getComment>,
): Promise<Output<typeof getComment>> {
  const { entry, kinds } = await subjectAccess(ctx, input.owner, input.repo, "read");
  const comment = await repo(ctx, entry, "getComment").getComment(input.comment_id, kinds);
  if (comment === null) throw failure(entry, "repo_not_found");
  if (!comment) throw commentNotFound(input.comment_id);
  return commentOutput(comment);
}

/** The `issues.comments.create` operation. */
export async function createCommentOperation(
  ctx: OpContext,
  input: Input<typeof createComment>,
): Promise<Output<typeof createComment>> {
  const { entry, kinds } = await subjectAccess(ctx, input.owner, input.repo, "write");
  const result = await repo(ctx, entry, "createComment").createComment(
    input.issue_number,
    input.body,
    actorOf(ctx),
    kinds,
  );
  if (!result.ok) throw commentFailure(entry, result.code, 0, input.issue_number);
  return commentOutput(result.comment);
}

/** The `issues.comments.update` operation. */
export async function updateCommentOperation(
  ctx: OpContext,
  input: Input<typeof updateComment>,
): Promise<Output<typeof updateComment>> {
  const { entry, kinds } = await subjectAccess(ctx, input.owner, input.repo, "write");
  const result = await repo(ctx, entry, "editComment").editComment(
    input.comment_id,
    input.body,
    actorOf(ctx),
    kinds,
  );
  if (!result.ok) throw commentFailure(entry, result.code, input.comment_id);
  return commentOutput(result.comment);
}

/** The `issues.comments.delete` operation. */
export async function deleteCommentOperation(
  ctx: OpContext,
  input: Input<typeof deleteComment>,
): Promise<Output<typeof deleteComment>> {
  const { entry, kinds } = await subjectAccess(ctx, input.owner, input.repo, "write");
  const result = await repo(ctx, entry, "deleteComment").deleteComment(
    input.comment_id,
    actorOf(ctx),
    kinds,
  );
  if (!result.ok) throw commentFailure(entry, result.code, input.comment_id);
  return { id: input.comment_id, state: "deleted" };
}
