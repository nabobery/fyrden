import { HANDLE_PATTERN } from "@fyrden/domain";
import { z } from "zod";
import { defineOperation } from "../src/op.js";
import { REPO_NAME_PATTERN } from "./repos.js";

export const getArchive = defineOperation({
  id: "repos.archives.get",
  method: "GET",
  path: "/repos/{owner}/{repo}/archives/{format}",
  summary: "Get an archive link",
  description:
    "Prepares the files of a branch, tag or commit as a tar.gz or zip archive and gives its link (`download_url`, GitHub's tarball or zipball route; the same token works). A large archive is built in the background: `state` is `building` until it is `ready`; ask again, or fetch the link, which answers 202 until then. Archives hold 1 GiB of files at most, each file 24 MiB at most, a zip 65,535 entries.",
  input: z.object({
    owner: z.string().regex(HANDLE_PATTERN).describe("The owner's handle."),
    repo: z.string().regex(REPO_NAME_PATTERN).describe("The repository's name."),
    format: z.enum(["tar.gz", "zip"]),
    ref: z
      .string()
      .min(1)
      .max(1024)
      .optional()
      .describe("A branch, a tag or a full commit SHA; the default branch when absent."),
  }),
  output: z.object({
    state: z.enum(["ready", "building"]),
    commit: z.string().describe("The commit archived."),
    size: z.number().int().nullable().describe("The archive's size in bytes, once ready."),
    download_url: z.string(),
  }),
  permission: "contents:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_archive",
    title: "Get an archive link",
    description: "Prepare a tar.gz or zip of a branch, tag or commit and get its download link.",
    readOnly: true,
  },
});
