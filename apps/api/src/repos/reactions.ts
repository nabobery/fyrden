import type {
  createCommentReaction,
  createIssueReaction,
  createReviewCommentReaction,
  deleteCommentReaction,
  deleteIssueReaction,
  deleteReviewCommentReaction,
  Input,
  listCommentReactions,
  listIssueReactions,
  listReviewCommentReactions,
  Output,
} from "@fyrden/api-contract";
import type { ReactionTarget } from "@fyrden/domain";
import type { SubjectKind } from "../do/repo/issues.js";
import type { ReactionRecord } from "../do/repo/reactions.js";
import { repoFor } from "../git/chunked/operations.js";
import { decodeCursor, encodeCursor } from "../ops/cursor.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import type { RepoEntry } from "./directory.js";
import { actorOf, failure } from "./pulls.js";
import { sortingFailure } from "./sorting.js";
import { subjectAccess, subjectNotFound } from "./subjects.js";

/*
 * Reactions to issues and pull requests (by number) and their conversation
 * comments take the permission of the kind they are on, as comments do;
 * reactions to diff comments are pull requests' only.
 */

type Reaction = Output<typeof createIssueReaction>;
type Page = Output<typeof listIssueReactions>;

const repo = (ctx: OpContext, entry: RepoEntry, method: string) => {
  ctx.metrics.count("do.request", { class: "RepoDO", method });
  return ctx.env.REPO.getByName(entry.id);
};

function reactionOutput(reaction: ReactionRecord): Reaction {
  return {
    id: reaction.id,
    user: { id: reaction.principal },
    performed_via_agents: [...reaction.actChain],
    content: reaction.content,
    created_at: reaction.createdAt,
  };
}

/** What a target that is not there (or not the caller's kind) answers. */
function missing(target: ReactionTarget, id: number): OperationError {
  return target === "subject"
    ? subjectNotFound(id)
    : new OperationError(404, "comment_not_found", `The repository has no comment ${id}.`);
}

function reactionFailure(
  entry: RepoEntry,
  target: ReactionTarget,
  id: number,
  code: string,
): OperationError {
  switch (code) {
    case "not_found":
      return missing(target, id);
    case "reaction_not_found":
      return new OperationError(404, "reaction_not_found", "You have no such reaction here.");
    case "forbidden":
      return new OperationError(403, "forbidden", "Reacting takes read access.");
    case "locked":
      return new OperationError(
        403,
        "conversation_locked",
        "The conversation is locked: only write access and above react.",
      );
    default:
      return sortingFailure(code) ?? failure(entry, code);
  }
}

/** The repository and the kinds the caller may act on, for a target of `target`. */
async function access(
  ctx: OpContext,
  input: { owner: string; repo: string },
  target: ReactionTarget,
  purpose: "read" | "write",
): Promise<{ entry: RepoEntry; kinds: SubjectKind[] }> {
  if (target !== "review_comment") return subjectAccess(ctx, input.owner, input.repo, purpose);
  const entry = await repoFor(
    ctx,
    input.owner,
    input.repo,
    purpose === "read" ? "pull_requests:read" : "pull_requests:write",
  );
  return { entry, kinds: ["pull"] };
}

async function list(
  ctx: OpContext,
  input: {
    owner: string;
    repo: string;
    content?: Reaction["content"] | undefined;
    per_page: number;
    cursor?: string | undefined;
  },
  target: ReactionTarget,
  targetId: number,
): Promise<Page> {
  const { entry, kinds } = await access(ctx, input, target, "read");
  // The cursor is the last reaction's id.
  const after = decodeCursor(input.cursor, (n) => /^[1-9][0-9]{0,15}$/.test(n));
  const reactions = await repo(ctx, entry, "listReactions").listReactions(
    target,
    targetId,
    input.content ?? null,
    after === "" ? 0 : Number(after),
    input.per_page + 1,
    kinds,
  );
  if (reactions === null) throw failure(entry, "repo_not_found");
  if (!reactions) throw missing(target, targetId);
  const page = reactions.slice(0, input.per_page);
  const last = page.at(-1);
  return {
    reactions: page.map(reactionOutput),
    next_cursor: reactions.length > input.per_page && last ? encodeCursor(String(last.id)) : null,
  };
}

async function create(
  ctx: OpContext,
  input: { owner: string; repo: string; content: Reaction["content"] },
  target: ReactionTarget,
  targetId: number,
): Promise<Reaction> {
  const { entry, kinds } = await access(ctx, input, target, "write");
  const result = await repo(ctx, entry, "createReaction").createReaction(
    target,
    targetId,
    input.content,
    actorOf(ctx),
    kinds,
  );
  if (!result.ok) throw reactionFailure(entry, target, targetId, result.code);
  return reactionOutput(result.reaction);
}

async function remove(
  ctx: OpContext,
  input: { owner: string; repo: string; reaction_id: number },
  target: ReactionTarget,
  targetId: number,
): Promise<{ id: number; state: "deleted" }> {
  const { entry, kinds } = await access(ctx, input, target, "write");
  const result = await repo(ctx, entry, "deleteReaction").deleteReaction(
    target,
    targetId,
    input.reaction_id,
    actorOf(ctx),
    kinds,
  );
  if (!result.ok) throw reactionFailure(entry, target, targetId, result.code);
  return { id: input.reaction_id, state: "deleted" };
}

/** The `reactions.issue.list` operation. */
export const listIssueReactionsOperation = (
  ctx: OpContext,
  input: Input<typeof listIssueReactions>,
) => list(ctx, input, "subject", input.issue_number);

/** The `reactions.issue.create` operation. */
export const createIssueReactionOperation = (
  ctx: OpContext,
  input: Input<typeof createIssueReaction>,
) => create(ctx, input, "subject", input.issue_number);

/** The `reactions.issue.delete` operation. */
export const deleteIssueReactionOperation = (
  ctx: OpContext,
  input: Input<typeof deleteIssueReaction>,
) => remove(ctx, input, "subject", input.issue_number);

/** The `reactions.comment.list` operation. */
export const listCommentReactionsOperation = (
  ctx: OpContext,
  input: Input<typeof listCommentReactions>,
) => list(ctx, input, "comment", input.comment_id);

/** The `reactions.comment.create` operation. */
export const createCommentReactionOperation = (
  ctx: OpContext,
  input: Input<typeof createCommentReaction>,
) => create(ctx, input, "comment", input.comment_id);

/** The `reactions.comment.delete` operation. */
export const deleteCommentReactionOperation = (
  ctx: OpContext,
  input: Input<typeof deleteCommentReaction>,
) => remove(ctx, input, "comment", input.comment_id);

/** The `reactions.review_comment.list` operation. */
export const listReviewCommentReactionsOperation = (
  ctx: OpContext,
  input: Input<typeof listReviewCommentReactions>,
) => list(ctx, input, "review_comment", input.comment_id);

/** The `reactions.review_comment.create` operation. */
export const createReviewCommentReactionOperation = (
  ctx: OpContext,
  input: Input<typeof createReviewCommentReaction>,
) => create(ctx, input, "review_comment", input.comment_id);

/** The `reactions.review_comment.delete` operation. */
export const deleteReviewCommentReactionOperation = (
  ctx: OpContext,
  input: Input<typeof deleteReviewCommentReaction>,
) => remove(ctx, input, "review_comment", input.comment_id);
