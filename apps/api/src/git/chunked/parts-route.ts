import { problem } from "../../http/problem.js";
import { authorizeGit } from "../auth.js";
import { type GitContext, repoParams } from "../http.js";
import { BUCKET_NAME } from "../push/scratch.js";
import { MAX_PARTS } from "./tuning.js";

const UPLOAD_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
/** Seconds a client waits before sending a part another request is uploading. Proposed. */
const BUSY_RETRY_S = 5;

/** A `Content-Length` as a byte count; undefined when absent or not a plain decimal. */
function declaredLength(request: Request): number | undefined {
  const header = request.headers.get("Content-Length");
  if (header === null || !/^\d{1,16}$/.test(header.trim())) return undefined;
  return Number(header.trim());
}

/**
 * `PUT <repo>/uploads/<upload_id>/parts/<n>`: one part of a chunked upload,
 * authenticated like a push (a git token or personal access token with
 * write access). The request body goes to R2 as multipart part `n` as it
 * arrives: the Worker runs no code per chunk (streaming a request body into
 * `uploadPart` cost no measurable Worker CPU, measured on Workers Free,
 * 2026-10-10). The repository object checks the part's number and exact
 * length first and reserves the part for this request, and records its
 * etag after under that reservation; uploading a part again replaces it,
 * one request at a time (another one meanwhile gets `part_in_progress`).
 * Each reservation names its own R2 part number, so a request that outlives
 * its reservation cannot overwrite the part another request recorded.
 * Binary, so it is not a JSON operation; the session itself is
 * (`uploads.*`).
 */
export async function uploadPart(c: GitContext): Promise<Response> {
  const { owner, name } = repoParams(c);
  const access = await authorizeGit(c, owner, name, "write");
  if (!access.ok) return access.response;

  const uploadId = c.req.param("upload_id") ?? "";
  const part = Number(c.req.param("part"));
  if (!UPLOAD_ID.test(uploadId))
    return problem(c, 404, "upload_not_found", "No such upload session.");
  if (!Number.isSafeInteger(part) || part < 1 || part > MAX_PARTS)
    return problem(c, 422, "invalid_part", `Parts are numbered 1 to ${MAX_PARTS}.`);
  const request = c.req.raw;
  const encoding = (request.headers.get("Content-Encoding") ?? "identity").trim().toLowerCase();
  if (encoding !== "identity")
    return problem(c, 415, "unsupported_encoding", "Send parts without a Content-Encoding.");
  const length = declaredLength(request);
  if (length === undefined)
    return problem(c, 411, "length_required", "A part needs a Content-Length.");

  const principal = access.auth.principalId;
  const stub = c.env.REPO.getByName(access.repo.id);
  const target = await stub.chunkedPartTarget(uploadId, principal, part, length);
  if (!target.ok) {
    if (target.code === "part_in_progress") c.header("Retry-After", String(BUSY_RETRY_S));
    return problem(c, target.status, target.code, target.error);
  }

  let etag: string;
  try {
    c.get("metrics").count("r2.class_a", { bucket: BUCKET_NAME, op: "upload_part" });
    const stored = await c.env.GIT.resumeMultipartUpload(target.key, target.multipartId).uploadPart(
      target.partNumber,
      request.body ?? new Uint8Array(0),
    );
    etag = stored.etag;
  } catch (error) {
    c.get("log").warn("chunked part not stored", { uploadId, part, error });
    await stub.releaseChunkedPart(uploadId, principal, part, target.token).catch(() => {});
    return problem(c, 400, "part_not_stored", `Part ${part} was not stored; upload it again.`);
  }
  const recorded = await stub.recordChunkedPart(uploadId, principal, part, etag, target.token);
  if (!recorded.ok) return problem(c, recorded.status, recorded.code, recorded.error);
  return c.json({
    part,
    parts_received: recorded.view.partsReceived,
    part_count: recorded.view.partCount,
  });
}
