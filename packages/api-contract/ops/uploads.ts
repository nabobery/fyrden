import { HANDLE_SHAPE, MAX_HANDLE_LENGTH } from "@fyrden/domain";
import { z } from "zod";
import { defineOperation } from "../src/op.js";
import { REPO_NAME_PATTERN } from "./repos.js";

/*
 * Chunked pack uploads: a push too large for one request (the plan's body
 * limit, 100 MiB on Cloudflare Free and Pro) goes up in parts. The session
 * operations are here; the parts themselves are binary request bodies sent
 * to `parts_url` (`PUT <parts_url>/<n>`, git credentials, Content-Length
 * required), next to the repository's git endpoints.
 */

const Owner = z
  .string()
  .min(1)
  .max(MAX_HANDLE_LENGTH)
  .regex(HANDLE_SHAPE)
  .describe("The owner's handle.");
const Repo = z.string().regex(REPO_NAME_PATTERN).describe("The repository name.");
const UploadId = z
  .string()
  .regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
  .describe("The upload session id.");
const Sha = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .describe("A full object id (40 lowercase hex).");

export const RefUpdateInput = z.object({
  ref: z
    .string()
    .min(1)
    .max(1024)
    .describe("Full ref name, e.g. refs/heads/main. Checked as git checks ref names."),
  old: Sha.nullable().describe(
    "The value the ref must have now (compare-and-set); null when the ref must not exist yet.",
  ),
  new: Sha.nullable().describe("The new value; null deletes the ref."),
});

const RefResult = z.object({
  ref: z.string(),
  status: z.enum(["ok", "rejected"]),
  reason: z.string().optional(),
});

export const UploadSession = z.object({
  id: z.string(),
  state: z
    .enum(["receiving", "indexing", "committed", "rejected", "expired"])
    .describe(
      "receiving: parts may be uploaded; indexing: completing (call complete again); committed or rejected: done.",
    ),
  size: z.number().int().describe("The pack's length in bytes."),
  part_size: z
    .number()
    .int()
    .describe("Every part but the last is exactly this long; the last holds the rest."),
  part_count: z.number().int(),
  parts_received: z.array(z.number().int()).describe("Part numbers stored so far."),
  parts_url: z
    .string()
    .describe("Upload part n with PUT <parts_url>/<n> (path on this host; git credentials)."),
  expires_at: z.number().int().describe("Unix time in milliseconds."),
  refs: z.array(RefResult).optional().describe("Per-ref outcome, once the upload is complete."),
  error: z.string().optional(),
});

const SessionPath = z.object({ owner: Owner, repo: Repo, upload_id: UploadId });

export const createUpload = defineOperation({
  id: "uploads.create",
  method: "POST",
  path: "/repos/{owner}/{repo}/uploads",
  summary: "Start a chunked pack upload",
  description:
    "Starts an upload session for a pack too large for one push request: declare the pack's size and the ref updates it carries, upload the parts, then complete. Needs write access to the repository. `fyrden push --chunked` does all of this.",
  input: z.object({
    owner: Owner,
    repo: Repo,
    size: z
      .number()
      .int()
      .min(32)
      .describe("The pack's exact length in bytes (git pack-objects output)."),
    ref_updates: z.array(RefUpdateInput).min(1).max(1000),
  }),
  output: UploadSession,
  permission: "contents:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  mcp: {
    tool: "create_upload_session",
    title: "Start a chunked pack upload",
    description:
      "Start an upload session for a large git pack: declare its size and ref updates, then upload parts and complete.",
    readOnly: false,
  },
});

export const getUpload = defineOperation({
  id: "uploads.get",
  method: "GET",
  path: "/repos/{owner}/{repo}/uploads/{upload_id}",
  summary: "Get a chunked pack upload",
  description:
    "Returns an upload session started by the caller: which parts are stored, and the outcome once complete.",
  input: SessionPath,
  output: UploadSession,
  permission: "contents:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_upload_session",
    title: "Get a chunked pack upload",
    description: "Get an upload session: stored parts and, once complete, the per-ref outcome.",
    readOnly: true,
  },
});

export const completeUpload = defineOperation({
  id: "uploads.complete",
  method: "POST",
  path: "/repos/{owner}/{repo}/uploads/{upload_id}/complete",
  summary: "Complete a chunked pack upload",
  description:
    "Assembles the parts, indexes and checks the pack as a push is checked, and applies the ref updates in one transaction. Answers state `indexing` while a large pack is still being indexed: call it again. Must be called with the token that started the session.",
  input: SessionPath,
  output: UploadSession,
  permission: "contents:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "complete_upload_session",
    title: "Complete a chunked pack upload",
    description:
      "Assemble the uploaded parts, index the pack and apply the ref updates; call again while it answers indexing.",
    readOnly: false,
  },
});

export const abortUpload = defineOperation({
  id: "uploads.abort",
  method: "DELETE",
  path: "/repos/{owner}/{repo}/uploads/{upload_id}",
  summary: "Abort a chunked pack upload",
  description: "Ends an upload session that has not committed and deletes what it stored.",
  input: SessionPath,
  output: UploadSession,
  permission: "contents:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "abort_upload_session",
    title: "Abort a chunked pack upload",
    description: "End an upload session that has not committed and delete its stored parts.",
    readOnly: false,
  },
});
