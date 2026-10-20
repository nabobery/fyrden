import {
  HANDLE_SHAPE,
  ISSUE_STATE_REASONS,
  LOCK_REASONS,
  MAX_ASSIGNEES,
  MAX_HANDLE_LENGTH,
  MAX_ISSUE_BODY_LENGTH,
  MAX_ISSUE_TITLE_LENGTH,
  MAX_LABEL_NAME_LENGTH,
  MAX_SUBJECT_LABELS,
} from "@fyrden/domain";
import { z } from "zod";
import { defineOperation } from "../src/op.js";
import { REPO_NAME_PATTERN } from "./repos.js";
import { SortingOutput } from "./subject-meta.js";

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
  .describe("The issue's number (or a pull request's: they share one sequence).");
const Title = z.string().trim().min(1).max(MAX_ISSUE_TITLE_LENGTH);
const Body = z.string().max(MAX_ISSUE_BODY_LENGTH);
/** What issues and pull requests are sorted by, as the issue endpoints set them. */
const SortingInput = {
  labels: z
    .array(z.string().min(1).max(MAX_LABEL_NAME_LENGTH))
    .max(MAX_SUBJECT_LABELS)
    .optional()
    .describe("Label names (ignoring case), each one the repository has; replaces its labels."),
  assignees: z
    .array(z.string().min(1).max(MAX_HANDLE_LENGTH).regex(HANDLE_SHAPE))
    .max(MAX_ASSIGNEES)
    .optional()
    .describe("Handles of users and agents who can read the repository; replaces its assignees."),
  milestone: z.coerce
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe("A milestone's number; null takes it out of its milestone."),
};

export const Issue = z.object({
  id: z.number().int().describe("Fyrden: the number again (issues have no separate id space)."),
  number: z.number().int(),
  state: z.enum(["open", "closed"]).describe("A merged pull request is `closed`."),
  state_reason: z
    .enum(ISSUE_STATE_REASONS)
    .nullable()
    .describe("Why it is in its state; null for one never closed, and for pull requests."),
  duplicate_of: z
    .number()
    .int()
    .nullable()
    .describe(
      "Fyrden: while closed as a duplicate, the issue or pull request it duplicates; null when there is none, or when the caller cannot read that one or it was deleted.",
    ),
  title: z.string(),
  body: z.string().nullable(),
  user: z
    .object({ id: z.string() })
    .describe("Who opened it (the user, when agents acted for one)."),
  performed_via_agents: z
    .array(z.string())
    .describe("Fyrden: the agents that opened it for `user`, the acting one first; empty if none."),
  locked: z.boolean(),
  active_lock_reason: z.enum(LOCK_REASONS).nullable(),
  closed_by: z
    .object({ id: z.string() })
    .nullable()
    .describe("Who closed it last, while closed; null for pull requests."),
  created_at: z.number().int().describe("Unix time in milliseconds."),
  updated_at: z.number().int().describe("Unix time in milliseconds."),
  closed_at: z.number().int().nullable().describe("Unix time in milliseconds."),
  ...SortingOutput,
  pull_request: z
    .object({
      merged_at: z.number().int().nullable().describe("Unix time in milliseconds."),
    })
    .optional()
    .describe(
      "Present when this is a pull request (as GitHub's issue endpoints answer them); `pulls.get` has the rest.",
    ),
});

export const listIssues = defineOperation({
  id: "issues.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/issues",
  summary: "List issues",
  description:
    "The repository's issues and pull requests (marked with `pull_request`), as GitHub's issue listing; `type` narrows it to one kind. Each kind is listed only for a caller that may read it: issues need the `issues:read` permission, pull requests `pull_requests:read`. A listing sorted by `updated` may move an item changed between pages.",
  input: z.object({
    ...RepoInput,
    state: z.enum(["open", "closed", "all"]).default("open"),
    type: z
      .enum(["issues", "pulls"])
      .optional()
      .describe("Fyrden (as Gitea's): only issues, or only pull requests; both when left out."),
    sort: z.enum(["created", "updated"]).default("created"),
    direction: z.enum(["asc", "desc"]).default("desc"),
    per_page: z.coerce.number().int().min(1).max(100).default(30).describe("Page size, 1-100."),
    cursor: z
      .string()
      .max(400)
      .optional()
      .describe("From a previous page's `next_cursor`, with the same filters."),
  }),
  output: z.object({
    issues: z.array(Issue),
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
    tool: "list_issues",
    title: "List issues",
    description:
      "List a repository's issues (and pull requests, unless type is issues), open ones by default.",
    readOnly: true,
  },
});

export const createIssue = defineOperation({
  id: "issues.create",
  method: "POST",
  path: "/repos/{owner}/{repo}/issues",
  summary: "Create an issue",
  description:
    "Opens an issue. Anyone who can read the repository may; giving it labels, assignees or a milestone takes triage (refused without it, where GitHub drops them).",
  input: z.object({ ...RepoInput, title: Title, body: Body.optional(), ...SortingInput }),
  output: Issue,
  permission: "issues:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  mcp: {
    tool: "create_issue",
    title: "Create an issue",
    description: "Open an issue in a repository.",
    readOnly: false,
  },
});

export const getIssue = defineOperation({
  id: "issues.get",
  method: "GET",
  path: "/repos/{owner}/{repo}/issues/{issue_number}",
  summary: "Get an issue",
  description:
    "One issue, or a pull request by its number (marked with `pull_request`), for a caller that may read that kind.",
  input: z.object({ ...RepoInput, issue_number: IssueNumber }),
  output: Issue,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_issue",
    title: "Get an issue",
    description: "Get one issue (or pull request) of a repository by its number.",
    readOnly: true,
  },
});

export const updateIssue = defineOperation({
  id: "issues.update",
  method: "PATCH",
  path: "/repos/{owner}/{repo}/issues/{issue_number}",
  summary: "Update an issue",
  description:
    "Changes the title or body, closes or reopens it, marks it a duplicate, or sets its labels, assignees or milestone; fields left out are kept, and all of it happens or none. The author may edit, close and reopen its own issue; on anyone else's, triage closes and reopens, and write edits. Marking a duplicate (`state_reason: duplicate` with `duplicate_of`) and setting labels, assignees or the milestone take triage, the author's own issue included. As GitHub's, `state_reason` alone changes nothing unless the state changes, except moving a closed issue to or from `duplicate`. A pull request's number takes only labels, assignees and milestone (with `pull_requests:write`); its title, body and state change through `pulls.update`.",
  input: z.object({
    ...RepoInput,
    issue_number: IssueNumber,
    title: Title.optional(),
    body: Body.nullable().optional().describe("Null clears it."),
    state: z.enum(["open", "closed"]).optional(),
    state_reason: z
      .enum(ISSUE_STATE_REASONS)
      .nullable()
      .optional()
      .describe("Null is as leaving it out (GitHub's accepts null)."),
    duplicate_of: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Fyrden: with `state_reason: duplicate`, the issue or pull request this one duplicates; the caller must be able to read it.",
      ),
    ...SortingInput,
  }),
  output: Issue,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "update_issue",
    title: "Update an issue",
    description:
      "Edit, close, reopen or mark an issue a duplicate (your own, or others' as your role allows).",
    readOnly: false,
  },
});

const LockState = z.object({
  locked: z.boolean(),
  active_lock_reason: z.enum(LOCK_REASONS).nullable(),
});

export const lockIssue = defineOperation({
  id: "issues.lock",
  method: "PUT",
  path: "/repos/{owner}/{repo}/issues/{issue_number}/lock",
  summary: "Lock a conversation",
  description:
    "Locks an issue's or a pull request's conversation: from then on only write access and above may comment, or edit or delete comments. Takes write access, and the permission for that kind (`issues:write` or `pull_requests:write`). Answers the lock (GitHub answers 204).",
  input: z.object({
    ...RepoInput,
    issue_number: IssueNumber,
    lock_reason: z.enum(LOCK_REASONS).optional(),
  }),
  output: LockState,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "lock_conversation",
    title: "Lock a conversation",
    description: "Lock an issue's or pull request's conversation (write access).",
    readOnly: false,
  },
});

export const unlockIssue = defineOperation({
  id: "issues.unlock",
  method: "DELETE",
  path: "/repos/{owner}/{repo}/issues/{issue_number}/lock",
  summary: "Unlock a conversation",
  description:
    "Unlocks an issue's or a pull request's conversation. Takes write access, and the permission for that kind. Answers the lock (GitHub answers 204).",
  input: z.object({ ...RepoInput, issue_number: IssueNumber }),
  output: LockState,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "unlock_conversation",
    title: "Unlock a conversation",
    description: "Unlock an issue's or pull request's conversation (write access).",
    readOnly: false,
  },
});

export const deleteIssue = defineOperation({
  id: "issues.delete",
  method: "DELETE",
  path: "/repos/{owner}/{repo}/issues/{issue_number}",
  summary: "Delete an issue",
  description:
    "Fyrden (GitHub offers this through GraphQL only): deletes an issue and its comments for good; its number is never used again, and activity feeds stop showing it. Takes admin.",
  input: z.object({ ...RepoInput, issue_number: IssueNumber }),
  output: z.object({ number: z.number().int(), state: z.literal("deleted") }),
  permission: "issues:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "delete_issue",
    title: "Delete an issue",
    description: "Delete an issue and its comments for good (admin).",
    readOnly: false,
  },
});
