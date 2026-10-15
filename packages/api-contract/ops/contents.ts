import { HANDLE_PATTERN } from "@fyrden/domain";
import { z } from "zod";
import { defineOperation } from "../src/op.js";
import { REPO_NAME_PATTERN } from "./repos.js";

const Owner = z.string().regex(HANDLE_PATTERN).describe("The owner's handle.");
const Repo = z.string().regex(REPO_NAME_PATTERN).describe("The repository's name.");
const Ref = z
  .string()
  .min(1)
  .max(1024)
  .optional()
  .describe("A branch, a tag or a full commit SHA; the default branch when absent.");
const Path = z
  .string()
  .min(1)
  .max(4096)
  .describe("A path from the repository's root, `a/b/c.txt`.");
const Sha = z.string().describe("A full object SHA (40 hex digits).");
const Mode = z
  .string()
  .describe("Git's mode in octal: `100644`, `100755`, `120000`, `040000`, `160000`.");

const Entry = z.object({
  type: z.enum(["file", "dir", "symlink", "submodule"]),
  name: z.string(),
  path: z.string(),
  sha: Sha,
  mode: Mode,
});

/** What a path names: a directory page, a file, a symlink or a submodule (GitHub's `type`). */
export const Contents = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("dir"),
    path: z.string(),
    sha: Sha,
    entries: z.array(Entry),
    next_cursor: z
      .string()
      .nullable()
      .describe("Pass as `cursor` for the next page of entries; null on the last page."),
  }),
  z.object({
    type: z.literal("file"),
    path: z.string(),
    name: z.string(),
    sha: Sha,
    mode: Mode,
    size: z.number().int(),
    encoding: z.enum(["base64", "none"]).describe("`none` when the file is too large to include."),
    content: z.string().describe("The file's bytes, base64; empty when `encoding` is `none`."),
    download_url: z.string().describe("The raw bytes at the same commit (the same token works)."),
  }),
  z.object({
    type: z.literal("symlink"),
    path: z.string(),
    name: z.string(),
    sha: Sha,
    size: z.number().int(),
    target: z.string().describe("The target as UTF-8 (other bytes are replaced; see `content`)."),
    content: z.string().describe("The target's exact bytes, base64."),
  }),
  z.object({ type: z.literal("submodule"), path: z.string(), name: z.string(), sha: Sha }),
]);

const ContentsInput = {
  owner: Owner,
  repo: Repo,
  ref: Ref,
  per_page: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(1000)
    .describe("Directory entries per page, 1-1000."),
  cursor: z.string().max(64).optional().describe("From a previous page's `next_cursor`."),
};

export const getContents = defineOperation({
  id: "repos.contents.get",
  method: "GET",
  path: "/repos/{owner}/{repo}/contents/{path+}",
  summary: "Get repository content",
  description:
    "What a path names at a branch, tag or commit: a directory's entries (in git's order, a page at a time), a file and its content (base64, up to 1 MiB; larger files have `encoding: none` and are read through `download_url`), a symlink and its target, or a submodule and its commit.",
  input: z.object({ ...ContentsInput, path: Path }),
  output: Contents,
  permission: "contents:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_file_contents",
    title: "Get a file or directory",
    description: "Read a file, or list a directory, at a branch, tag or commit.",
    readOnly: true,
  },
});

export const getRootContents = defineOperation({
  id: "repos.contents.root",
  method: "GET",
  path: "/repos/{owner}/{repo}/contents",
  summary: "List the repository's root directory",
  description: "The root directory's entries at a branch, tag or commit, a page at a time.",
  input: z.object(ContentsInput),
  output: Contents,
  permission: "contents:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_root_contents",
    title: "List the root directory",
    description: "List a repository's root directory at a branch, tag or commit.",
    readOnly: true,
  },
});

export const getReadme = defineOperation({
  id: "repos.readme.get",
  method: "GET",
  path: "/repos/{owner}/{repo}/readme",
  summary: "Get the README",
  description:
    "The README file in the root directory at a branch, tag or commit (`README.md` first, then other README files).",
  input: z.object({ owner: Owner, repo: Repo, ref: Ref }),
  output: Contents,
  permission: "contents:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_readme",
    title: "Get the README",
    description: "Read a repository's README at a branch, tag or commit.",
    readOnly: true,
  },
});

export const getTree = defineOperation({
  id: "repos.trees.get",
  method: "GET",
  path: "/repos/{owner}/{repo}/git/trees/{tree_sha+}",
  summary: "Get a tree",
  description:
    "The root tree of a branch, tag or commit (`tree_sha` names one of them: a bare tree SHA is not accepted), with `recursive` every file and directory below it, as `git ls-tree -r -t` lists them. A listing of more than 10,000 entries, or of more trees than one request may read, is `truncated`.",
  input: z.object({
    owner: Owner,
    repo: Repo,
    tree_sha: z.string().min(1).max(1024).describe("A branch, a tag or a commit SHA."),
    recursive: z
      .enum(["1", "true", "0", "false"])
      .optional()
      .describe("`1` or `true` lists every entry below the root."),
  }),
  output: z.object({
    sha: Sha.describe("The root tree's SHA."),
    tree: z.array(
      z.object({
        path: z.string(),
        mode: Mode,
        type: z.enum(["blob", "tree", "commit"]),
        sha: Sha,
      }),
    ),
    truncated: z.boolean(),
  }),
  permission: "contents:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_files",
    title: "List a repository's files",
    description: "List every file and directory of a branch, tag or commit.",
    readOnly: true,
  },
});
