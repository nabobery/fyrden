import { dohResolver } from "@fyrden/adapters-cloudflare/net";
import type { createImport, getImport, Input, Output } from "@fyrden/api-contract";
import { type OpContext, OperationError } from "../../ops/execute.js";
import { repoFor } from "../chunked/operations.js";
import { chunkedTuning } from "../chunked/tuning.js";
import type { ImportRecord } from "./job.js";
import { checkImportUrl, importPolicy, ownHostsOf } from "./network.js";

/** The Worker side of the `imports.*` operations; the import runs in the repository object (./job.ts). */

type RepoImport = Output<typeof createImport>;

function output(record: ImportRecord): RepoImport {
  return {
    id: record.uploadId,
    state: record.state,
    source_url: record.url,
    bytes_received: record.bytes,
    refs_imported: record.state === "committed" ? [...record.refs] : [],
    refs_skipped: record.skipped.map((s) => ({ ...s })),
    ...(record.head && record.state === "committed" ? { default_branch: record.head } : {}),
    ...(record.error ? { error: record.error } : {}),
    started_at: record.startedAt,
    updated_at: record.updatedAt,
  };
}

export async function startImport(
  ctx: OpContext,
  input: Input<typeof createImport>,
): Promise<RepoImport> {
  const repo = await repoFor(ctx, input.owner, input.repo, "contents:write");
  const ownHosts = ownHostsOf(ctx.env, ctx.requestHost);
  const check = await checkImportUrl(input.url, importPolicy(ownHosts, dohResolver()));
  if (!check.ok)
    throw new OperationError(
      422,
      "url_refused",
      `The source URL is not allowed (${check.reason}): it must be a public https git URL.`,
    );
  const tuning = chunkedTuning(ctx.env);
  const begun = await ctx.env.REPO.getByName(repo.id).beginImport({
    principal: ctx.auth.principalId,
    tokenId: ctx.auth.id,
    grantId: ctx.auth.grantId,
    repoId: repo.id,
    url: check.url,
    ownHosts,
    requestId: ctx.requestId ?? null,
    limits: {
      maxBytes: tuning.maxImportBytes,
      maxMs: tuning.maxImportMs,
      partBytes: tuning.partBytes,
    },
  });
  if (!begun.ok)
    throw new OperationError(begun.code === "repo_not_found" ? 404 : 409, begun.code, begun.error);
  return output(begun.record);
}

export async function getRepoImport(
  ctx: OpContext,
  input: Input<typeof getImport>,
): Promise<RepoImport> {
  const repo = await repoFor(ctx, input.owner, input.repo, "contents:read");
  const record = await ctx.env.REPO.getByName(repo.id).importRecord();
  if (!record) throw new OperationError(404, "import_not_found", "This repository has no import.");
  return output(record);
}
