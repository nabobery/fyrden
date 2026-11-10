import { assetName } from "@fyrden/domain";
import type { Context, Hono } from "hono";
import { ASSETS_BUCKET, assetKey } from "../do/repo/release-assets.js";
import { repoFor } from "../git/chunked/operations.js";
import { contentDispositionFor } from "../http/content-disposition.js";
import { problem } from "../http/problem.js";
import { downloadPlan } from "../http/range.js";
import { type AuthVariables, requireAuth } from "../middleware/auth.js";
import { hasPermission, OperationError, rateLimitKey } from "../ops/execute.js";
import { authorize } from "../repos/directory.js";
import { API_PREFIX, opContext } from "./mount.js";
import { readAccess } from "./raw.js";

/*
 * The two release asset routes outside the registry, since their bodies
 * aren't JSON: a part's `PUT`, and a download by tag and name.
 */

type AppContext = Context<{ Bindings: Env; Variables: AuthVariables }>;

const UPLOAD_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** A `Content-Length` as a byte count; undefined when absent or not a plain decimal. */
function declaredLength(request: Request): number | undefined {
  const header = request.headers.get("Content-Length");
  if (header === null || !/^\d{1,16}$/.test(header.trim())) return undefined;
  return Number(header.trim());
}

/**
 * `PUT /api/repos/{owner}/{repo}/releases/assets/uploads/{id}/parts/{n}`:
 * part n of an upload session, from the principal that began it, with its
 * exact length. One read of the session, then the body goes to R2 as it
 * arrives (streaming a request body into `uploadPart` cost no measurable
 * Worker CPU, measured on Workers Free, 2026-10-10). Answers the part's
 * etag, which the client keeps for completing; sending a part again
 * replaces it.
 */
async function uploadAssetPart(c: AppContext): Promise<Response> {
  const ctx = opContext(c);
  const { owner, repo } = c.req.param() as { owner: string; repo: string };
  if (!(await c.env.RATE_LIMIT_WRITE.limit({ key: rateLimitKey(ctx.auth) })).success)
    return problem(c, 429, "rate_limited", "Too many requests for this token.", {
      "Retry-After": "60",
    });
  if (ctx.auth.principalType !== "user" && ctx.auth.principalType !== "agent")
    return problem(
      c,
      403,
      "principal_type_not_allowed",
      `${ctx.auth.principalType} principals cannot upload release assets.`,
    );
  if (!hasPermission("contents:write", ctx.auth))
    return problem(c, 403, "missing_permission", "Uploading release assets needs contents:write.");
  let entry: Awaited<ReturnType<typeof repoFor>>;
  try {
    entry = await repoFor(ctx, owner, repo, "contents:write");
  } catch (error) {
    if (error instanceof OperationError) return problem(c, error.status, error.code, error.message);
    throw error;
  }
  const uploadId = c.req.param("upload_id") ?? "";
  const part = Number(c.req.param("part"));
  if (!UPLOAD_ID.test(uploadId))
    return problem(c, 404, "upload_not_found", "No such upload session.");
  if (!Number.isSafeInteger(part) || part < 1)
    return problem(c, 422, "invalid_part", "Parts are numbered from 1.");
  const request = c.req.raw;
  const encoding = (request.headers.get("Content-Encoding") ?? "identity").trim().toLowerCase();
  if (encoding !== "identity")
    return problem(c, 415, "unsupported_encoding", "Send parts without a Content-Encoding.");
  const length = declaredLength(request);
  if (length === undefined)
    return problem(c, 411, "length_required", "A part needs a Content-Length.");
  ctx.metrics.count("do.request", { class: "RepoDO", method: "releaseAssetPartTarget" });
  const target = await c.env.REPO.getByName(entry.id).releaseAssetPartTarget(
    uploadId,
    ctx.auth.principalId,
    part,
    length,
  );
  if (!target.ok) return problem(c, target.status, target.code, target.error);
  try {
    ctx.metrics.count("r2.class_a", { bucket: ASSETS_BUCKET, op: "upload_part" });
    const stored = await c.env.ASSETS.resumeMultipartUpload(
      target.key,
      target.multipartId,
    ).uploadPart(target.partNumber, request.body ?? new Uint8Array(0));
    return c.json({ part_number: target.partNumber, etag: stored.etag });
  } catch (error) {
    c.get("log").warn("release asset part not stored", { uploadId, part, error });
    return problem(c, 400, "part_not_stored", `Part ${part} was not stored; upload it again.`);
  }
}

/** Headers every download answer carries, refusals by condition included. */
const DOWNLOAD_HEADERS = {
  "Accept-Ranges": "bytes",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "private, no-store",
};

/**
 * `GET /api/repos/{owner}/{repo}/releases/download/{tag}/{name}`: an
 * asset's bytes as an attachment, always `application/octet-stream`, with
 * ranges and conditionals answered from rows before any R2 read. The tag
 * may hold slashes, so the route takes the rest of the path and splits it
 * at the last one; a name can't hold a slash. Authorization comes first: a
 * draft's asset goes to writers only, else it is as missing as none.
 */
async function downloadAsset(c: AppContext): Promise<Response> {
  const access = await readAccess(c, "download release assets");
  if (access instanceof Response) return access;
  const { ctx, repo } = access;
  const rest = c.req.param("rest") ?? "";
  const cut = rest.lastIndexOf("/");
  const tag = cut > 0 ? rest.slice(0, cut) : "";
  const name = assetName(cut > 0 ? rest.slice(cut + 1) : "");
  const missing = () => problem(c, 404, "asset_not_found", "The release has no such asset.");
  if (tag === "" || !name.ok) return missing();
  ctx.metrics.count("do.request", { class: "RepoDO", method: "releaseAssetForDownload" });
  const found = await c.env.REPO.getByName(repo.id).releaseAssetForDownload(tag, name.fold);
  if (found === null)
    return problem(
      c,
      404,
      "repo_not_found",
      `No repository ${repo.ownerHandle}/${repo.name} was found.`,
    );
  if (!found) return missing();
  if (found.draft && !(await authorize(ctx.env, ctx.auth, repo, "contents:write", ctx.metrics)))
    return missing();
  const { asset } = found;
  const etag = `"${asset.objectId}"`;
  const lastModified = new Date(asset.updatedAt).toUTCString();
  const plan = downloadPlan(
    c.req.raw,
    { etag, lastModified: asset.updatedAt, size: asset.bytes },
    Date.now(),
  );
  const validators = { ETag: etag, "Last-Modified": lastModified };
  if (plan.status === 304 || plan.status === 412)
    return new Response(null, {
      status: plan.status,
      headers: { ...DOWNLOAD_HEADERS, ...validators },
    });
  if (plan.status === 416)
    return new Response(null, {
      status: 416,
      headers: { ...DOWNLOAD_HEADERS, ...validators, "Content-Range": plan.contentRange },
    });
  const headers: Record<string, string> = {
    ...DOWNLOAD_HEADERS,
    ...validators,
    "Content-Type": "application/octet-stream",
    "Content-Disposition": contentDispositionFor(asset.name),
    "Content-Length": String(plan.status === 206 ? plan.length : asset.bytes),
    ...(plan.status === 206 && { "Content-Range": plan.contentRange }),
  };
  // HEAD runs this handler too: the headers, and no R2 read.
  if (c.req.method === "HEAD") return new Response(null, { status: plan.status, headers });
  ctx.metrics.count("r2.class_b", { bucket: ASSETS_BUCKET, op: "get_asset" });
  const object = await c.env.ASSETS.get(
    assetKey(repo.id, asset.objectId),
    plan.status === 206 ? { range: { offset: plan.offset, length: plan.length } } : {},
  );
  if (!object) {
    // Its row is there and its object isn't: only after an early purge and a restore.
    c.get("log").error("release asset object missing", {
      repoId: repo.id,
      objectId: asset.objectId,
    });
    return problem(c, 404, "asset_missing", "The asset's file is gone.");
  }
  return new Response(object.body, { status: plan.status, headers });
}

export function mountReleaseAssets(app: Hono<{ Bindings: Env; Variables: AuthVariables }>): void {
  app.put(
    `${API_PREFIX}/repos/:owner/:repo/releases/assets/uploads/:upload_id/parts/:part`,
    requireAuth("by-method"),
    uploadAssetPart,
  );
  app.get(
    `${API_PREFIX}/repos/:owner/:repo/releases/download/:rest{.+}`,
    requireAuth("by-method"),
    downloadAsset,
  );
}
