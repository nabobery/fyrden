import { HANDLE_PATTERN } from "@fyrden/domain";
import { z } from "zod";
import { defineOperation } from "../src/op.js";
import { REPO_NAME_PATTERN, Repo } from "./repos.js";

const Owner = z.string().regex(HANDLE_PATTERN).describe("The repository's owner handle.");
const RepoName = z.string().regex(REPO_NAME_PATTERN).describe("The repository's name.");

export const starRepo = defineOperation({
  id: "stars.put",
  method: "PUT",
  path: "/user/starred/{owner}/{repo}",
  summary: "Star a repository",
  description:
    "Stars a repository the caller can read. Starring one already starred changes nothing. The token also needs `metadata:read` for the repository.",
  input: z.object({ owner: Owner, repo: RepoName }),
  output: z.object({ repo: z.string().describe("owner/name"), starred: z.literal(true) }),
  permission: "starring:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "star_repo",
    title: "Star a repository",
    description: "Star a repository you can read.",
    readOnly: false,
  },
});

export const unstarRepo = defineOperation({
  id: "stars.delete",
  method: "DELETE",
  path: "/user/starred/{owner}/{repo}",
  summary: "Unstar a repository",
  description:
    "Takes the caller's star off a repository it can read. Unstarring one not starred changes nothing.",
  input: z.object({ owner: Owner, repo: RepoName }),
  output: z.object({ repo: z.string().describe("owner/name"), starred: z.literal(false) }),
  permission: "starring:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "unstar_repo",
    title: "Unstar a repository",
    description: "Take your star off a repository.",
    readOnly: false,
  },
});

export const listStarred = defineOperation({
  id: "stars.list",
  method: "GET",
  path: "/user/starred",
  summary: "List starred repositories",
  description:
    "Lists the repositories the caller starred, most recently starred first. Repositories the caller or its token can no longer read are left out, so a page can hold fewer than `per_page`; keep following `next_cursor` until it is null.",
  input: z.object({
    per_page: z.coerce.number().int().min(1).max(100).default(30).describe("Page size, 1-100."),
    cursor: z.string().max(200).optional().describe("From a previous page's `next_cursor`."),
  }),
  output: z.object({
    repos: z.array(
      Repo.extend({ starred_at: z.number().int().describe("Unix time in milliseconds.") }),
    ),
    next_cursor: z
      .string()
      .nullable()
      .describe("Pass as `cursor` for the next page; null on the last page."),
  }),
  permission: "starring:read",
  principals: ["user"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_starred",
    title: "List starred repositories",
    description: "List the repositories you starred, most recent first.",
    readOnly: true,
  },
});
