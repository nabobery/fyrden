import { HANDLE_PATTERN } from "@fyrden/domain";
import { z } from "zod";
import { defineOperation } from "../src/op.js";
import { CommitObject } from "./browse.js";
import { REPO_NAME_PATTERN } from "./repos.js";

const Owner = z.string().regex(HANDLE_PATTERN).describe("The owner's handle.");
const Repo = z.string().regex(REPO_NAME_PATTERN).describe("The repository's name.");
const Path = z
  .string()
  .min(1)
  .max(4096)
  .describe("A path from the repository's root, `a/b/c.txt`.");
const Sha = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .describe("A full SHA (40 lowercase hex digits).");
const Message = z.string().min(1).max(65_536).describe("The commit message.");
const Branch = z
  .string()
  .min(1)
  .max(255)
  .optional()
  .describe("The branch to commit to; the default branch when absent.");
const Person = z
  .object({
    name: z.string().min(1).max(256),
    email: z.string().min(1).max(256),
  })
  .optional()
  .describe("The commit's author; the authenticated principal when absent (always the committer).");

const WrittenFile = z.object({
  type: z.literal("file"),
  name: z.string(),
  path: z.string(),
  sha: z.string().describe("The blob SHA of the new content."),
  size: z.number().int(),
});

export const putContents = defineOperation({
  id: "repos.contents.put",
  method: "PUT",
  path: "/repos/{owner}/{repo}/contents/{path+}",
  summary: "Create or update a file",
  description:
    "Writes one file as a new commit on a branch (GitHub's contents API). To update a file, give its current blob `sha`; without `sha` the file must not exist yet. Fails with 409 when the file or the branch changed meanwhile.",
  input: z.object({
    owner: Owner,
    repo: Repo,
    path: Path,
    message: Message,
    content: z.string().max(5_800_000).describe("The new content, base64 (4 MiB at most)."),
    sha: Sha.optional().describe("The file's current blob SHA (required to update a file)."),
    branch: Branch,
    author: Person,
  }),
  output: z.object({ content: WrittenFile, commit: CommitObject }),
  permission: "contents:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "create_or_update_file",
    title: "Create or update a file",
    description: "Write one file as a commit on a branch.",
    readOnly: false,
    // Each call makes another commit, even with the same content.
    idempotent: false,
  },
});

export const deleteContents = defineOperation({
  id: "repos.contents.delete",
  method: "DELETE",
  path: "/repos/{owner}/{repo}/contents/{path+}",
  summary: "Delete a file",
  description:
    "Deletes one file as a new commit on a branch. `sha` is the file's current blob SHA; fails with 409 when the file or the branch changed meanwhile.",
  input: z.object({
    owner: Owner,
    repo: Repo,
    path: Path,
    message: Message,
    sha: Sha.describe("The file's current blob SHA."),
    branch: Branch,
    author: Person,
  }),
  output: z.object({ content: z.null(), commit: CommitObject }),
  permission: "contents:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "delete_file",
    title: "Delete a file",
    description: "Delete one file as a commit on a branch.",
    readOnly: false,
  },
});

const FileChange = z
  .object({
    path: Path,
    content: z
      .string()
      .max(5_800_000)
      .optional()
      .describe("The new content; absent with `delete`."),
    encoding: z
      .enum(["utf-8", "base64"])
      .default("utf-8")
      .describe("How `content` is written: plain text (`utf-8`) or `base64`."),
    delete: z.boolean().optional().describe("Delete the file instead."),
    mode: z
      .enum(["file", "executable"])
      .optional()
      .describe("Default: keep an existing file's mode, else `file`."),
  })
  .describe("One file to write or delete.");

export const createFileCommit = defineOperation({
  id: "repos.file_commits.create",
  method: "POST",
  path: "/repos/{owner}/{repo}/file-commits",
  summary: "Commit changes to several files",
  description:
    "Writes and deletes up to 100 files (4 MiB of content together) as one commit on a branch. With `expected_head`, fails with 409 unless the branch is still at that commit; the commit is always made on the head it was built on, so a branch that moves meanwhile also fails with 409.",
  input: z.object({
    owner: Owner,
    repo: Repo,
    branch: Branch,
    expected_head: Sha.optional().describe("The commit the branch must be at."),
    message: Message,
    author: Person,
    changes: z.array(FileChange).min(1).max(100),
  }),
  output: z.object({
    branch: z.string(),
    commit: CommitObject,
    files: z.array(z.object({ path: z.string(), sha: z.string().nullable() })),
  }),
  permission: "contents:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  mcp: {
    tool: "commit_files",
    title: "Commit file changes",
    description: "Write and delete several files as one commit on a branch.",
    readOnly: false,
  },
});
