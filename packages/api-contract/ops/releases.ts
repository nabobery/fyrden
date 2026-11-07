import {
  HANDLE_SHAPE,
  MAX_HANDLE_LENGTH,
  MAX_RELEASE_BODY_LENGTH,
  MAX_RELEASE_TAG_LENGTH,
  MAX_RELEASE_TITLE_LENGTH,
} from "@fyrden/domain";
import { z } from "zod";
import { defineOperation } from "../src/op.js";
import { BoundedPerPage } from "./pages.js";
import { REPO_NAME_PATTERN } from "./repos.js";
import { ExpectedVersion } from "./subject-meta.js";

const RepoInput = {
  owner: z
    .string()
    .min(1)
    .max(MAX_HANDLE_LENGTH)
    .regex(HANDLE_SHAPE)
    .describe("The owner's handle."),
  repo: z.string().regex(REPO_NAME_PATTERN).describe("The repository's name."),
};
const ReleaseId = z.coerce.number().int().positive().describe("The release's id.");
const TagName = z
  .string()
  .min(1)
  .max(MAX_RELEASE_TAG_LENGTH)
  .describe("The tag's name, without `refs/tags/`. May contain slashes.");
const Title = z.string().max(MAX_RELEASE_TITLE_LENGTH);
const Notes = z.string().max(MAX_RELEASE_BODY_LENGTH);

const Oid = z.string().describe("An object id, hex.");

export const ReleaseAsset = z.object({
  id: z.number().int(),
  name: z.string(),
  content_type: z.string(),
  size: z.number().int(),
  uploader: z.object({ id: z.string() }),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  download_url: z.string(),
});

export const Release = z.object({
  id: z.number().int(),
  tag_name: z.string(),
  name: z.string().nullable(),
  body: z.string().nullable(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  author: z.object({ id: z.string() }),
  tag_sha: Oid.nullable().describe("The tag's object as recorded at publication; null on a draft."),
  commit_sha: Oid.nullable().describe(
    "The commit the tag peeled to at publication, which the source archives use; null on a draft.",
  ),
  current_tag_sha: Oid.nullable().describe("Where the tag is now, when it has moved."),
  tag_state: z
    .enum(["current", "moved", "deleted"])
    .nullable()
    .describe("What became of the tag since publication; null on a draft."),
  published_at: z.number().int().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  version: z.number().int(),
  assets: z.array(ReleaseAsset),
});

const READ = "Takes the `contents:read` permission; a draft shows only with `contents:write`.";
const MANAGE = "Takes the `contents:write` permission.";

export const listReleases = defineOperation({
  id: "releases.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/releases",
  summary: "List releases",
  description: `Drafts first, newest first, for a caller who can see them; then published releases by publication, newest first. ${READ}`,
  input: z.object({
    ...RepoInput,
    per_page: BoundedPerPage,
    cursor: z.string().max(400).optional().describe("From a previous page's `next_cursor`."),
  }),
  output: z.object({
    releases: z.array(Release),
    next_cursor: z
      .string()
      .nullable()
      .describe("Pass as `cursor` for the next page; null on the last page."),
  }),
  permission: "contents:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_releases",
    title: "List releases",
    description: "List a repository's releases, newest first.",
    readOnly: true,
  },
});

// Registered before `{release_id}`: the path can't say digits only, and the first registered wins.
export const getLatestRelease = defineOperation({
  id: "releases.latest",
  method: "GET",
  path: "/repos/{owner}/{repo}/releases/latest",
  summary: "Get the latest release",
  description:
    "The newest published release by publication that isn't a prerelease. Takes the `contents:read` permission.",
  input: z.object(RepoInput),
  output: Release,
  permission: "contents:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_latest_release",
    title: "Get the latest release",
    description: "Get a repository's newest published release that isn't a prerelease.",
    readOnly: true,
  },
});

export const getReleaseByTag = defineOperation({
  id: "releases.get_by_tag",
  method: "GET",
  path: "/repos/{owner}/{repo}/releases/tags/{tag+}",
  summary: "Get a release by its tag",
  description: `The release of a tag name, draft or published. ${READ}`,
  input: z.object({ ...RepoInput, tag: TagName }),
  output: Release,
  permission: "contents:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_release_by_tag",
    title: "Get a release by its tag",
    description: "Get the release of a tag name.",
    readOnly: true,
  },
});

export const getRelease = defineOperation({
  id: "releases.get",
  method: "GET",
  path: "/repos/{owner}/{repo}/releases/{release_id}",
  summary: "Get a release",
  description: `One release, with what became of its tag. ${READ}`,
  input: z.object({ ...RepoInput, release_id: ReleaseId }),
  output: Release,
  permission: "contents:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_release",
    title: "Get a release",
    description: "Get one release of a repository.",
    readOnly: true,
  },
});

export const createRelease = defineOperation({
  id: "releases.create",
  method: "POST",
  path: "/repos/{owner}/{repo}/releases",
  summary: "Create a release",
  description: `Creates a draft, which needs no tag, or publishes at once, which needs the tag to exist (422 \`tag_not_found\`; push it first) and to be or peel to a commit (422 \`tag_not_a_commit\`). Publishing records the tag object and its commit for good. Answers 409 \`tag_moving\`, with nothing changed, when the tag moved meanwhile; send it again. ${MANAGE}`,
  input: z.object({
    ...RepoInput,
    tag_name: TagName,
    name: Title.optional(),
    body: Notes.optional(),
    draft: z.boolean().default(false),
    prerelease: z.boolean().default(false),
  }),
  output: Release,
  permission: "contents:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  mcp: {
    tool: "create_release",
    title: "Create a release",
    description: "Create a draft release, or publish one from a tag that exists.",
    readOnly: false,
  },
});

export const updateRelease = defineOperation({
  id: "releases.update",
  method: "PATCH",
  path: "/repos/{owner}/{repo}/releases/{release_id}",
  summary: "Update a release",
  description: `Changes a release's title, notes or prerelease flag; on a draft, its tag too. \`draft: false\` publishes a draft, under the same conditions as creating one published. A published release can't go back to draft or change its tag (422 \`release_published\`). ${MANAGE}`,
  input: z.object({
    ...RepoInput,
    release_id: ReleaseId,
    tag_name: TagName.optional(),
    name: Title.nullable().optional().describe("Null clears it."),
    body: Notes.nullable().optional().describe("Null clears it."),
    draft: z.boolean().optional(),
    prerelease: z.boolean().optional(),
    expected_version: ExpectedVersion,
  }),
  output: Release,
  permission: "contents:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "update_release",
    title: "Update a release",
    description: "Change a release, or publish a draft.",
    readOnly: false,
  },
});

export const deleteRelease = defineOperation({
  id: "releases.delete",
  method: "DELETE",
  path: "/repos/{owner}/{repo}/releases/{release_id}",
  summary: "Delete a release",
  description: `Deletes a release. Its tag stays. Answers what was deleted (GitHub answers 204). ${MANAGE}`,
  input: z.object({ ...RepoInput, release_id: ReleaseId }),
  output: z.object({ id: z.number().int(), state: z.literal("deleted") }),
  permission: "contents:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "delete_release",
    title: "Delete a release",
    description: "Delete a release. Its tag stays.",
    readOnly: false,
  },
});
