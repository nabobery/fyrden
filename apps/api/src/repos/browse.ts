import type {
  compareCommits,
  getArchive,
  getBranch,
  getCodeOwnersErrors,
  getCommit,
  getContents,
  getReadme,
  getRootContents,
  getTree,
  Input,
  listBranches,
  listCommits,
  listTags,
  Output,
} from "@fyrden/api-contract";
import type { Browsed } from "../do/repo/browse.js";
import type { ContentsView, DirCursor } from "../do/repo/contents.js";
import { repoFor } from "../git/chunked/operations.js";
import {
  decodeBytesCursor,
  decodeCursor,
  encodeBytesCursor,
  encodeCursor,
  invalidCursor,
} from "../ops/cursor.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { resolveOne, resolveVerification } from "../signing/verification.js";

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
  ctx.metrics.count("do.request", { class: "RepoDO", method: "protectedBranches" });
  const protection = await stub.protectedBranches(page.map((b) => b.name));
  return {
    branches: page.map((b, i) => ({ ...b, protected: protection[i] ?? false })),
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
  ctx.metrics.count("do.request", { class: "RepoDO", method: "protectedBranches" });
  const [isProtected] = await stub.protectedBranches([branch.name]);
  return {
    name: branch.name,
    commit: await resolveOne(ctx, commit),
    protected: isProtected ?? false,
  };
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
  return {
    commits: await resolveVerification(ctx, log.commits),
    next_cursor: encodeLogCursor(log.next),
  };
}

/** The `repos.commits.get` operation. */
export async function getCommitOperation(
  ctx: OpContext,
  input: Input<typeof getCommit>,
): Promise<Output<typeof getCommit>> {
  const stub = await repoStub(ctx, input.owner, input.repo);
  ctx.metrics.count("do.request", { class: "RepoDO", method: "browseCommit" });
  return resolveOne(ctx, value(await stub.browseCommit(input.ref)));
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
    base_commit: await resolveOne(ctx, compared.baseCommit),
    merge_base_commit: await resolveOne(ctx, compared.mergeBaseCommit),
    commits: await resolveVerification(ctx, compared.commits),
  };
}

/** A directory page cursor: the directory's tree id (20 bytes), then the entry's position (4). */
function decodeDirCursor(cursor: string | undefined): DirCursor | undefined {
  if (cursor === undefined) return undefined;
  const bytes = decodeBytesCursor(cursor);
  if (!bytes || bytes.length !== OID_BYTES + 4) throw invalidCursor();
  const tree = Array.from(bytes.subarray(0, OID_BYTES), (b) => b.toString(16).padStart(2, "0"));
  const index = new DataView(bytes.buffer, bytes.byteOffset + OID_BYTES, 4).getUint32(0);
  return { tree: tree.join(""), index };
}

function encodeDirCursor(cursor: DirCursor | null): string | null {
  if (cursor === null) return null;
  const bytes = new Uint8Array(OID_BYTES + 4);
  bytes.set(Uint8Array.from(cursor.tree.match(/../g) ?? [], (b) => Number.parseInt(b, 16)));
  new DataView(bytes.buffer).setUint32(OID_BYTES, cursor.index);
  return encodeBytesCursor(bytes);
}

/** The URL of a file's raw bytes at one commit (the raw route, outside the registry). */
function rawUrl(ctx: OpContext, owner: string, repo: string, path: string, commit: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const url = new URL(`/api/repos/${owner}/${repo}/raw/${encoded}`, ctx.requestOrigin);
  url.searchParams.set("ref", commit);
  return url.href;
}

/** The API shape of what a path names. */
function contentsOutput(
  ctx: OpContext,
  input: { readonly owner: string; readonly repo: string },
  { commit, view }: { commit: string; view: ContentsView },
): Output<typeof getContents> {
  switch (view.type) {
    case "dir":
      return {
        type: "dir",
        path: view.path,
        sha: view.sha,
        entries: view.entries,
        next_cursor: encodeDirCursor(view.next),
      };
    case "file":
      return {
        type: "file",
        path: view.path,
        name: view.name,
        sha: view.sha,
        mode: view.mode,
        size: view.size,
        encoding: view.content === null ? "none" : "base64",
        content: view.content ?? "",
        download_url: rawUrl(ctx, input.owner, input.repo, view.path, commit),
      };
    default:
      return view;
  }
}

async function contentsOf(
  ctx: OpContext,
  input: Input<typeof getRootContents> & { readonly path?: string },
): Promise<Output<typeof getContents>> {
  const stub = await repoStub(ctx, input.owner, input.repo);
  ctx.metrics.count("do.request", { class: "RepoDO", method: "browseContents" });
  const after = decodeDirCursor(input.cursor);
  const found = value(
    await stub.browseContents({
      ...(input.ref !== undefined && { ref: input.ref }),
      path: input.path ?? "",
      ...(after !== undefined && { after }),
      limit: input.per_page,
    }),
  );
  return contentsOutput(ctx, input, found);
}

/** The `repos.contents.get` operation. */
export function getContentsOperation(
  ctx: OpContext,
  input: Input<typeof getContents>,
): Promise<Output<typeof getContents>> {
  return contentsOf(ctx, input);
}

/** The `repos.contents.root` operation. */
export function getRootContentsOperation(
  ctx: OpContext,
  input: Input<typeof getRootContents>,
): Promise<Output<typeof getRootContents>> {
  return contentsOf(ctx, input);
}

/** The `repos.readme.get` operation. */
export async function getReadmeOperation(
  ctx: OpContext,
  input: Input<typeof getReadme>,
): Promise<Output<typeof getReadme>> {
  const stub = await repoStub(ctx, input.owner, input.repo);
  ctx.metrics.count("do.request", { class: "RepoDO", method: "browseReadme" });
  return contentsOutput(ctx, input, value(await stub.browseReadme(input.ref)));
}

/** The `repos.codeowners.errors` operation (GitHub's). */
export async function getCodeOwnersErrorsOperation(
  ctx: OpContext,
  input: Input<typeof getCodeOwnersErrors>,
): Promise<Output<typeof getCodeOwnersErrors>> {
  const stub = await repoStub(ctx, input.owner, input.repo);
  ctx.metrics.count("do.request", { class: "RepoDO", method: "codeOwnersErrors" });
  const { errors, truncated, file, commit } = value(await stub.codeOwnersErrors(input.ref));
  // An earlier object (while a deploy rolls out) answers without the file read: try again.
  if (!file || typeof commit !== "string")
    throw new OperationError(409, "busy", "The repository is busy; try again.");
  return {
    errors: errors.map((e) => ({ ...e })),
    ...(truncated && { truncated: true }),
    file: { path: file.path, sha: file.sha },
    sha: commit,
  };
}

/** The `repos.trees.get` operation. */
export async function getTreeOperation(
  ctx: OpContext,
  input: Input<typeof getTree>,
): Promise<Output<typeof getTree>> {
  const stub = await repoStub(ctx, input.owner, input.repo);
  ctx.metrics.count("do.request", { class: "RepoDO", method: "browseTree" });
  const recursive = input.recursive === "1" || input.recursive === "true";
  const listing = value(await stub.browseTree(input.tree_sha, recursive));
  return { sha: listing.sha, tree: listing.entries, truncated: listing.truncated };
}

/** The `repos.archives.get` operation: starts or finds the archive, and links the download route. */
export async function getArchiveOperation(
  ctx: OpContext,
  input: Input<typeof getArchive>,
): Promise<Output<typeof getArchive>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "contents:read");
  ctx.metrics.count("do.request", { class: "RepoDO", method: "archive" });
  const status = value(
    await ctx.env.REPO.getByName(entry.id).archive({
      ...(input.ref !== undefined && { ref: input.ref }),
      format: input.format,
      prefix: `${entry.ownerHandle}-${entry.name}`,
    }),
  );
  const route = input.format === "zip" ? "zipball" : "tarball";
  const url = new URL(
    `/api/repos/${entry.ownerHandle}/${entry.name}/${route}/${status.commit}`,
    ctx.requestOrigin,
  );
  return {
    state: status.state,
    commit: status.commit,
    size: status.state === "ready" ? status.bytes : null,
    download_url: url.href,
  };
}
