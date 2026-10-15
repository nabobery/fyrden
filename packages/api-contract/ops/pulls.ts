import { HANDLE_PATTERN, MAX_PULL_BODY_LENGTH, MAX_PULL_TITLE_LENGTH } from "@fyrden/domain";
import { z } from "zod";
import { defineOperation } from "../src/op.js";
import { REPO_NAME_PATTERN } from "./repos.js";

const RepoInput = {
  owner: z.string().regex(HANDLE_PATTERN).describe("The owner's handle."),
  repo: z.string().regex(REPO_NAME_PATTERN).describe("The repository's name."),
};
const PullNumber = z.coerce.number().int().positive().describe("The pull request's number.");
const Branch = z
  .string()
  .min(1)
  .max(1024 - "refs/heads/".length)
  .describe("A branch of the repository, without the refs/heads/ prefix.");
const Title = z.string().trim().min(1).max(MAX_PULL_TITLE_LENGTH);
const Body = z.string().max(MAX_PULL_BODY_LENGTH);

const Side = z.object({
  ref: z.string().describe("The branch, without refs/heads/."),
  sha: z.string().describe("Its commit when last recorded."),
});

export const PullRequest = z.object({
  number: z.number().int(),
  state: z.enum(["open", "closed"]),
  merged: z.boolean(),
  draft: z.boolean(),
  title: z.string(),
  body: z.string().nullable(),
  user: z
    .object({ id: z.string() })
    .describe("Who opened it (the user, when agents acted for one)."),
  performed_via_agents: z
    .array(z.string())
    .describe("Fyrden: the agents that opened it for `user`, the acting one first; empty if none."),
  head: Side.describe(
    "The branch with the changes. `refs/pull/{number}/head` points at `head.sha` and can be fetched.",
  ),
  base: Side.describe("The branch the changes are for."),
  head_ref_deleted: z
    .boolean()
    .describe(
      "Fyrden: the head branch was deleted; the pull request stays at its last head commit and cannot be reopened until the branch exists again.",
    ),
  created_at: z.number().int().describe("Unix time in milliseconds."),
  updated_at: z.number().int().describe("Unix time in milliseconds."),
  closed_at: z.number().int().nullable().describe("Unix time in milliseconds."),
});

export const listPulls = defineOperation({
  id: "pulls.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/pulls",
  summary: "List pull requests",
  description: "The repository's pull requests, newest first.",
  input: z.object({
    ...RepoInput,
    state: z.enum(["open", "closed", "all"]).default("open"),
    per_page: z.coerce.number().int().min(1).max(100).default(30).describe("Page size, 1-100."),
    cursor: z.string().max(200).optional().describe("From a previous page's `next_cursor`."),
  }),
  output: z.object({
    pull_requests: z.array(PullRequest),
    next_cursor: z
      .string()
      .nullable()
      .describe("Pass as `cursor` for the next page; null on the last page."),
  }),
  permission: "pull_requests:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_pull_requests",
    title: "List pull requests",
    description: "List a repository's pull requests, open ones by default.",
    readOnly: true,
  },
});

export const createPull = defineOperation({
  id: "pulls.create",
  method: "POST",
  path: "/repos/{owner}/{repo}/pulls",
  summary: "Create a pull request",
  description:
    "Proposes merging one branch of the repository into another. Anyone who can read the repository may open one. Refused when the head has no commits the base lacks, or when a pull request between the two branches is already open. While open, `refs/pull/{number}/head` follows the head branch.",
  input: z.object({
    ...RepoInput,
    title: Title,
    body: Body.optional(),
    head: Branch.describe("The branch with the changes, without refs/heads/."),
    base: Branch.describe("The branch to merge into, without refs/heads/."),
    draft: z.boolean().default(false).describe("Open it as a draft."),
  }),
  output: PullRequest,
  permission: "pull_requests:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  mcp: {
    tool: "create_pull_request",
    title: "Create a pull request",
    description: "Open a pull request from one branch of a repository into another.",
    readOnly: false,
  },
});

export const getPull = defineOperation({
  id: "pulls.get",
  method: "GET",
  path: "/repos/{owner}/{repo}/pulls/{pull_number}",
  summary: "Get a pull request",
  description: "One pull request.",
  input: z.object({ ...RepoInput, pull_number: PullNumber }),
  output: PullRequest,
  permission: "pull_requests:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_pull_request",
    title: "Get a pull request",
    description: "Get one pull request of a repository.",
    readOnly: true,
  },
});

export const updatePull = defineOperation({
  id: "pulls.update",
  method: "PATCH",
  path: "/repos/{owner}/{repo}/pulls/{pull_number}",
  summary: "Update a pull request",
  description:
    "Changes the title or body, retargets it onto another base branch, marks it a draft or ready, closes or reopens it; fields left out are kept, and all of it happens or none. The author may do any of it to its own pull request; on anyone else's, triage closes and reopens and write does the rest. Reopening needs the head branch to exist.",
  input: z.object({
    ...RepoInput,
    pull_number: PullNumber,
    title: Title.optional(),
    body: Body.nullable().optional().describe("Null clears it."),
    state: z.enum(["open", "closed"]).optional(),
    base: Branch.optional().describe("A new base branch, without refs/heads/."),
    draft: z.boolean().optional().describe("Fyrden: mark it a draft, or ready for review."),
  }),
  output: PullRequest,
  permission: "pull_requests:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "update_pull_request",
    title: "Update a pull request",
    description:
      "Edit, retarget, draft, close or reopen a pull request (your own, or others' as your role allows).",
    readOnly: false,
  },
});
