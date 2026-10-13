import { HANDLE_PATTERN } from "@fyrden/domain";
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
