import { HANDLE_PATTERN } from "@fyrden/domain";
import { z } from "zod";
import { defineOperation } from "../src/op.js";
import { REPO_NAME_PATTERN } from "./repos.js";

const Owner = z.string().regex(HANDLE_PATTERN).describe("The owner's handle.");
const Repo = z.string().regex(REPO_NAME_PATTERN).describe("The repository's name.");
const Page = {
  per_page: z.coerce.number().int().min(1).max(100).default(30).describe("Page size, 1-100."),
  cursor: z.string().max(8_000).optional().describe("From a previous page's `next_cursor`."),
};
const NextCursor = z
  .string()
  .nullable()
  .describe("Pass as `cursor` for the next page; null on the last page.");
const Ref = z
  .string()
  .min(1)
  .max(1024)
  .describe("A branch, a tag, a full ref name (`refs/...`) or a full commit SHA.");
const Sha = z.string().describe("A full commit SHA (40 hex digits).");

const Person = z.object({
  name: z.string(),
  email: z.string(),
  date: z.string().describe("ISO 8601, UTC."),
});

/** A commit as GitHub's commits API shows it. */
export const CommitObject = z.object({
  sha: Sha,
  commit: z.object({
    message: z.string(),
    author: Person,
    committer: Person,
    tree: z.object({ sha: z.string() }),
    verification: z
      .object({
        verified: z.boolean(),
        reason: z
          .string()
          .describe(
            "`valid` (signed by a known key), `unsigned`, `unknown_key`, `bad_email` (a user's key, on a commit whose committer is not that user), `invalid`, `malformed_signature` or `unknown_signature_type`, as GitHub names them.",
          ),
        signature: z.string().nullable().describe("The armored signature."),
        payload: z
          .string()
          .nullable()
          .describe("What the signature covers: the commit without it."),
        verified_at: z.string().nullable(),
      })
      .describe(
        "Whether the commit is signed with a key Fyrden knows: the platform's key for commits it made (file writes, generated repositories), or a key a user added for commits whose committer is that user's no-reply address.",
      ),
  }),
  parents: z.array(z.object({ sha: Sha })),
});

const RefCommit = z.object({ sha: Sha });
const Protected = z
  .boolean()
  .describe(
    "Whether an active ruleset protects the branch (whoever asks; a bypass does not change it).",
  );
const Branch = z.object({ name: z.string(), commit: RefCommit, protected: Protected });

export const listBranches = defineOperation({
  id: "repos.branches.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/branches",
  summary: "List branches",
  description: "Lists a repository's branches by name, each with the commit it points to.",
  input: z.object({ owner: Owner, repo: Repo, ...Page }),
  output: z.object({ branches: z.array(Branch), next_cursor: NextCursor }),
  permission: "contents:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_branches",
    title: "List branches",
    description: "List a repository's branches and the commit each points to.",
    readOnly: true,
  },
});

export const getBranch = defineOperation({
  id: "repos.branches.get",
  method: "GET",
  path: "/repos/{owner}/{repo}/branches/{branch+}",
  summary: "Get a branch",
  description: "A branch and its latest commit. Branch names may contain slashes.",
  input: z.object({ owner: Owner, repo: Repo, branch: z.string().min(1).max(1024) }),
  output: z.object({ name: z.string(), commit: CommitObject, protected: Protected }),
  permission: "contents:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_branch",
    title: "Get a branch",
    description: "Get a branch and its latest commit.",
    readOnly: true,
  },
});

export const listTags = defineOperation({
  id: "repos.tags.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/tags",
  summary: "List tags",
  description:
    "Lists a repository's tags by name, each with the commit it points to (annotated tags are peeled; tags of other objects are not listed).",
  input: z.object({ owner: Owner, repo: Repo, ...Page }),
  output: z.object({
    tags: z.array(z.object({ name: z.string(), commit: RefCommit })),
    next_cursor: NextCursor,
  }),
  permission: "contents:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_tags",
    title: "List tags",
    description: "List a repository's tags and the commit each points to.",
    readOnly: true,
  },
});

export const listCommits = defineOperation({
  id: "repos.commits.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/commits",
  summary: "List commits",
  description:
    "The history from a branch, tag or commit (the default branch without `sha`), newest first, as `git log` lists it (unless commit dates go backwards: the order is by corrected commit date); with `path`, only commits that change that file or directory. A page can hold fewer commits than `per_page` and still have a next one.",
  input: z.object({
    owner: Owner,
    repo: Repo,
    sha: Ref.optional().describe("Where the history starts: a branch, tag or commit SHA."),
    path: z.string().min(1).max(4096).optional().describe("Only commits changing this path."),
    ...Page,
  }),
  output: z.object({ commits: z.array(CommitObject), next_cursor: NextCursor }),
  permission: "contents:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_commits",
    title: "List commits",
    description: "List a repository's history, optionally of one path.",
    readOnly: true,
  },
});

export const getCommit = defineOperation({
  id: "repos.commits.get",
  method: "GET",
  path: "/repos/{owner}/{repo}/commits/{ref+}",
  summary: "Get a commit",
  description: "One commit, named by its SHA or by a branch or tag.",
  input: z.object({ owner: Owner, repo: Repo, ref: Ref }),
  output: CommitObject,
  permission: "contents:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_commit",
    title: "Get a commit",
    description: "Get one commit by SHA, branch or tag.",
    readOnly: true,
  },
});

export const compareCommits = defineOperation({
  id: "repos.compare",
  method: "GET",
  path: "/repos/{owner}/{repo}/compare/{basehead+}",
  summary: "Compare two commits",
  description:
    "Compares `base...head` (branches, tags or SHAs): how far head is ahead of and behind base, their merge base, and the commits in head and not in base, oldest first (the newest 100). File differences are not included.",
  input: z.object({
    owner: Owner,
    repo: Repo,
    basehead: z.string().min(1).max(2051).describe("`base...head`."),
  }),
  output: z.object({
    status: z.enum(["identical", "ahead", "behind", "diverged"]),
    ahead_by: z.number().int(),
    behind_by: z.number().int(),
    total_commits: z.number().int(),
    base_commit: CommitObject,
    merge_base_commit: CommitObject.nullable(),
    commits: z.array(CommitObject),
  }),
  permission: "contents:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "compare_commits",
    title: "Compare two commits",
    description: "Compare two branches, tags or commits: ahead, behind, merge base and commits.",
    readOnly: true,
  },
});
