import { HANDLE_PATTERN, MAX_PULL_BODY_LENGTH, MAX_PULL_TITLE_LENGTH } from "@fyrden/domain";
import { z } from "zod";
import { defineOperation } from "../src/op.js";
import { CommitObject } from "./browse.js";
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
  head_repo_id: z
    .string()
    .nullable()
    .describe(
      "Fyrden: the repository the head branch is in (a fork in the same network); null for this one.",
    ),
  mergeable: z
    .boolean()
    .nullable()
    .describe(
      "Whether the head merges into the base branch's tip without conflicts; null while it is worked out (in the background, after each change of either) and once closed. Rulesets are not part of it: they are checked when merging.",
    ),
  mergeable_state: z
    .enum(["clean", "dirty", "draft", "unknown"])
    .describe(
      "`clean`: no conflicts (rulesets are checked when merging); `dirty`: conflicts; `draft`; `unknown`: not worked out yet, or too large to work out here.",
    ),
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
  merged_at: z.number().int().nullable().describe("Unix time in milliseconds."),
  merge_commit_sha: z
    .string()
    .nullable()
    .describe("Once merged, the commit the base branch moved to."),
  merged_by: z
    .object({ id: z.string() })
    .nullable()
    .describe("Who merged it (the user, when agents acted for one)."),
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
    "Proposes merging one branch of the repository into another. Anyone who can read the repository may open one. Refused when the head has no commits the base lacks, or when a pull request between the two branches is already open. While open, `refs/pull/{number}/head` follows the head branch. The head may be a branch of a fork in the same network (`owner:branch`): its revision is imported first, and later pushes to it reach the pull request shortly after.",
  input: z.object({
    ...RepoInput,
    title: Title,
    body: Body.optional(),
    head: z
      .string()
      .min(1)
      .max(1024)
      .describe(
        "The branch with the changes, without refs/heads/; `owner:branch` for a branch of that owner's repository in the base's fork network (a fork), which the caller must be able to read.",
      ),
    head_repo: z
      .string()
      .regex(REPO_NAME_PATTERN)
      .optional()
      .describe(
        "With `owner:branch`, the repository's name, when the owner has several in the network.",
      ),
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

const PullFile = z.object({
  sha: z.string().describe("The file's blob on the head side (the removed blob for a removal)."),
  filename: z.string(),
  previous_filename: z.string().optional().describe("For a renamed file, where it was."),
  status: z
    .enum(["added", "removed", "modified", "renamed", "changed"])
    .describe("`changed` is a change of mode or kind only."),
  additions: z.number().int(),
  deletions: z.number().int(),
  changes: z.number().int(),
  patch: z
    .string()
    .optional()
    .describe("The file's hunks as unified diff text; left out when `patch_omitted` says why."),
  patch_omitted: z
    .enum(["binary", "too_large", "patch_too_large", "submodule", "budget"])
    .optional()
    .describe(
      "Fyrden: why there is no patch: a binary file, a side over 1 MiB (or too many lines), a patch over 64 KiB, a submodule, or this page's read budget (ask for a smaller page).",
    ),
  approximate: z
    .boolean()
    .optional()
    .describe(
      "Fyrden: true when the hunks are right but not the shortest (comparing cost too much).",
    ),
});

export const listPullFiles = defineOperation({
  id: "pulls.files.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/pulls/{pull_number}/files",
  summary: "List pull request files",
  description:
    "The files a pull request changes, compared from the merge base of its base branch and head to its head (as GitHub's three-dot comparison), in path order, with each file's patch. At most 3,000 files are listed; renames with unchanged content are found. Pages keep the comparison they started with: the cursor carries `merge_base_sha` and `head_sha`.",
  input: z.object({
    ...RepoInput,
    pull_number: PullNumber,
    per_page: z.coerce.number().int().min(1).max(100).default(30).describe("Page size, 1-100."),
    cursor: z.string().max(400).optional().describe("From a previous page's `next_cursor`."),
  }),
  output: z.object({
    files: z.array(PullFile),
    merge_base_sha: z.string(),
    head_sha: z.string(),
    truncated: z.boolean().describe("More than 3,000 files changed: the listing stops there."),
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
    tool: "list_pull_request_files",
    title: "List pull request files",
    description: "List the files a pull request changes, with each file's diff.",
    readOnly: true,
  },
});

export const listPullCommits = defineOperation({
  id: "pulls.commits.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/pulls/{pull_number}/commits",
  summary: "List pull request commits",
  description:
    "The commits a pull request's head has that its base branch does not, oldest first; at most 250 (GitHub's limit).",
  input: z.object({
    ...RepoInput,
    pull_number: PullNumber,
    per_page: z.coerce.number().int().min(1).max(100).default(30).describe("Page size, 1-100."),
    cursor: z.string().max(200).optional().describe("From a previous page's `next_cursor`."),
  }),
  output: z.object({
    commits: z.array(CommitObject),
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
    tool: "list_pull_request_commits",
    title: "List pull request commits",
    description: "List the commits of a pull request, oldest first.",
    readOnly: true,
  },
});

export const mergePull = defineOperation({
  id: "pulls.merge",
  method: "PUT",
  path: "/repos/{owner}/{repo}/pulls/{pull_number}/merge",
  summary: "Merge a pull request",
  description:
    "Merges an open pull request that is not a draft into its base branch: `merge` makes a merge commit of the base branch's tip and the head, `squash` one commit on the base branch with the head's changes (by the pull request's author). The commit is made and signed by the server; the base branch's rulesets apply, with the pull request's reviews and last push. Refused (405) on conflicts, or when the base branch moved while merging; refused (409) when `sha` is not the head. `rebase` replays the pull request's commits (at most 250, none a merge commit) one by one onto the base branch's tip and moves the branch to the last: their authors, author dates and messages are kept, the server is their committer and signs each. Empty commits follow `git rebase`: a commit empty from the start is kept, one whose changes are already in the base is dropped; a commit the base changed further, or a rename in the base of a file the pull request edits, is a conflict. A rebase too long for one request answers 409 `merge_in_progress` and goes on in the background: send the request again (a finished rebase answers its merge) or watch the pull request.",
  input: z.object({
    ...RepoInput,
    pull_number: PullNumber,
    commit_title: z
      .string()
      .min(1)
      .max(1024)
      .optional()
      .describe(
        "The commit's first line; GitHub's default for the method when left out (`Merge pull request #n from owner/branch`, or the title and number).",
      ),
    commit_message: z
      .string()
      .max(MAX_PULL_BODY_LENGTH)
      .optional()
      .describe(
        "The commit's message after its title; by default the pull request's title (merge) or body (squash).",
      ),
    sha: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional()
      .describe("The head the pull request must be at: the merge is refused otherwise."),
    merge_method: z.enum(["merge", "squash", "rebase"]).default("merge"),
  }),
  output: z.object({
    sha: z.string().describe("The commit the base branch now points at."),
    merged: z.boolean(),
    message: z.string(),
  }),
  permission: "contents:write",
  principals: ["user", "agent"],
  rateLimit: "expensive",
  idempotency: "key",
  mcp: {
    tool: "merge_pull_request",
    title: "Merge a pull request",
    description:
      "Merge an open pull request into its base branch: with a merge commit, squashed into one commit, or rebased onto it (a long rebase answers merge_in_progress and finishes in the background; call again for its result).",
    readOnly: false,
  },
});
