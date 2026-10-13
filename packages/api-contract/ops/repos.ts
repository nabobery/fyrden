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
  fork: z.boolean().describe("Whether the repository was forked from another."),
  is_template: z
    .boolean()
    .describe("Whether new repositories can be generated from it (`/generate`)."),
  stargazers_count: z.number().int().describe("How many users starred it."),
  parent_id: z.string().nullable().describe("The id of the repository it was forked from."),
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
    "Renames a repository, changes its description or default branch, or marks it as a template; fields left out are kept. After a rename the old name keeps working for clone, fetch, push and this API, until a repository takes that name again.",
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
      is_template: z
        .boolean()
        .optional()
        .describe("Whether new repositories can be generated from it."),
    })
    .refine(
      (input) =>
        input.name !== undefined ||
        input.description !== undefined ||
        input.default_branch !== undefined ||
        input.is_template !== undefined,
      "Give at least one of name, description, default_branch and is_template.",
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
      "Rename a repository, change its description or default branch, or mark it as a template; the old name keeps working after a rename.",
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

export const listForks = defineOperation({
  id: "repos.forks.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/forks",
  summary: "List forks",
  description:
    "Lists the forks of a repository that the caller owns, oldest first. Forks owned by other accounts are not listed.",
  input: z.object({
    owner: z.string().regex(HANDLE_PATTERN).describe("The repository's owner handle."),
    repo: RepoName.describe("The repository's name."),
    per_page: z.coerce.number().int().min(1).max(100).default(30).describe("Page size, 1-100."),
    cursor: z.string().max(200).optional().describe("From a previous page's `next_cursor`."),
  }),
  output: RepoList,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_forks",
    title: "List forks",
    description: "List your forks of a repository.",
    readOnly: true,
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

export const generateRepo = defineOperation({
  id: "repos.generate",
  method: "POST",
  path: "/repos/{template_owner}/{template_repo}/generate",
  summary: "Create a repository from a template",
  description:
    "Creates a private repository whose first commit (on `main`) holds the files of the template's default branch, with their modes, symlinks and submodule links (at most 2,000 files and directories, 8 MiB in all). Unlike a fork it starts its own history and shares nothing with the template. The template must be marked `is_template` and readable by the caller; `owner` may be the caller or an organization it may create repositories in, where it can write. The token needs `contents:write` as well, without a repository list. Answers 422 `not_a_template`, or 422 `template_too_large` past the bounds; on a failure no repository is left.",
  input: z.object({
    template_owner: z.string().regex(HANDLE_PATTERN).describe("The template's owner handle."),
    template_repo: RepoName.describe("The template's name."),
    owner: z
      .string()
      .regex(HANDLE_PATTERN)
      .optional()
      .describe("Who owns the new repository: the caller (default) or an organization."),
    name: RepoName.describe("The new repository's name."),
  }),
  output: Repo,
  permission: "repos:create",
  principals: ["user"],
  rateLimit: "expensive",
  idempotency: "key",
  successStatus: 201,
  mcp: {
    tool: "generate_repo",
    title: "Create a repository from a template",
    description:
      "Create a new repository holding a template repository's files, with its own history.",
    readOnly: false,
  },
});

export const createOrgRepo = defineOperation({
  id: "orgs.repos.create",
  method: "POST",
  path: "/orgs/{org}/repos",
  summary: "Create an organization repository",
  description:
    "Creates an empty private repository owned by an organization. Members may create them; owners administer every repository of the organization, and members can read them.",
  input: z.object({
    org: z.string().regex(HANDLE_PATTERN).describe("The organization's handle."),
    name: RepoName,
  }),
  output: Repo,
  permission: "repos:create",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  mcp: {
    tool: "create_org_repo",
    title: "Create an organization repository",
    description: "Create an empty private repository in an organization you are a member of.",
    readOnly: false,
  },
});

export const listOrgRepos = defineOperation({
  id: "orgs.repos.list",
  method: "GET",
  path: "/orgs/{org}/repos",
  summary: "List an organization's repositories",
  description:
    "Lists an organization's repositories, by name (ignoring case), for its members. A repository created a moment ago is listed; its `default_branch` can lag behind a change by a few seconds.",
  input: z.object({
    org: z.string().regex(HANDLE_PATTERN).describe("The organization's handle."),
    per_page: z.coerce.number().int().min(1).max(100).default(30).describe("Page size, 1-100."),
    cursor: z.string().max(200).optional().describe("From a previous page's `next_cursor`."),
  }),
  output: RepoList,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_org_repos",
    title: "List organization repositories",
    description: "List the repositories of an organization you belong to, a page at a time.",
    readOnly: true,
  },
});
