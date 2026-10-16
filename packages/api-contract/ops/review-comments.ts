import { HANDLE_SHAPE, MAX_COMMENT_BODY_LENGTH, MAX_HANDLE_LENGTH } from "@fyrden/domain";
import { z } from "zod";
import { defineOperation } from "../src/op.js";
import { CommitObject } from "./browse.js";
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
const PullNumber = z.coerce.number().int().positive().describe("The pull request's number.");
const CommentId = z.coerce.number().int().positive().describe("The comment's id.");
const ThreadId = z.coerce.number().int().positive().describe("The thread's id.");
const Line = z.number().int().positive();
// Kept as written (leading spaces are Markdown: indented code); only a blank one is refused.
const Body = z
  .string()
  .max(MAX_COMMENT_BODY_LENGTH)
  .refine((body) => body.trim().length > 0, "The body is blank.");
const Side = z.enum(["LEFT", "RIGHT"]);
const NextCursor = z
  .string()
  .nullable()
  .describe("Pass as `cursor` for the next page; null on the last page.");

export const ReviewComment = z.object({
  id: z.number().int(),
  pull_request_review_id: z
    .number()
    .int()
    .nullable()
    .describe("Always null: comments are not part of a review yet."),
  in_reply_to_id: z.number().int().optional().describe("The comment this one answers."),
  thread_id: z.number().int().describe("Fyrden: the thread it is in."),
  user: z
    .object({ id: z.string() })
    .describe("Who wrote it (the user, when agents acted for one)."),
  performed_via_agents: z
    .array(z.string())
    .describe("Fyrden: the agents that wrote it for `user`, the acting one first; empty if none."),
  body: z.string(),
  commit_id: z.string().describe("The head the thread was started on."),
  original_commit_id: z.string(),
  path: z.string(),
  side: Side.describe("`RIGHT`: the head's file; `LEFT`: the merge base's."),
  line: z
    .number()
    .int()
    .nullable()
    .describe("The line commented on; null once the head has moved (`outdated`)."),
  original_line: z.number().int(),
  start_line: z.number().int().nullable().describe("The first line, for a range."),
  start_side: Side.nullable(),
  outdated: z
    .boolean()
    .describe("Fyrden: the head has moved since: the lines are those of `commit_id`."),
  resolved: z.boolean().describe("Fyrden: its thread is resolved."),
  created_at: z.number().int().describe("Unix time in milliseconds."),
  updated_at: z.number().int().describe("Unix time in milliseconds."),
});

export const ReviewThread = z.object({
  id: z.number().int(),
  path: z.string(),
  side: Side,
  line: z.number().int(),
  start_line: z.number().int().nullable(),
  commit_id: z.string(),
  outdated: z.boolean(),
  resolved: z.boolean(),
  resolved_by: z.object({ id: z.string() }).nullable(),
  comments: z.number().int().describe("Its comments now."),
});

export const listReviewComments = defineOperation({
  id: "pulls.comments.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/pulls/{pull_number}/comments",
  summary: "List review comments",
  description: "The comments on a pull request's diff, oldest first.",
  input: z.object({
    ...RepoInput,
    pull_number: PullNumber,
    per_page: z.coerce.number().int().min(1).max(100).default(30).describe("Page size, 1-100."),
    cursor: z.string().max(200).optional().describe("From a previous page's `next_cursor`."),
  }),
  output: z.object({ comments: z.array(ReviewComment), next_cursor: NextCursor }),
  permission: "pull_requests:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_review_comments",
    title: "List review comments",
    description: "List the comments on a pull request's diff, with their threads.",
    readOnly: true,
  },
});

export const createReviewComment = defineOperation({
  id: "pulls.comments.create",
  method: "POST",
  path: "/repos/{owner}/{repo}/pulls/{pull_number}/comments",
  summary: "Create a review comment",
  description:
    "Comments on lines of a file in a pull request's diff, starting a thread; with `in_reply_to`, replies in that comment's thread instead (no anchor then). `commit_id` must be a head the pull request has had; `side` RIGHT comments on that commit's file, LEFT on the merge base's; the file must have the lines (whether they are part of the diff is not checked). Anyone who can read the repository may comment.",
  input: z.object({
    ...RepoInput,
    pull_number: PullNumber,
    body: Body,
    in_reply_to: z.number().int().positive().optional().describe("A comment to reply to."),
    commit_id: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional()
      .describe("The head the lines are of; needed unless replying."),
    path: z.string().min(1).max(4096).optional().describe("The file; needed unless replying."),
    line: Line.optional().describe("The (last) line; needed unless replying."),
    side: Side.default("RIGHT"),
    start_line: Line.optional().describe("The first line, for a range."),
    start_side: Side.optional().describe("As `side`; a range stays on one side."),
  }),
  output: ReviewComment,
  permission: "pull_requests:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  mcp: {
    tool: "comment_on_diff",
    title: "Comment on a pull request's diff",
    description:
      "Comment on lines of a file in a pull request's diff (starting a thread), or reply in a thread.",
    readOnly: false,
  },
});

export const getReviewComment = defineOperation({
  id: "pulls.comments.get",
  method: "GET",
  path: "/repos/{owner}/{repo}/pulls/comments/{comment_id}",
  summary: "Get a review comment",
  description: "One comment on a pull request's diff.",
  input: z.object({ ...RepoInput, comment_id: CommentId }),
  output: ReviewComment,
  permission: "pull_requests:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: false,
});

export const updateReviewComment = defineOperation({
  id: "pulls.comments.update",
  method: "PATCH",
  path: "/repos/{owner}/{repo}/pulls/comments/{comment_id}",
  summary: "Update a review comment",
  description:
    "Replaces a diff comment's body. Its author may edit its own; write access and above, anyone's.",
  input: z.object({ ...RepoInput, comment_id: CommentId, body: Body }),
  output: ReviewComment,
  permission: "pull_requests:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: false,
});

export const deleteReviewComment = defineOperation({
  id: "pulls.comments.delete",
  method: "DELETE",
  path: "/repos/{owner}/{repo}/pulls/comments/{comment_id}",
  summary: "Delete a review comment",
  description:
    "Deletes a diff comment; its thread goes with its last comment. Its author may delete its own; write access and above, anyone's.",
  input: z.object({ ...RepoInput, comment_id: CommentId }),
  output: z.object({ id: z.number().int(), state: z.literal("deleted") }),
  permission: "pull_requests:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: false,
});

export const listReviewThreads = defineOperation({
  id: "pulls.threads.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/pulls/{pull_number}/threads",
  summary: "List review threads",
  description: "Fyrden: a pull request's review threads, oldest first, resolved or not.",
  input: z.object({
    ...RepoInput,
    pull_number: PullNumber,
    per_page: z.coerce.number().int().min(1).max(100).default(30).describe("Page size, 1-100."),
    cursor: z.string().max(200).optional().describe("From a previous page's `next_cursor`."),
  }),
  output: z.object({ threads: z.array(ReviewThread), next_cursor: NextCursor }),
  permission: "pull_requests:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: false,
});

const resolution = (resolved: boolean) =>
  ({
    input: z.object({ ...RepoInput, pull_number: PullNumber, thread_id: ThreadId }),
    output: ReviewThread,
    permission: "pull_requests:write",
    principals: ["user", "agent"],
    rateLimit: "write",
    idempotency: "key",
    description: `Fyrden: marks a review thread ${resolved ? "resolved" : "unresolved"} (nothing changes when it already is). The pull request's author, or write access and above. A ruleset may require every thread resolved before a merge.`,
  }) as const;

export const resolveReviewThread = defineOperation({
  id: "pulls.threads.resolve",
  method: "PUT",
  path: "/repos/{owner}/{repo}/pulls/{pull_number}/threads/{thread_id}/resolution",
  summary: "Resolve a review thread",
  ...resolution(true),
  mcp: {
    tool: "resolve_thread",
    title: "Resolve a review thread",
    description: "Mark a pull request's review thread resolved.",
    readOnly: false,
  },
});

export const unresolveReviewThread = defineOperation({
  id: "pulls.threads.unresolve",
  method: "DELETE",
  path: "/repos/{owner}/{repo}/pulls/{pull_number}/threads/{thread_id}/resolution",
  summary: "Unresolve a review thread",
  ...resolution(false),
  mcp: false,
});

export const applySuggestions = defineOperation({
  id: "pulls.suggestions.apply",
  method: "POST",
  path: "/repos/{owner}/{repo}/pulls/{pull_number}/suggestions/apply",
  summary: "Apply suggestions",
  description:
    "Fyrden: applies the suggested changes of diff comments (a ```suggestion block each) to the pull request's head branch as one commit, made and signed by the server, with the suggestions' authors as co-authors; their threads are resolved. Each comment must be on the head side at the current head; suggestions to one file must not overlap; files of 1 MiB at most. Write access; the branch's rulesets apply, and it moves only from the head the comments are on (409 `head_moved`). A head branch in a fork is written there: the caller needs write access to the fork, or the pull request's `maintainer_can_modify` (the author still writing the fork); that repository's rulesets apply.",
  input: z.object({
    ...RepoInput,
    pull_number: PullNumber,
    comment_ids: z
      .array(z.number().int().positive())
      .min(1)
      .max(50)
      .describe("The comments whose suggestions to apply, 1-50."),
    commit_message: z
      .string()
      .max(65_536)
      .optional()
      .describe("By default `Apply suggestions from code review`."),
  }),
  output: z.object({
    branch: z.string(),
    commit: CommitObject,
    files: z.array(z.object({ path: z.string(), sha: z.string().nullable() })),
  }),
  permission: "contents:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  mcp: {
    tool: "apply_suggestions",
    title: "Apply suggestions",
    description:
      "Apply suggested changes from a pull request's diff comments to its head branch as one commit.",
    readOnly: false,
  },
});
