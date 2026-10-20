import { HANDLE_SHAPE, MAX_COMMENT_BODY_LENGTH, MAX_HANDLE_LENGTH } from "@fyrden/domain";
import { z } from "zod";
import { defineOperation } from "../src/op.js";
import { REPO_NAME_PATTERN } from "./repos.js";
import { ReactionRollup } from "./subject-meta.js";

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
// Kept as written (leading spaces are Markdown: indented code); only a blank one is refused.
const Body = z
  .string()
  .max(MAX_COMMENT_BODY_LENGTH)
  .refine((body) => body.trim().length > 0, "The body is blank.");

export const Comment = z.object({
  id: z.number().int(),
  issue_number: z.number().int().describe("The issue or pull request it is on."),
  user: z
    .object({ id: z.string() })
    .describe("Who wrote it (the user, when agents acted for one)."),
  performed_via_agents: z
    .array(z.string())
    .describe("Fyrden: the agents that wrote it for `user`, the acting one first; empty if none."),
  body: z.string(),
  created_at: z.number().int().describe("Unix time in milliseconds."),
  updated_at: z.number().int().describe("Unix time in milliseconds."),
  reactions: ReactionRollup,
});

export const listComments = defineOperation({
  id: "issues.comments.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/issues/{issue_number}/comments",
  summary: "List comments",
  description:
    "An issue's or pull request's conversation comments, oldest first, for a caller that may read that kind (`issues:read` or `pull_requests:read`).",
  input: z.object({
    ...RepoInput,
    issue_number: IssueNumber,
    per_page: z.coerce.number().int().min(1).max(100).default(30).describe("Page size, 1-100."),
    cursor: z.string().max(200).optional().describe("From a previous page's `next_cursor`."),
  }),
  output: z.object({
    comments: z.array(Comment),
    next_cursor: z
      .string()
      .nullable()
      .describe("Pass as `cursor` for the next page; null on the last page."),
  }),
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_comments",
    title: "List comments",
    description: "List the conversation comments of an issue or pull request.",
    readOnly: true,
  },
});

export const createComment = defineOperation({
  id: "issues.comments.create",
  method: "POST",
  path: "/repos/{owner}/{repo}/issues/{issue_number}/comments",
  summary: "Create a comment",
  description:
    "Adds a comment to an issue's or pull request's conversation, open or closed. Anyone who can read the repository may comment, with the permission for that kind (`issues:write` or `pull_requests:write`); while the conversation is locked, only write access and above.",
  input: z.object({ ...RepoInput, issue_number: IssueNumber, body: Body }),
  output: Comment,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  mcp: {
    tool: "add_issue_comment",
    title: "Comment on an issue or pull request",
    description:
      "Add a comment to an issue's or pull request's conversation (anyone who can read the repository may, unless it is locked).",
    readOnly: false,
  },
});

export const getComment = defineOperation({
  id: "issues.comments.get",
  method: "GET",
  path: "/repos/{owner}/{repo}/issues/comments/{comment_id}",
  summary: "Get a comment",
  description:
    "One conversation comment, for a caller that may read its issue's or pull request's kind.",
  input: z.object({ ...RepoInput, comment_id: CommentId }),
  output: Comment,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: false,
});

export const updateComment = defineOperation({
  id: "issues.comments.update",
  method: "PATCH",
  path: "/repos/{owner}/{repo}/issues/comments/{comment_id}",
  summary: "Update a comment",
  description:
    "Replaces a comment's body. Its author may edit its own; write access and above, anyone's (only they while the conversation is locked). Takes the permission for its kind.",
  input: z.object({ ...RepoInput, comment_id: CommentId, body: Body }),
  output: Comment,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "update_comment",
    title: "Update a comment",
    description:
      "Replace the body of an issue or pull request comment: your own, or anyone's with write access.",
    readOnly: false,
  },
});

export const deleteComment = defineOperation({
  id: "issues.comments.delete",
  method: "DELETE",
  path: "/repos/{owner}/{repo}/issues/comments/{comment_id}",
  summary: "Delete a comment",
  description:
    "Deletes a comment. Its author may delete its own; write access and above, anyone's (only they while the conversation is locked). Takes the permission for its kind.",
  input: z.object({ ...RepoInput, comment_id: CommentId }),
  output: z.object({ id: z.number().int(), state: z.literal("deleted") }),
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "delete_comment",
    title: "Delete a comment",
    description:
      "Delete an issue or pull request comment: your own, or anyone's with write access.",
    readOnly: false,
  },
});
