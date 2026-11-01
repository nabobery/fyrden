import { HANDLE_SHAPE, MAX_HANDLE_LENGTH, REACTION_CONTENTS } from "@fyrden/domain";
import { z } from "zod";
import { defineOperation } from "../src/op.js";
import { REPO_NAME_PATTERN } from "./repos.js";

const RepoInput = {
  owner: z
    .string()
    .min(1)
    .max(MAX_HANDLE_LENGTH)
    .regex(HANDLE_SHAPE)
    .describe("The owner's handle."),
  repo: z.string().regex(REPO_NAME_PATTERN).describe("The repository's name."),
};
const IssueNumber = z.coerce
  .number()
  .int()
  .positive()
  .describe("The issue's or pull request's number.");
const CommentId = z.coerce.number().int().positive().describe("The comment's id.");
const ReactionId = z.coerce.number().int().positive().describe("The reaction's id.");
const Content = z.enum(REACTION_CONTENTS);

export const Reaction = z.object({
  id: z.number().int(),
  user: z.object({ id: z.string() }).describe("Who reacted (the user, when agents acted for one)."),
  performed_via_agents: z
    .array(z.string())
    .describe("Fyrden: the agents that reacted for `user`, the acting one first; empty if none."),
  content: Content,
  created_at: z.number().int().describe("Unix time in milliseconds."),
});

const Listing = {
  content: Content.optional().describe("Only reactions of this content."),
  per_page: z.coerce.number().int().min(1).max(100).default(30).describe("Page size, 1-100."),
  cursor: z.string().max(200).optional().describe("From a previous page's `next_cursor`."),
};
const Page = z.object({
  reactions: z.array(Reaction),
  next_cursor: z
    .string()
    .nullable()
    .describe("Pass as `cursor` for the next page; null on the last page."),
});
const Deleted = z.object({ id: z.number().int(), state: z.literal("deleted") });

const RULES =
  "Anyone who reads the repository reacts, once per content (posting it again answers the reaction it has: GitHub answers 200 for that, Fyrden 201); while the conversation is locked, write access and above. A reaction is taken back only by whoever made it (another's is not found).";
const EITHER =
  "Takes the permission for the kind it is on (`issues:*`, or `pull_requests:*` for a pull request).";

export const listIssueReactions = defineOperation({
  id: "reactions.issue.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/issues/{issue_number}/reactions",
  summary: "List reactions to an issue",
  description: `The reactions to an issue, oldest first. On an issue, or a pull request by its number. ${EITHER}`,
  input: z.object({ ...RepoInput, issue_number: IssueNumber, ...Listing }),
  output: Page,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_issue_reactions",
    title: "List reactions to an issue",
    description: "List the reactions to an issue.",
    readOnly: true,
  },
});

export const createIssueReaction = defineOperation({
  id: "reactions.issue.create",
  method: "POST",
  path: "/repos/{owner}/{repo}/issues/{issue_number}/reactions",
  summary: "React to an issue",
  description: `Reacts to an issue. ${RULES} On an issue, or a pull request by its number. ${EITHER}`,
  input: z.object({ ...RepoInput, issue_number: IssueNumber, content: Content }),
  output: Reaction,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  mcp: {
    tool: "add_issue_reaction",
    title: "React to an issue",
    description: "Add a reaction to an issue.",
    readOnly: false,
  },
});

export const deleteIssueReaction = defineOperation({
  id: "reactions.issue.delete",
  method: "DELETE",
  path: "/repos/{owner}/{repo}/issues/{issue_number}/reactions/{reaction_id}",
  summary: "Delete a reaction to an issue",
  description: `Takes the caller's own reaction to an issue back. Answers what was deleted (GitHub answers 204). On an issue, or a pull request by its number. ${EITHER}`,
  input: z.object({ ...RepoInput, issue_number: IssueNumber, reaction_id: ReactionId }),
  output: Deleted,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "delete_issue_reaction",
    title: "Delete a reaction to an issue",
    description: "Take your reaction to an issue back.",
    readOnly: false,
  },
});

export const listCommentReactions = defineOperation({
  id: "reactions.comment.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/issues/comments/{comment_id}/reactions",
  summary: "List reactions to a comment",
  description: `The reactions to a comment, oldest first. On a conversation comment of an issue or a pull request. ${EITHER}`,
  input: z.object({ ...RepoInput, comment_id: CommentId, ...Listing }),
  output: Page,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_comment_reactions",
    title: "List reactions to a comment",
    description: "List the reactions to a comment.",
    readOnly: true,
  },
});

export const createCommentReaction = defineOperation({
  id: "reactions.comment.create",
  method: "POST",
  path: "/repos/{owner}/{repo}/issues/comments/{comment_id}/reactions",
  summary: "React to a comment",
  description: `Reacts to a comment. ${RULES} On a conversation comment of an issue or a pull request. ${EITHER}`,
  input: z.object({ ...RepoInput, comment_id: CommentId, content: Content }),
  output: Reaction,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  mcp: {
    tool: "add_comment_reaction",
    title: "React to a comment",
    description: "Add a reaction to a comment.",
    readOnly: false,
  },
});

export const deleteCommentReaction = defineOperation({
  id: "reactions.comment.delete",
  method: "DELETE",
  path: "/repos/{owner}/{repo}/issues/comments/{comment_id}/reactions/{reaction_id}",
  summary: "Delete a reaction to a comment",
  description: `Takes the caller's own reaction to a comment back. Answers what was deleted (GitHub answers 204). On a conversation comment of an issue or a pull request. ${EITHER}`,
  input: z.object({ ...RepoInput, comment_id: CommentId, reaction_id: ReactionId }),
  output: Deleted,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "delete_comment_reaction",
    title: "Delete a reaction to a comment",
    description: "Take your reaction to a comment back.",
    readOnly: false,
  },
});

export const listReviewCommentReactions = defineOperation({
  id: "reactions.review_comment.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions",
  summary: "List reactions to a diff comment",
  description: `The reactions to a diff comment, oldest first. On a pull request's diff comment.`,
  input: z.object({ ...RepoInput, comment_id: CommentId, ...Listing }),
  output: Page,
  permission: "pull_requests:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_review_comment_reactions",
    title: "List reactions to a diff comment",
    description: "List the reactions to a diff comment.",
    readOnly: true,
  },
});

export const createReviewCommentReaction = defineOperation({
  id: "reactions.review_comment.create",
  method: "POST",
  path: "/repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions",
  summary: "React to a diff comment",
  description: `Reacts to a diff comment. ${RULES} On a pull request's diff comment.`,
  input: z.object({ ...RepoInput, comment_id: CommentId, content: Content }),
  output: Reaction,
  permission: "pull_requests:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  mcp: {
    tool: "add_review_comment_reaction",
    title: "React to a diff comment",
    description: "Add a reaction to a diff comment.",
    readOnly: false,
  },
});

export const deleteReviewCommentReaction = defineOperation({
  id: "reactions.review_comment.delete",
  method: "DELETE",
  path: "/repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions/{reaction_id}",
  summary: "Delete a reaction to a diff comment",
  description: `Takes the caller's own reaction to a diff comment back. Answers what was deleted (GitHub answers 204). On a pull request's diff comment.`,
  input: z.object({ ...RepoInput, comment_id: CommentId, reaction_id: ReactionId }),
  output: Deleted,
  permission: "pull_requests:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "delete_review_comment_reaction",
    title: "Delete a reaction to a diff comment",
    description: "Take your reaction to a diff comment back.",
    readOnly: false,
  },
});
