import { HANDLE_PATTERN } from "@fyrden/domain";
import { z } from "zod";
import { AUTHENTICATED, defineOperation } from "../src/op.js";
import { REPO_NAME_PATTERN } from "./repos.js";

const RepoPath = z.object({
  owner: z.string().regex(HANDLE_PATTERN).describe("The owner's handle."),
  repo: z.string().regex(REPO_NAME_PATTERN).describe("The repository name."),
});

export const RepoImport = z.object({
  id: z.string(),
  state: z.enum(["fetching", "indexing", "committing", "committed", "failed"]),
  source_url: z.string(),
  bytes_received: z.number().int().describe("Pack bytes fetched so far."),
  refs_imported: z.array(z.string()).describe("Branches and tags created, once committed."),
  refs_skipped: z
    .array(z.object({ ref: z.string(), reason: z.string() }))
    .describe(
      "Refs of the source that were not imported, e.g. a name that is not valid UTF-8 (shown with \\xNN escapes).",
    ),
  default_branch: z
    .string()
    .optional()
    .describe("The branch the source's HEAD names, when it was imported."),
  error: z.string().optional(),
  started_at: z.number().int().describe("Unix time in milliseconds."),
  updated_at: z.number().int(),
});

export const createImport = defineOperation({
  id: "imports.create",
  method: "POST",
  path: "/repos/{owner}/{repo}/import",
  summary: "Import a public git repository",
  description:
    "Fetches every branch and tag of a public git repository over HTTPS (smart HTTP, protocol version 2) into this repository, which must be empty, checking the objects as a push is checked. Runs in the background; follow it with the get operation. Needs write access. The source URL must be a public https URL: private and internal addresses and this deployment's own hostnames are refused.",
  input: RepoPath.extend({
    url: z
      .string()
      .min(1)
      .max(2048)
      .describe("The repository URL as `git clone` takes it, e.g. https://github.com/o/r.git."),
  }),
  output: RepoImport,
  permission: AUTHENTICATED,
  principals: ["user", "agent"],
  rateLimit: "expensive",
  idempotency: "key",
  successStatus: 201,
  mcp: {
    tool: "import_repo",
    title: "Import a public git repository",
    description:
      "Import every branch and tag of a public https git repository into an empty repository; runs in the background.",
    readOnly: false,
  },
});

export const getImport = defineOperation({
  id: "imports.get",
  method: "GET",
  path: "/repos/{owner}/{repo}/import",
  summary: "Get the repository's import",
  description: "Returns the progress or outcome of the repository's latest import.",
  input: RepoPath,
  output: RepoImport,
  permission: AUTHENTICATED,
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_import",
    title: "Get a repository import",
    description: "Get the progress or outcome of a repository's latest import.",
    readOnly: true,
  },
});
