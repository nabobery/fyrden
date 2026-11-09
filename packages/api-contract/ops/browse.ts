import { HANDLE_SHAPE, MAX_HANDLE_LENGTH } from "@fyrden/domain";
import { z } from "zod";
import { defineOperation } from "../src/op.js";
import { REPO_NAME_PATTERN } from "./repos.js";

const Owner = z
  .string()
  .min(1)
  .max(MAX_HANDLE_LENGTH)
  .regex(HANDLE_SHAPE)
  .describe("The owner's handle.");
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

/** Why a line has no answer, in the blame engine's order (a checkpoint stores the position). */
export const UNRESOLVED_REASONS = [
  "parent_too_large",
  "too_many_parents",
  "diff_budget",
  "slide_unsettled",
  "object_limit",
  "work_limit",
  "history_unreadable",
  "history_missing",
  "history_limit",
  "state_limit",
  "commit_info_too_large",
  "rename_possible",
  "step_lost",
] as const;

const MAX_WINDOW_LINES = 5_000;
const LineNumber = z.coerce.number().int().min(1);

const BlameRange = z.union([
  z.object({
    start_line: z.number().int().describe("The range's first line in this file, from 1."),
    line_count: z.number().int(),
    commit: Sha.describe("The commit that introduced these lines."),
    source_start_line: z
      .number()
      .int()
      .describe("The first line's number in that commit's version of the file, from 1."),
  }),
  z.object({
    start_line: z.number().int(),
    line_count: z.number().int(),
    unresolved: z
      .enum(UNRESOLVED_REASONS)
      .describe("Why these lines have no answer. Not a failure: the rest of the blame stands."),
  }),
]);

const BlameCommit = z.object({
  summary: z
    .string()
    .describe("The commit message's first line that isn't blank, as git blame gives it."),
  author: z.object({
    name: z.string(),
    email: z.string(),
    date: z
      .string()
      .describe(
        "The author time as git prints it: epoch seconds and offset, such as `1700000000 +0100`. Exact for any time git holds.",
      ),
  }),
});

export const getBlame = defineOperation({
  id: "repos.blame.get",
  method: "GET",
  path: "/repos/{owner}/{repo}/blame",
  summary: "Blame a file",
  description:
    "Which commit introduced each line of a file, at a branch, tag or commit (the default branch without `ref`), as `git blame` says, or why a line has no answer (`unresolved`, with its reason). Renames aren't followed: wherever git would or might follow one, the lines are `unresolved`. That's usually `rename_possible`, possibly an earlier reason such as `parent_too_large`. `rename_possible` is given where a parent lacks the file and its change removes another path, or, in a merge, where a parent might hold an identical copy under another name, or where checking that costs too much. A file is blamed in slices across requests: pass `next_continuation` back as `continuation` until it is null, whatever `state` says, since a finished blame can still have ranges to page through. Ranges come in the order they were settled, not in line order. With `line_start` and `line_end` (at most 5,000 lines apart), the ranges over those lines come in line order, clipped, with no continuation; follow-up windows should name the returned `commit`, not the ref. `blame_busy` (503) carries `retry_after`: wait that long and ask again, and the blame resumes where it was. The 422 refusals (`file_too_large`, `object_limit`, `work_limit`, `ref_unreadable`) are final for that commit and path.",
  input: z
    .object({
      owner: Owner,
      repo: Repo,
      path: z.string().min(1).max(4096).describe("The file's path in the repository."),
      ref: Ref.optional().describe("A branch, tag or commit SHA; the default branch without it."),
      continuation: z
        .string()
        .max(1024)
        .optional()
        .describe("A previous answer's `next_continuation`."),
      per_page: z.coerce
        .number()
        .int()
        .min(1)
        .max(5000)
        .default(1000)
        .describe("Most ranges in one answer, 1-5000."),
      line_start: LineNumber.optional().describe("A window's first line, from 1."),
      line_end: LineNumber.optional().describe("A window's last line."),
    })
    .refine(
      (input) =>
        (input.line_start === undefined) === (input.line_end === undefined) &&
        (input.line_start === undefined ||
          input.line_end === undefined ||
          (input.line_end >= input.line_start &&
            input.line_end - input.line_start < MAX_WINDOW_LINES)),
      {
        message: "A window needs both line_start and line_end, in order, at most 5,000 lines.",
        path: ["line_end"],
      },
    ),
  output: z.object({
    commit: Sha.describe("The commit blamed: the ref, resolved."),
    path: z.string(),
    blob: Sha.describe("The file's blob at that commit."),
    lines: z.number().int(),
    state: z
      .enum(["complete", "partial"])
      .describe("`complete` once every line is settled or refused; a partial blame continues."),
    resolved_lines: z.number().int(),
    unresolved_lines: z.number().int(),
    pending_lines: z.number().int(),
    ranges: z.array(BlameRange),
    commits: z.record(Sha, BlameCommit).describe("The facts of the commits these ranges name."),
    next_continuation: z
      .string()
      .nullable()
      .describe(
        "Pass as `continuation`; null only when the blame is complete and read to the end.",
      ),
    retry_after_seconds: z
      .number()
      .int()
      .optional()
      .describe(
        "Too little of this request was left to walk on: ask again after this many seconds.",
      ),
  }),
  permission: "contents:read",
  principals: ["user", "agent"],
  rateLimit: "expensive",
  idempotency: "none",
  mcp: {
    tool: "get_blame",
    title: "Blame a file",
    description:
      "Which commit introduced each line of a file. Pass `next_continuation` back until it is null; `unresolved` lines aren't failures; on `blame_busy` wait `retry_after` seconds; name the returned `commit` in follow-up windows.",
    readOnly: true,
  },
});
