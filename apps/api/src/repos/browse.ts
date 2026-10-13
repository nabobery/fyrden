import type {
  compareCommits,
  getBranch,
  getCommit,
  Input,
  listBranches,
  listCommits,
  listTags,
  Output,
} from "@fyrden/api-contract";
import type { Browsed } from "../do/repo/browse.js";
import { repoFor } from "../git/chunked/operations.js";
import {
  decodeBytesCursor,
  decodeCursor,
  encodeBytesCursor,
  encodeCursor,
  invalidCursor,
} from "../ops/cursor.js";
import { type OpContext, OperationError } from "../ops/execute.js";

/*
 * Branches, tags, commits and comparisons, answered by the repository's
 * object from its own verified commits. Reading needs `contents:read`.
 */

function value<T>(result: Browsed<T>): T {
  if (!result.ok) throw new OperationError(result.status, result.code, result.error);
  return result.value;
}

async function repoStub(ctx: OpContext, owner: string, repo: string) {
  const entry = await repoFor(ctx, owner, repo, "contents:read");
  return ctx.env.REPO.getByName(entry.id);
}

/** Any name a ref listing could have returned. */
const anyName = (name: string) => name.length > 0 && name.length <= 1024;

/** The `repos.branches.list` operation. */
export async function listBranchesOperation(
  ctx: OpContext,
  input: Input<typeof listBranches>,
): Promise<Output<typeof listBranches>> {
  const stub = await repoStub(ctx, input.owner, input.repo);
  const after = decodeCursor(input.cursor, anyName);
  ctx.metrics.count("do.request", { class: "RepoDO", method: "browseBranches" });
  const rows = await stub.browseBranches(after, input.per_page + 1);
  const page = rows.slice(0, input.per_page);
  const last = page.at(-1);
  return {
    branches: page.map((b) => ({ ...b, protected: false })),
    next_cursor: rows.length > input.per_page && last ? encodeCursor(last.name) : null,
  };
}

/** The `repos.branches.get` operation. */
export async function getBranchOperation(
  ctx: OpContext,
  input: Input<typeof getBranch>,
): Promise<Output<typeof getBranch>> {
  const stub = await repoStub(ctx, input.owner, input.repo);
  ctx.metrics.count("do.request", { class: "RepoDO", method: "browseBranch" });
  const branch = value(await stub.browseBranch(input.branch));
  ctx.metrics.count("do.request", { class: "RepoDO", method: "browseCommit" });
  const commit = value(await stub.browseCommit(branch.commit.sha));
  return { name: branch.name, commit, protected: false };
}

/** The `repos.tags.list` operation. */
export async function listTagsOperation(
  ctx: OpContext,
  input: Input<typeof listTags>,
): Promise<Output<typeof listTags>> {
  const stub = await repoStub(ctx, input.owner, input.repo);
  const after = decodeCursor(input.cursor, anyName);
  ctx.metrics.count("do.request", { class: "RepoDO", method: "browseTags" });
  // A page can be short (tags of other objects are left out) and still have a next one.
  const { tags, next } = value(await stub.browseTags(after, input.per_page));
  return { tags, next_cursor: next === null ? null : encodeCursor(next) };
}

const OID_BYTES = 20;

/** A log cursor: the next page's start commits, 20 bytes each. */
function encodeLogCursor(next: readonly string[]): string | null {
  if (next.length === 0) return null;
  return encodeBytesCursor(
    Uint8Array.from(next.join("").match(/../g) ?? [], (b) => Number.parseInt(b, 16)),
  );
}

/** Most commits a log cursor carries (the repository's object checks it again). */
const MAX_LOG_CURSOR_OIDS = 256;

function decodeLogCursor(cursor: string): string[] {
  const bytes = decodeBytesCursor(cursor);
  if (
    !bytes ||
    bytes.length === 0 ||
    bytes.length % OID_BYTES !== 0 ||
    bytes.length / OID_BYTES > MAX_LOG_CURSOR_OIDS
  )
    throw invalidCursor();
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return hex.match(/.{40}/g) ?? [];
}

/** The `repos.commits.list` operation. */
export async function listCommitsOperation(
  ctx: OpContext,
  input: Input<typeof listCommits>,
): Promise<Output<typeof listCommits>> {
  const stub = await repoStub(ctx, input.owner, input.repo);
  ctx.metrics.count("do.request", { class: "RepoDO", method: "browseLog" });
  const log = value(
    await stub.browseLog({
      ...(input.cursor !== undefined
        ? { cursor: decodeLogCursor(input.cursor) }
        : input.sha !== undefined && { ref: input.sha }),
      ...(input.path !== undefined && { path: input.path }),
      limit: input.per_page,
    }),
  );
  return { commits: log.commits, next_cursor: encodeLogCursor(log.next) };
}

/** The `repos.commits.get` operation. */
export async function getCommitOperation(
  ctx: OpContext,
  input: Input<typeof getCommit>,
): Promise<Output<typeof getCommit>> {
  const stub = await repoStub(ctx, input.owner, input.repo);
  ctx.metrics.count("do.request", { class: "RepoDO", method: "browseCommit" });
  return value(await stub.browseCommit(input.ref));
}

/** The `repos.compare` operation. */
export async function compareCommitsOperation(
  ctx: OpContext,
  input: Input<typeof compareCommits>,
): Promise<Output<typeof compareCommits>> {
  const stub = await repoStub(ctx, input.owner, input.repo);
  const at = input.basehead.indexOf("...");
  if (at <= 0 || at + 3 >= input.basehead.length)
    throw new OperationError(422, "invalid_basehead", "Compare `base...head`.");
  ctx.metrics.count("do.request", { class: "RepoDO", method: "browseCompare" });
  const compared = value(
    await stub.browseCompare(input.basehead.slice(0, at), input.basehead.slice(at + 3)),
  );
  return {
    status: compared.status,
    ahead_by: compared.aheadBy,
    behind_by: compared.behindBy,
    total_commits: compared.aheadBy,
    base_commit: compared.baseCommit,
    merge_base_commit: compared.mergeBaseCommit,
    commits: compared.commits,
  };
}
