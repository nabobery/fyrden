import type {
  abortAssetUpload,
  completeAssetUpload,
  createAssetUpload,
  deleteReleaseAsset,
  getReleaseAsset,
  getRetainedAssets,
  Input,
  Output,
  purgeRetainedAssets,
} from "@fyrden/api-contract";
import { assetContentType, assetName } from "@fyrden/domain";
import {
  type AssetFailure,
  assetHoldId,
  RELEASE_ASSET_POLICY,
  type UploadAnswer,
  type UploadView,
} from "../do/repo/release-assets.js";
import { repoFor } from "../git/chunked/operations.js";
import { chunkedTuning } from "../git/chunked/tuning.js";
import { releaseUpload, reserveUpload } from "../git/push/quota.js";
import { reauthorizeWriter } from "../git/push/reauthorize.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { authorize, type RepoEntry } from "./directory.js";
import { actorOf, failure } from "./pulls.js";
import { assetOutput } from "./shapes.js";
import { sortingFailure } from "./sorting.js";

/*
 * The Worker side of release asset operations. The repository object owns
 * sessions and assets (do/repo/release-assets.ts); parts and downloads go
 * through rest/release-assets.ts, since their bodies aren't JSON.
 */

/** An asset's size at most when the operator sets none: GitHub's figure. Proposed. */
export const RELEASE_ASSET_DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** How much longer than its session an upload's reservation lasts. */
const RESERVATION_MARGIN_MS = 60 * 60 * 1000;

/**
 * Asset sizes: `RELEASE_ASSET_MAX_BYTES` (else 2 GiB), clamped to what the
 * most parts a session takes hold at the chunked part size.
 */
export function releaseAssetTuning(env: Env): { maxBytes: number; partBytes: number } {
  const { partBytes } = chunkedTuning(env);
  const raw = (env as unknown as Partial<Record<string, unknown>>).RELEASE_ASSET_MAX_BYTES;
  const set = typeof raw === "string" || typeof raw === "number" ? Number(raw) : Number.NaN;
  const wanted = Number.isSafeInteger(set) && set > 0 ? set : RELEASE_ASSET_DEFAULT_MAX_BYTES;
  return { maxBytes: Math.min(wanted, RELEASE_ASSET_POLICY.maxParts * partBytes), partBytes };
}

const repo = (ctx: OpContext, entry: RepoEntry, method: string) => {
  ctx.metrics.count("do.request", { class: "RepoDO", method });
  return ctx.env.REPO.getByName(entry.id);
};

/** Throws a refusal: the repository's own (gone, moving, access lost) as every operation answers it. */
function unwrap(
  entry: RepoEntry,
  answer: UploadAnswer | AssetFailure | { ok: true } | { ok: false; code: string },
): void {
  if (answer.ok) return;
  if (answer.code === "repo_not_found") throw failure(entry, answer.code);
  if (answer.code === "repo_transferring")
    throw new OperationError(
      409,
      "repo_transferring",
      "The repository is being transferred; its release assets change once it lands.",
    );
  if (answer.code === "access_lost" || answer.code === "forbidden")
    throw new OperationError(403, "forbidden", "Changing release assets takes write access.");
  if (!("status" in answer)) throw sortingFailure(answer.code) ?? failure(entry, answer.code);
  throw new OperationError(answer.status, answer.code, answer.error);
}

type Upload = Output<typeof createAssetUpload>;

function uploadOutput(entry: RepoEntry, view: UploadView, tag: string | undefined): Upload {
  const base = `/api/repos/${entry.ownerHandle}/${entry.name}/releases/assets/uploads/${view.uploadId}`;
  return {
    id: view.uploadId,
    release_id: view.releaseId,
    name: view.name,
    content_type: view.contentType,
    size: view.bytes,
    part_size: view.partBytes,
    part_count: view.partCount,
    state: view.state,
    parts_url: `${base}/parts`,
    expires_at: view.expiresAt,
    ...(view.asset &&
      tag !== undefined && { asset: assetOutput({ tagName: tag }, view.asset, entry) }),
  };
}

/** The tag of the release an upload belongs to, for its asset's download path. */
async function tagOf(ctx: OpContext, entry: RepoEntry, view: UploadView) {
  if (!view.asset) return undefined;
  const release = await repo(ctx, entry, "getRelease").getRelease(view.releaseId);
  return release?.tagName;
}

/** The `releases.assets.uploads.create` operation. */
export async function createAssetUploadOperation(
  ctx: OpContext,
  input: Input<typeof createAssetUpload>,
): Promise<Upload> {
  const entry = await repoFor(ctx, input.owner, input.repo, "contents:write");
  const { maxBytes, partBytes } = releaseAssetTuning(ctx.env);
  if (input.size > maxBytes)
    throw new OperationError(
      422,
      "asset_too_large",
      `This server takes assets of at most ${maxBytes} bytes.`,
    );
  const name = assetName(input.name);
  if (!name.ok)
    throw new OperationError(422, "invalid_asset_name", `The asset's name ${name.reason}.`);
  const type = assetContentType(input.content_type);
  if (!type.ok)
    throw new OperationError(422, "invalid_content_type", "That isn't a media type: type/subtype.");
  const stub = repo(ctx, entry, "beginReleaseAsset");
  const begun = await stub.beginReleaseAsset(
    {
      releaseId: input.release_id,
      name: name.name,
      fold: name.fold,
      contentType: type.type,
      bytes: input.size,
      partBytes,
      replace: input.replace,
    },
    { ...actorOf(ctx), tokenId: ctx.auth.id },
  );
  unwrap(entry, begun);
  const view = (begun as { ok: true; view: UploadView }).view;
  // The account's storage for the whole asset, held until the session ends or commits.
  ctx.metrics.count("do.request", { class: "OrgDO", method: "reserveStorage" });
  const abort = () =>
    repo(ctx, entry, "abortReleaseAsset").abortReleaseAsset(view.uploadId, ctx.auth.principalId);
  const reservation = await reserveUpload(ctx.env, entry, assetHoldId(view.uploadId), {
    declared: input.size,
    maxBytes: input.size,
    ttlMs: Math.max(0, view.expiresAt - Date.now()) + RESERVATION_MARGIN_MS,
  }).catch(async (error: unknown) => {
    await abort().catch(() => undefined);
    throw error;
  });
  if (!reservation.ok) {
    await abort();
    throw new OperationError(403, "quota_exceeded", `${reservation.message}.`);
  }
  return uploadOutput(entry, view, undefined);
}

/**
 * The `releases.assets.uploads.complete` operation: the token checked again
 * on the primary, its decision handed to the repository, which decides.
 */
export async function completeAssetUploadOperation(
  ctx: OpContext,
  input: Input<typeof completeAssetUpload>,
): Promise<Upload> {
  const entry = await repoFor(ctx, input.owner, input.repo, "contents:write");
  const decision = await reauthorizeWriter(
    { env: ctx.env, authState: ctx.authState, metrics: ctx.metrics, requestId: ctx.requestId },
    { auth: ctx.auth, repo: entry },
    { owner: entry.ownerHandle, name: entry.name },
  );
  const answer = await repo(ctx, entry, "completeReleaseAsset").completeReleaseAsset({
    uploadId: input.upload_id,
    actor: { ...actorOf(ctx), tokenId: ctx.auth.id },
    parts: input.parts.map((part) => ({ partNumber: part.part_number, etag: part.etag })),
    decision,
  });
  unwrap(entry, answer);
  const view = (answer as { ok: true; view: UploadView }).view;
  return uploadOutput(entry, view, await tagOf(ctx, entry, view));
}

/** The `releases.assets.uploads.abort` operation. */
export async function abortAssetUploadOperation(
  ctx: OpContext,
  input: Input<typeof abortAssetUpload>,
): Promise<Upload> {
  const entry = await repoFor(ctx, input.owner, input.repo, "contents:write");
  const answer = await repo(ctx, entry, "abortReleaseAsset").abortReleaseAsset(
    input.upload_id,
    ctx.auth.principalId,
  );
  unwrap(entry, answer);
  // Its hold lapses by itself; freed now, best effort.
  await releaseUpload(ctx.env, entry, assetHoldId(input.upload_id)).catch(() => undefined);
  return uploadOutput(entry, (answer as { ok: true; view: UploadView }).view, undefined);
}

const assetNotFound = () =>
  new OperationError(404, "asset_not_found", "The repository has no such asset.");

/** The `releases.assets.get` operation: a draft's asset is as missing as none, to a reader. */
export async function getReleaseAssetOperation(
  ctx: OpContext,
  input: Input<typeof getReleaseAsset>,
): Promise<Output<typeof getReleaseAsset>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "contents:read");
  const asset = await repo(ctx, entry, "getReleaseAsset").getReleaseAsset(input.asset_id);
  if (asset === null) throw failure(entry, "repo_not_found");
  if (!asset) throw assetNotFound();
  const release = await repo(ctx, entry, "getRelease").getRelease(asset.releaseId);
  if (!release) throw assetNotFound();
  if (release.draft && !(await authorize(ctx.env, ctx.auth, entry, "contents:write", ctx.metrics)))
    throw assetNotFound();
  return assetOutput(release, asset, entry);
}

/** The `releases.assets.delete` operation. */
export async function deleteReleaseAssetOperation(
  ctx: OpContext,
  input: Input<typeof deleteReleaseAsset>,
): Promise<Output<typeof deleteReleaseAsset>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "contents:write");
  const answer = await repo(ctx, entry, "deleteReleaseAsset").deleteReleaseAsset(
    input.asset_id,
    actorOf(ctx),
  );
  unwrap(entry, answer);
  return { id: input.asset_id, state: "deleted" };
}

/** The `releases.retained.get` operation. */
export async function getRetainedAssetsOperation(
  ctx: OpContext,
  input: Input<typeof getRetainedAssets>,
): Promise<Output<typeof getRetainedAssets>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "contents:read");
  const retained = await repo(ctx, entry, "retainedReleaseAssets").retainedReleaseAssets();
  if (retained === null) throw failure(entry, "repo_not_found");
  return { objects: retained.objects, bytes: retained.bytes, next_purge_at: retained.nextPurgeAt };
}

/** The `releases.retained.purge` operation (an admin). */
export async function purgeRetainedAssetsOperation(
  ctx: OpContext,
  input: Input<typeof purgeRetainedAssets>,
): Promise<Output<typeof purgeRetainedAssets>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "administration:write");
  const answer = await repo(ctx, entry, "purgeRetainedAssets").purgeRetainedAssets(actorOf(ctx));
  unwrap(entry, answer);
  const { objects, bytes } = answer as { ok: true; objects: number; bytes: number };
  return { state: "purging", objects, bytes };
}
