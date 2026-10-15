import type { completeUpload, createUpload, getUpload, Input, Output } from "@fyrden/api-contract";
import { PERMISSIONS, type RepoPermission } from "@fyrden/domain";
import { type OpContext, OperationError } from "../../ops/execute.js";
import { authorize, type RepoEntry, resolveRepo } from "../../repos/directory.js";
import { reserveUpload } from "../push/quota.js";
import { reauthorizeWriter } from "../push/reauthorize.js";
import { pushTuning } from "../push/tuning.js";
import {
  buildCommandHead,
  type PushReportSummary,
  readPushReport,
  refUpdateProblem,
} from "./head.js";
import type { ChunkedFailure, ChunkedView } from "./session.js";
import { chunkedTuning } from "./tuning.js";

/*
 * The Worker side of the `uploads.*` operations. The repository object
 * owns the session (./session.ts); the parts arrive at ./parts-route.ts.
 */

type Session = Output<typeof createUpload>;
type SessionInput = Input<typeof getUpload>;

/** The repository, if the caller may use it so; missing and forbidden look the same. */
export async function repoFor(
  ctx: OpContext,
  owner: string,
  repo: string,
  permission: RepoPermission,
): Promise<RepoEntry> {
  const entry = await resolveRepo(ctx.env, owner, repo, {
    consistency: PERMISSIONS[permission].writes ? "primary" : "cached",
    metrics: ctx.metrics,
  });
  if (!entry || !(await authorize(ctx.env, ctx.auth, entry, permission, ctx.metrics)))
    throw new OperationError(404, "repo_not_found", `No repository ${owner}/${repo} was found.`);
  return entry;
}

function unwrap<T extends { readonly ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) {
    const failure = result as unknown as ChunkedFailure;
    throw new OperationError(failure.status, failure.code, failure.error);
  }
  return result as Extract<T, { ok: true }>;
}

function output(repo: RepoEntry, view: ChunkedView, report?: PushReportSummary): Session {
  const refs = report?.refs ?? view.refs;
  const error = report && !report.ok ? report.error : view.error;
  return {
    id: view.uploadId,
    state: view.state,
    size: view.size,
    part_size: view.partBytes,
    part_count: view.partCount,
    parts_received: view.partsReceived,
    parts_url: `/${repo.ownerHandle}/${repo.name}.git/uploads/${view.uploadId}/parts`,
    expires_at: view.expiresAt,
    ...(refs ? { refs } : {}),
    ...(error ? { error } : {}),
  };
}

export async function createUploadSession(
  ctx: OpContext,
  input: Input<typeof createUpload>,
): Promise<Session> {
  const repo = await repoFor(ctx, input.owner, input.repo, "contents:write");
  const tuning = chunkedTuning(ctx.env);
  if (input.size > tuning.maxUploadBytes)
    throw new OperationError(
      422,
      "upload_too_large",
      `This server takes uploads of at most ${tuning.maxUploadBytes} bytes.`,
    );
  for (const update of input.ref_updates) {
    const problem = refUpdateProblem(update);
    if (problem) throw new OperationError(422, "invalid_ref_update", `${update.ref}: ${problem}.`);
  }
  if (input.ref_updates.every((u) => u.new === null))
    throw new OperationError(422, "no_pack_needed", "Only deletions: push them with git push.");
  const begun = unwrap(
    await ctx.env.REPO.getByName(repo.id).beginChunked({
      principal: ctx.auth.principalId,
      tokenId: ctx.auth.id,
      grantId: ctx.auth.grantId,
      size: input.size,
      partBytes: tuning.partBytes,
      updates: input.ref_updates,
    }),
  );
  // The account's storage for the whole upload, held until it commits or ends.
  ctx.metrics.count("do.request", { class: "OrgDO", method: "reserveStorage" });
  // What its commit is charged: the command section and the pack.
  const bodyBytes = buildCommandHead(input.ref_updates).length + input.size;
  // Not reserved (or not known to be): the session goes, and what it holds with it.
  const abort = () =>
    ctx.env.REPO.getByName(repo.id).abortChunked(begun.view.uploadId, ctx.auth.principalId);
  const reservation = await reserveUpload(ctx.env, repo, begun.view.uploadId, {
    declared: bodyBytes,
    maxBytes: bodyBytes,
    ttlMs: Math.max(0, begun.view.expiresAt - Date.now()) + RESERVATION_MARGIN_MS,
  }).catch(async (error: unknown) => {
    await abort().catch(() => undefined);
    throw error;
  });
  if (!reservation.ok) {
    await abort();
    throw new OperationError(403, "quota_exceeded", `${reservation.message}.`);
  }
  return output(repo, begun.view);
}

/** How much longer than its session a chunked upload's reservation lasts. */
const RESERVATION_MARGIN_MS = 60 * 60 * 1000;

export async function getUploadSession(ctx: OpContext, input: SessionInput): Promise<Session> {
  const repo = await repoFor(ctx, input.owner, input.repo, "contents:read");
  const stub = ctx.env.REPO.getByName(repo.id);
  return output(repo, unwrap(await stub.chunkedView(input.upload_id, ctx.auth.principalId)).view);
}

export async function abortUploadSession(ctx: OpContext, input: SessionInput): Promise<Session> {
  const repo = await repoFor(ctx, input.owner, input.repo, "contents:write");
  const stub = ctx.env.REPO.getByName(repo.id);
  return output(repo, unwrap(await stub.abortChunked(input.upload_id, ctx.auth.principalId)).view);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Assembles the parts and drives the push path: waits up to the configured
 * time for indexing (polling with a growing delay, as a push does), then
 * re-authorizes the caller and commits. Still indexing: answers
 * `indexing`, and the client calls again.
 */
export async function completeUploadSession(
  ctx: OpContext,
  input: Input<typeof completeUpload>,
): Promise<Session> {
  const repo = await repoFor(ctx, input.owner, input.repo, "contents:write");
  const stub = ctx.env.REPO.getByName(repo.id);
  const push = pushTuning(ctx.env);
  const deadline = Date.now() + chunkedTuning(ctx.env).completeWaitMs;
  let { progress } = unwrap(
    await stub.completeChunked(
      input.upload_id,
      ctx.auth.principalId,
      ctx.auth.id,
      push.indexBudgetMs,
    ),
  );
  let pollMs = push.pollMs;
  while (progress.state === "indexing" && Date.now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    pollMs = Math.min(pollMs * 2, push.maxPollMs);
    progress = await stub.pushStatus(input.upload_id, push.indexBudgetMs);
  }
  let report: PushReportSummary | undefined;
  if (progress.state === "ready") {
    const decision = await reauthorizeWriter(
      { env: ctx.env, authState: ctx.authState, metrics: ctx.metrics, requestId: ctx.requestId },
      { auth: ctx.auth, repo },
      { owner: repo.ownerHandle, name: repo.name },
    );
    const response = await stub.finalizePush(input.upload_id, decision, {
      requestId: ctx.requestId,
      repoId: repo.id,
    });
    report = readPushReport(response);
  } else if (progress.state === "done") {
    report = readPushReport(progress.response);
  }
  const view = unwrap(await stub.chunkedView(input.upload_id, ctx.auth.principalId)).view;
  return output(repo, view, report);
}
