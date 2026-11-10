import {
  HANDLE_SHAPE,
  MAX_ASSET_NAME_BYTES,
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
  content_type: z
    .string()
    .describe("As declared; a download is always `application/octet-stream`."),
  size: z.number().int(),
  uploader: z.object({ id: z.string() }),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  download_url: z
    .string()
    .describe(
      "Where it downloads from, by tag and name; signed in, as every request. In a webhook body, relative to the repository.",
    ),
});

const AssetId = z.coerce.number().int().positive().describe("The asset's id.");
const UploadId = z
  .string()
  .regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
  .describe("The upload session's id.");

const AssetUpload = z.object({
  id: UploadId,
  release_id: z.number().int(),
  name: z.string(),
  content_type: z.string(),
  size: z.number().int(),
  part_size: z.number().int().describe("Every part's length but the last's."),
  part_count: z.number().int(),
  state: z
    .enum(["receiving", "completing", "completed", "aborted"])
    .describe(
      "`completing`: another request holds the completion, or it is still being decided; complete it again.",
    ),
  parts_url: z
    .string()
    .describe(
      "`PUT <parts_url>/<n>` with part n's bytes and its exact `Content-Length` answers `{part_number, etag}`; keep each etag for completing.",
    ),
  expires_at: z.number().int(),
  asset: ReleaseAsset.optional().describe("The asset it made, once completed."),
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

// Registered before `{release_id}`, as `latest` is.
export const getRetainedAssets = defineOperation({
  id: "releases.retained.get",
  method: "GET",
  path: "/repos/{owner}/{repo}/releases/retained",
  summary: "Get retained release assets",
  description:
    "Objects of replaced or deleted assets, kept for 30 days on the account's storage quota (longer after a restore, which can bring them back): how many, their bytes, and when the next one goes. Takes the `contents:read` permission.",
  input: z.object(RepoInput),
  output: z.object({
    objects: z.number().int(),
    bytes: z.number().int(),
    next_purge_at: z.number().int().nullable(),
  }),
  permission: "contents:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_retained_release_assets",
    title: "Get retained release assets",
    description: "How many replaced or deleted assets' objects are kept, and their bytes.",
    readOnly: true,
  },
});

export const purgeRetainedAssets = defineOperation({
  id: "releases.retained.purge",
  method: "POST",
  path: "/repos/{owner}/{repo}/releases/retained/purge",
  summary: "Purge retained release assets",
  description:
    "Removes every object retained before now, past the restore fence: a restore can't bring them back afterwards, and one to a state naming such an asset finds it missing. Started, not finished: the bytes leave the quota as the objects go; `releases.retained.get` shows them fall. Takes the `administration:write` permission; users only.",
  input: z.object(RepoInput),
  output: z.object({
    state: z.literal("purging"),
    objects: z.number().int().describe("Objects it covers."),
    bytes: z.number().int().describe("Their bytes."),
  }),
  permission: "administration:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 202,
  mcp: false,
});

export const getReleaseAsset = defineOperation({
  id: "releases.assets.get",
  method: "GET",
  path: "/repos/{owner}/{repo}/releases/assets/{asset_id}",
  summary: "Get a release asset",
  description: `One asset of a release. ${READ}`,
  input: z.object({ ...RepoInput, asset_id: AssetId }),
  output: ReleaseAsset,
  permission: "contents:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_release_asset",
    title: "Get a release asset",
    description: "Get one asset of a release.",
    readOnly: true,
  },
});

export const deleteReleaseAsset = defineOperation({
  id: "releases.assets.delete",
  method: "DELETE",
  path: "/repos/{owner}/{repo}/releases/assets/{asset_id}",
  summary: "Delete a release asset",
  description: `Deletes an asset. Its object is kept for 30 days, on the account's storage quota, unless purged sooner. Answers what was deleted (GitHub answers 204). ${MANAGE}`,
  input: z.object({ ...RepoInput, asset_id: AssetId }),
  output: z.object({ id: z.number().int(), state: z.literal("deleted") }),
  permission: "contents:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "delete_release_asset",
    title: "Delete a release asset",
    description: "Delete an asset of a release.",
    readOnly: false,
  },
});

export const createAssetUpload = defineOperation({
  id: "releases.assets.uploads.create",
  method: "POST",
  path: "/repos/{owner}/{repo}/releases/{release_id}/assets/uploads",
  summary: "Start uploading a release asset",
  description: `Starts an upload of an asset of exactly \`size\` bytes, holding that much of the account's storage until it ends. Send the parts to \`parts_url\`, then complete it with their etags. A name taken is 422 \`asset_name_taken\` unless \`replace\` is set; the replaced object is kept for 30 days, on the quota. ${MANAGE}`,
  input: z.object({
    ...RepoInput,
    release_id: ReleaseId,
    name: z
      .string()
      .min(1)
      .max(MAX_ASSET_NAME_BYTES)
      .describe("The file's name: no slash, backslash or control character."),
    size: z.number().int().min(1).describe("Its exact length in bytes."),
    content_type: z.string().max(255).optional().describe("Metadata only."),
    replace: z.boolean().default(false),
  }),
  output: AssetUpload,
  permission: "contents:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  mcp: {
    tool: "create_release_asset_upload",
    title: "Start uploading a release asset",
    description:
      "Start an asset upload; send its parts over HTTP to parts_url with this token, then complete it.",
    readOnly: false,
  },
});

export const completeAssetUpload = defineOperation({
  id: "releases.assets.uploads.complete",
  method: "POST",
  path: "/repos/{owner}/{repo}/releases/assets/uploads/{upload_id}/complete",
  summary: "Complete a release asset upload",
  description: `Assembles the parts in order and makes the asset, once the account's quota has room for it. Only the token that started the upload may complete it (409 \`wrong_token\`). The first completion's list is the one used; a retry's is ignored. \`state: completing\` means another request holds it or it is still being decided: complete it again. ${MANAGE}`,
  input: z.object({
    owner: RepoInput.owner,
    repo: RepoInput.repo,
    upload_id: UploadId,
    parts: z
      .array(z.object({ part_number: z.number().int().min(1), etag: z.string().min(1).max(1024) }))
      .min(1)
      .max(2_000),
  }),
  output: AssetUpload,
  permission: "contents:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "complete_release_asset_upload",
    title: "Complete a release asset upload",
    description: "Complete an asset upload with the etags its parts answered.",
    readOnly: false,
  },
});

export const abortAssetUpload = defineOperation({
  id: "releases.assets.uploads.abort",
  method: "DELETE",
  path: "/repos/{owner}/{repo}/releases/assets/uploads/{upload_id}",
  summary: "Abort a release asset upload",
  description: `Ends an upload and frees what it holds. ${MANAGE}`,
  input: z.object({ owner: RepoInput.owner, repo: RepoInput.repo, upload_id: UploadId }),
  output: AssetUpload,
  permission: "contents:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "abort_release_asset_upload",
    title: "Abort a release asset upload",
    description: "End an asset upload.",
    readOnly: false,
  },
});
