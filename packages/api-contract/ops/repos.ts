import { HANDLE_PATTERN, MAX_DESCRIPTION_LENGTH } from "@fyrden/domain";
import { z } from "zod";
import { defineOperation } from "../src/op.js";

/**
 * Repository names as GitHub accepts them: 1-100 letters, digits, `.`, `_`
 * and `-`; not `.` or `..`; not ending in `.git`, ignoring case (git URLs
 * strip that suffix, so such a name could not be addressed).
 */
export const REPO_NAME_PATTERN = /^(?!\.{1,2}$)(?!.*\.[Gg][Ii][Tt]$)[A-Za-z0-9._-]{1,100}$/;

const RepoName = z
  .string()
  .regex(REPO_NAME_PATTERN)
  .describe(
    "1-100 letters, digits, '.', '_' and '-'; not '.' or '..'; must not end in '.git'. Unique per owner, ignoring case.",
  );

export const Repo = z.object({
  id: z.string().describe("Immutable repository id (rep_ prefix)."),
  owner: z.string().describe("The owner's handle."),
  name: z.string(),
  full_name: z.string().describe("owner/name"),
  visibility: z.enum(["public", "internal", "private"]),
  description: z.string().nullable(),
  default_branch: z.string(),
  created_at: z.number().int().describe("Unix time in milliseconds."),
});

export const createRepo = defineOperation({
  id: "repos.create",
  method: "POST",
  path: "/user/repos",
  summary: "Create a repository",
  description:
    "Creates an empty private repository owned by the authenticated user. Clone and push it at `/<owner>/<name>.git`.",
  input: z.object({ name: RepoName }),
  output: Repo,
  permission: "repos:create",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  mcp: {
    tool: "create_repo",
    title: "Create a repository",
    description: "Create an empty private repository owned by the authenticated user.",
    readOnly: false,
  },
});

export const RepoList = z.object({
  repos: z.array(Repo),
  next_cursor: z
    .string()
    .nullable()
    .describe("Pass as `cursor` for the next page; null on the last page."),
});

export const listRepos = defineOperation({
  id: "repos.list",
  method: "GET",
  path: "/user/repos",
  summary: "List your repositories",
  description:
    "Lists the repositories the authenticated principal owns and its token can see, by name (ignoring case). A repository created a moment ago is listed; its `default_branch` can lag behind a change by a few seconds (use `GET /repos/{owner}/{repo}` for the current one).",
  input: z.object({
    per_page: z.coerce.number().int().min(1).max(100).default(30).describe("Page size, 1-100."),
    cursor: z.string().max(200).optional().describe("From a previous page's `next_cursor`."),
  }),
  output: RepoList,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_repos",
    title: "List your repositories",
    description: "List the repositories you own, a page at a time.",
    readOnly: true,
  },
});

export const getRepo = defineOperation({
  id: "repos.get",
  method: "GET",
  path: "/repos/{owner}/{repo}",
  summary: "Get a repository",
  description:
    "Returns a repository the caller can see. A repository that does not exist and one the caller cannot see both answer 404.",
  input: z.object({
    owner: z.string().regex(HANDLE_PATTERN).describe("The owner's handle."),
    repo: RepoName,
  }),
  output: Repo,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_repo",
    title: "Get a repository",
    description: "Get a repository by owner and name.",
    readOnly: true,
  },
});

export const updateRepo = defineOperation({
  id: "repos.update",
  method: "PATCH",
  path: "/repos/{owner}/{repo}",
  summary: "Update a repository",
  description:
    "Renames a repository or changes its description or default branch; fields left out are kept. After a rename the old name keeps working for clone, fetch, push and this API, until a repository takes that name again.",
  input: z
    .object({
      owner: z.string().regex(HANDLE_PATTERN).describe("The owner's handle."),
      repo: RepoName.describe("The repository's name (or a name it had before a rename)."),
      name: RepoName.optional().describe("A new name."),
      description: z
        .string()
        .max(MAX_DESCRIPTION_LENGTH)
        .nullable()
        .optional()
        .describe("A short description; null or an empty string clears it."),
      default_branch: z
        .string()
        .min(1)
        .max(1024 - "refs/heads/".length)
        .optional()
        .describe("An existing branch, without the refs/heads/ prefix."),
    })
    .refine(
      (input) =>
        input.name !== undefined ||
        input.description !== undefined ||
        input.default_branch !== undefined,
      "Give at least one of name, description and default_branch.",
    ),
  output: Repo,
  permission: "administration:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "update_repo",
    title: "Update a repository",
    description:
      "Rename a repository or change its description or default branch; the old name keeps working after a rename.",
    readOnly: false,
  },
});

const DeletionState = z
  .enum(["deleting", "deleted"])
  .describe(
    "`deleted` once everything is gone and the name is free again; `deleting` while the rest finishes in the background (the repository is already gone for every request).",
  );

export const RepoDeletion = z.object({
  id: z.string(),
  full_name: z.string(),
  state: DeletionState,
});

export const deleteRepo = defineOperation({
  id: "repos.delete",
  method: "DELETE",
  path: "/repos/{owner}/{repo}",
  summary: "Delete a repository",
  description:
    "Deletes a repository: from now on it cannot be pushed or changed, and within about 30 seconds it can no longer be found or read under any name; its data, events and storage are then removed, and its audit records kept. Forks keep their own data. The name is free again once `state` is `deleted`.",
  input: z.object({
    owner: z.string().regex(HANDLE_PATTERN).describe("The owner's handle."),
    repo: RepoName,
  }),
  output: RepoDeletion,
  permission: "administration:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "delete_repo",
    title: "Delete a repository",
    description: "Delete a repository you administer; forks keep their own data.",
    readOnly: false,
  },
});

/** Repositories one bulk delete takes at most. */
export const MAX_BULK_DELETE = 100;

export const deleteRepos = defineOperation({
  id: "repos.delete_many",
  method: "POST",
  path: "/user/repos/delete",
  summary: "Delete several of your repositories",
  description:
    "Deletes up to 100 repositories you own, by name, as `DELETE /repos/{owner}/{repo}` does for one. Each name answers `deleting`, `deleted` or `not_found` (no such repository, or the token cannot administer it). Deletions this request does not finish continue in the background.",
  input: z.object({
    names: z
      .array(RepoName)
      .min(1)
      .max(MAX_BULK_DELETE)
      .describe("Names of repositories you own; a name given twice (ignoring case) counts once."),
  }),
  output: z.object({
    results: z.array(
      z.object({
        name: z.string(),
        id: z.string().nullable(),
        state: z.enum(["deleting", "deleted", "not_found"]),
      }),
    ),
  }),
  permission: "administration:write",
  principals: ["user", "agent"],
  rateLimit: "expensive",
  idempotency: "key",
  mcp: {
    tool: "delete_repos",
    title: "Delete several repositories",
    description: "Delete up to 100 of your repositories by name in one call.",
    readOnly: false,
  },
});

export const forkRepo = defineOperation({
  id: "repos.fork",
  method: "POST",
  path: "/repos/{owner}/{repo}/forks",
  summary: "Fork a repository",
  description:
    "Creates a fork of a repository the caller can read, owned by the caller, in the same fork network: it starts with the parent's branches, tags and default branch, and shares the parent's stored objects, so no data is copied. The fork can be cloned as soon as this returns. Answers 409 `network_busy` while the network's storage is being collected; retry after a few seconds.",
  input: z.object({
    owner: z.string().regex(HANDLE_PATTERN).describe("The parent's owner handle."),
    repo: RepoName.describe("The parent repository's name."),
    name: RepoName.optional().describe("The fork's name. Default: the parent's name."),
  }),
  output: Repo,
  permission: "repos:create",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  mcp: {
    tool: "fork_repo",
    title: "Fork a repository",
    description:
      "Fork a repository you can read into a new repository you own; nothing is copied and the fork is cloneable at once.",
    readOnly: false,
  },
});
