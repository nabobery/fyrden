import { createWorkersZlib } from "@fyrden/adapters-cloudflare";
import type { RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import type { RepoRole } from "@fyrden/domain";
import {
  type BlockCache,
  buildCommit,
  CommitBuildError,
  createSha1Hasher,
  type FileChange,
  GitObjectError,
  type Ident,
  isTreeMode,
  type Oid,
  oidToHex,
  PackBuilder,
  parseTree,
  type Signer,
  type TreeEntry,
} from "@fyrden/git-core";
import { pathSegments } from "../../git/cache/object-check.js";
import { buildCommandHead, readPushReport } from "../../git/chunked/head.js";
import { openLiveReader, ReadBudgetError } from "../../git/live-reader.js";
import { ACCESS_LOST, TOKEN_REVOKED } from "../../git/push/reauthorize.js";
import { reauthorizeByToken } from "../../git/push/reauthorize-token.js";
import type { RepoPush } from "../../git/push/repo-push.js";
import { BUCKET_NAME, headKey, packKey } from "../../git/push/scratch.js";
import { type Browsed, type CommitView, fail } from "./browse.js";
import { checkSignature, type SignatureCheck } from "./signature.js";

/*
 * File writes: create, update and delete files as one commit on a branch,
 * built here (blobs, the trees on the changed paths, the commit, signed
 * when a signer is set) and finished through the push path, as an import
 * is: the command section and a pack go to the upload's R2 keys, the push
 * indexes them (fsck, connectivity, commit graph), the writer's token is
 * checked again on the D1 primary, and the push commit moves the branch
 * with compare-and-set on the head the commit was built on, with every
 * commit-point check a push gets.
 */

/** Limits of one file write. Proposed. */
export const FILE_WRITE_POLICY = {
  maxChanges: 100,
  /** File content one write carries, all changes together. */
  maxContentBytes: 4 * 1024 * 1024,
  maxMessageBytes: 64 * 1024,
  /** R2 reads for the trees the write changes (Free allows 1,000 calls per invocation). */
  maxTreeReads: 300,
  /** Largest directory (tree object) a write changes: about 25,000 entries. */
  maxTreeBytes: 1024 * 1024,
  /** Tree bytes one write reads in all. */
  maxTreesBytes: 4 * 1024 * 1024,
  /**
   * Memory held per entry a tree read may hold (its parsed entry, name and
   * id, the builder's map slot; measured near 520 bytes with short names),
   * for the smallest entry a tree can have (28 bytes), on top of three
   * times the tree's bytes (its body, the rebuilt tree and its pack copy).
   */
  entryMemoryBytes: 640,
  /** Indexing steps the write waits through before it gives up (`busy`). */
  indexSteps: 4,
  /** One indexing step's time budget. */
  indexStepMs: 5_000,
  /** Pause between indexing steps that made no progress (a lock held elsewhere). */
  indexPauseMs: 200,
  /** How long the write waits for working memory before it answers `busy`. */
  memoryWaitMs: 5_000,
} as const;

export interface FileWriteChange {
  readonly path: string;
  /** New content; absent with `delete`. */
  readonly content?: Uint8Array;
  readonly delete?: true;
  readonly mode?: "file" | "executable";
  /**
   * The blob the file must be now (GitHub's `sha`): a hex id, null for
   * "must not exist", absent for no check.
   */
  readonly expectedSha?: string | null;
}

export interface FileWriteInput {
  readonly principal: string;
  readonly tokenId: string;
  readonly repoId: string;
  readonly committer: { readonly name: string; readonly email: string };
  readonly author?: { readonly name: string; readonly email: string };
  /** A branch name; the default branch when absent. */
  readonly branch?: string;
  /** The head the caller saw; the write fails if the branch is elsewhere. */
  readonly expectedHead?: string;
  readonly message: string;
  readonly changes: readonly FileWriteChange[];
}

export interface FileWriteResult {
  readonly branch: string;
  readonly commit: CommitView;
  /** The blob each change wrote, null for a deletion; in the order of `changes`. */
  readonly blobs: (string | null)[];
}

export interface FileWriteDeps {
  readonly git: RepoGitStorage;
  readonly push: RepoPush;
  readonly db: D1Database;
  readonly memoryBlocks: BlockCache;
  readonly metrics: Metrics;
  /** A principal's role for a write, from the repository's ACL snapshot. */
  readonly writerRole: (principalId: string) => Promise<RepoRole | null>;
  readonly signer?: Signer;
  readonly now?: () => number;
}

const encoder = new TextEncoder();

/** Makes the commit `input` describes and moves its branch to it. */
export async function writeFiles(
  deps: FileWriteDeps,
  input: FileWriteInput,
): Promise<Browsed<FileWriteResult>> {
  const invalid = check(input);
  if (invalid) return invalid;
  const { git } = deps;
  const snapshot = git.refStore.readRefsSync();
  const ref = input.branch ? `refs/heads/${input.branch}` : snapshot.head;
  if (!ref?.startsWith("refs/heads/"))
    return fail(409, "repo_empty", "The repository has no default branch to write to.");
  const branch = ref.slice("refs/heads/".length);
  const head = snapshot.refs.get(ref);
  // A first commit only on the default branch of an empty repository.
  if (!head && !(snapshot.refs.size === 0 && ref === snapshot.head))
    return fail(404, "branch_not_found", `No branch ${branch} was found.`);
  if (input.expectedHead !== undefined && (head ? oidToHex(head) : null) !== input.expectedHead)
    return fail(409, "head_moved", `The branch ${branch} is no longer at the expected head.`);
  const baseTree = head ? git.commitGraph.readSync([head], "verified")[0]?.tree : null;
  if (baseTree === undefined) throw new Error(`branch ${branch} points at an unknown commit`);

  const now = Math.floor((deps.now ?? Date.now)() / 1000);
  // Built and stored under one reservation; nothing of it is held while it is indexed.
  const made = await build(deps, input, { ref, head, baseTree, now });
  if (!made.ok) return made;
  const { built, upload } = made.value;
  const committed = await finishUpload(deps, input, upload);
  if (!committed.ok) return committed;
  return {
    ok: true,
    value: {
      branch,
      commit: {
        sha: oidToHex(built.commit),
        commit: {
          message: input.message,
          author: person(input.author ?? input.committer, now),
          committer: person(input.committer, now),
          tree: { sha: oidToHex(built.tree) },
          verification: built.verification,
        },
        parents: head ? [{ sha: oidToHex(head) }] : [],
      },
      blobs: built.blobs.map((b) => (b ? oidToHex(b) : null)),
    },
  };
}

/**
 * Reads the trees the write changes, builds its objects, packs them and
 * stores the pack as a push's body, with the memory for all of it
 * reserved; it all goes when this returns, which hands on only ids.
 */
async function build(
  deps: FileWriteDeps,
  input: FileWriteInput,
  at: {
    readonly ref: string;
    readonly head: Oid | undefined;
    readonly baseTree: Oid | null;
    readonly now: number;
  },
): Promise<
  Browsed<{
    built: {
      commit: Oid;
      tree: Oid;
      blobs: readonly (Oid | null)[];
      verification: SignatureCheck;
    };
    upload: StoredUpload;
  }>
> {
  const { git } = deps;
  const { ref, head, baseTree, now } = at;
  const contentBytes = input.changes.reduce((n, c) => n + (c.content?.length ?? 0), 0);
  // The content itself, the pack builder's output chunks and the pack they
  // are joined into (incompressible content is as large in all three), and
  // room for the commit and new trees.
  const memory = await git.memory.reserveWithin(
    3 * contentBytes + 2 * 1024 * 1024,
    FILE_WRITE_POLICY.memoryWaitMs,
  );
  if (!memory) return BUSY;
  let reader: Awaited<ReturnType<typeof openLiveReader>>;
  try {
    reader = await openLiveReader(deps, {
      deltaBaseCacheBytes: 4 * 1024 * 1024,
      maxCacheCalls: 40,
      maxReads: FILE_WRITE_POLICY.maxTreeReads,
    });
  } catch (error) {
    memory.release();
    throw error;
  }
  // Each tree read is bounded and its memory reserved while the write lasts.
  const holds: { release(): void }[] = [];
  const trees = new Map<string, readonly TreeEntry[] | undefined>();
  let treeBytes = 0;
  try {
    if (baseTree && !reader) throw new Error("the repository has commits but no packs");
    const readTree = async (oid: Oid): Promise<readonly TreeEntry[] | undefined> => {
      const hex = oidToHex(oid);
      if (trees.has(hex)) return trees.get(hex);
      const header = await reader?.readHeader(oid);
      if (header?.type !== "tree") return undefined;
      treeBytes += header.size;
      if (
        header.size > FILE_WRITE_POLICY.maxTreeBytes ||
        treeBytes > FILE_WRITE_POLICY.maxTreesBytes
      )
        throw new WriteRefused(TOO_WIDE);
      const mostEntries = Math.ceil(header.size / MIN_TREE_ENTRY_BYTES);
      const hold = git.memory.tryReserve(
        Math.max(1, 3 * header.size + mostEntries * FILE_WRITE_POLICY.entryMemoryBytes),
      );
      if (!hold) throw new WriteRefused(BUSY);
      holds.push(hold);
      const object = await reader?.readObject(oid);
      let entries: readonly TreeEntry[] | undefined;
      try {
        entries = object?.type === "tree" ? parseTree(object.bytes).value : undefined;
      } catch (error) {
        if (!(error instanceof GitObjectError)) throw error;
      }
      trees.set(hex, entries);
      return entries;
    };
    let shaRefused: Browsed<never> | undefined;
    try {
      shaRefused = await checkShas(input.changes, baseTree, readTree);
    } catch (error) {
      if (error instanceof ReadBudgetError) return TOO_DEEP;
      if (error instanceof WriteRefused) return error.failure;
      throw error;
    }
    if (shaRefused) return shaRefused;

    const committer = ident(input.committer, now);
    let built: Awaited<ReturnType<typeof buildCommit>>;
    try {
      built = await buildCommit({
        baseTree,
        readTree,
        changes: input.changes.map(toFileChange),
        parents: head ? [head] : [],
        author: input.author ? ident(input.author, now) : committer,
        committer,
        message: encoder.encode(input.message),
        ...(deps.signer && { signer: deps.signer }),
        // Content comes from the client: hashed with collision detection, as a push is.
        createHasher: () => createSha1Hasher(),
      });
    } catch (error) {
      if (error instanceof CommitBuildError) return buildRefused(error);
      if (error instanceof RangeError) return fail(422, "invalid_path", error.message);
      if (error instanceof ReadBudgetError) return TOO_DEEP;
      if (error instanceof WriteRefused) return error.failure;
      throw error;
    }

    const pack = await packOf(git, built.objects);
    const upload = await storeUpload(deps, input, { ref, head, commit: built.commit, pack });
    if (!upload.ok) return upload;
    return {
      ok: true,
      value: {
        built: {
          commit: built.commit,
          tree: built.tree,
          blobs: built.blobs,
          // As any reader of the commit will find it.
          verification: await checkSignature(
            built.objects.find((o) => o.type === "commit")?.data ?? new Uint8Array(0),
          ),
        },
        upload: upload.value,
      },
    };
  } finally {
    for (const hold of holds) hold.release();
    reader?.release();
    memory.release();
  }
}

/** The smallest tree entry: mode, space, a one-byte name, NUL, a 20-byte id. */
const MIN_TREE_ENTRY_BYTES = 28;

/** A write refused from inside the commit builder's tree reads. */
class WriteRefused extends Error {
  constructor(readonly failure: Browsed<never> & { ok: false }) {
    super(failure.error);
  }
}

export const BUSY = fail(409, "busy", "The repository is busy; try the write again shortly.");
const TOO_WIDE = fail(
  422,
  "too_expensive",
  `The write changes a directory too large to rewrite here (over ${FILE_WRITE_POLICY.maxTreeBytes} bytes, or ${FILE_WRITE_POLICY.maxTreesBytes} in all); push instead.`,
);
const TOO_DEEP = fail(
  422,
  "too_expensive",
  "The write changes more directories than one request may read; split it.",
);

function check(input: FileWriteInput): Browsed<never> | undefined {
  if (input.changes.length === 0) return fail(422, "invalid_input", "A write needs a change.");
  if (input.changes.length > FILE_WRITE_POLICY.maxChanges)
    return fail(
      422,
      "too_many_changes",
      `A write changes ${FILE_WRITE_POLICY.maxChanges} files at most.`,
    );
  const bytes = input.changes.reduce((n, c) => n + (c.content?.length ?? 0), 0);
  if (bytes > FILE_WRITE_POLICY.maxContentBytes)
    return fail(
      422,
      "too_large",
      `A write carries ${FILE_WRITE_POLICY.maxContentBytes} bytes of content at most.`,
    );
  if (encoder.encode(input.message).length > FILE_WRITE_POLICY.maxMessageBytes)
    return fail(422, "invalid_input", "The commit message is too long.");
  if (input.message.trim() === "") return fail(422, "invalid_input", "A commit needs a message.");
  for (const who of [input.committer, input.author])
    if (who && (!validIdentPart(who.name) || !validIdentPart(who.email) || who.email === ""))
      return fail(422, "invalid_input", "A name or email cannot contain '<', '>' or a line break.");
  for (const change of input.changes) {
    const segments = pathSegments(change.path);
    if (!segments || segments.length === 0)
      return fail(422, "invalid_path", `${change.path} is not a valid path.`);
    if ((change.content === undefined) === (change.delete === undefined))
      return fail(422, "invalid_input", `${change.path}: give either content or delete.`);
  }
  return undefined;
}

/** Checks each change's expected blob against the base tree. */
async function checkShas(
  changes: readonly FileWriteChange[],
  baseTree: Oid | null,
  readTree: (oid: Oid) => Promise<readonly TreeEntry[] | undefined>,
): Promise<Browsed<never> | undefined> {
  for (const change of changes) {
    if (change.expectedSha === undefined) continue;
    const current = baseTree ? await blobAt(baseTree, change.path, readTree) : null;
    if (current !== change.expectedSha)
      return fail(
        409,
        "sha_mismatch",
        current === null
          ? `${change.path} does not exist.`
          : `${change.path} is at ${current}, not ${change.expectedSha ?? "absent"}.`,
      );
  }
  return undefined;
}

/** The blob id of the file at `path` below `root`, or null when no file is there. */
async function blobAt(
  root: Oid,
  path: string,
  readTree: (oid: Oid) => Promise<readonly TreeEntry[] | undefined>,
): Promise<string | null> {
  const segments = pathSegments(path) ?? [];
  let tree: Oid = root;
  for (const [i, name] of segments.entries()) {
    const entries = await readTree(tree);
    const entry = entries?.find((e) => sameBytes(e.name, name));
    if (!entry) return null;
    if (i === segments.length - 1)
      return isTreeMode(entry.mode) || entry.mode === 0o160000 ? null : oidToHex(entry.oid);
    if (!isTreeMode(entry.mode)) return null;
    tree = entry.oid;
  }
  return null;
}

/** Who makes a write, and where: what the push path checks at its commit point. */
export type WriterOf<T extends FileWriteInput> = Pick<T, "principal" | "tokenId" | "repoId">;

/** A write stored as a push's body: its upload and scratch objects. */
export interface StoredUpload {
  readonly uploadId: string;
  readonly keys: readonly string[];
}

/**
 * Stores the write's command section and pack as a push's body. On a
 * failure nothing is left behind (the upload is aborted and its scratch
 * objects deleted).
 */
export async function storeUpload(
  deps: FileWriteDeps,
  input: WriterOf<FileWriteInput>,
  write: {
    readonly ref: string;
    readonly head: Oid | undefined;
    readonly commit: Oid;
    readonly pack: Uint8Array;
  },
): Promise<Browsed<StoredUpload>> {
  const { git, push, metrics } = deps;
  const begun = push.begin({ principal: input.principal, tokenId: input.tokenId });
  if (!begun.ok) return fail(404, "repo_not_found", begun.error);
  const networkId = git.networkId();
  const upload = {
    uploadId: begun.uploadId,
    keys: [headKey(networkId, begun.uploadId), packKey(networkId, begun.uploadId)],
  };
  let stored = false;
  try {
    const head = buildCommandHead([
      {
        ref: write.ref,
        old: write.head ? oidToHex(write.head) : null,
        new: oidToHex(write.commit),
      },
    ]);
    metrics.count("r2.class_a", { bucket: BUCKET_NAME, op: "put_head" });
    await git.bucket.put(upload.keys[0] as string, head);
    metrics.count("r2.class_a", { bucket: BUCKET_NAME, op: "put_pack" });
    await git.bucket.put(upload.keys[1] as string, write.pack);
    stored = push.splitBodyStored(upload.uploadId, {
      kind: "parts",
      headBytes: head.length,
      packBytes: write.pack.length,
    });
    return stored ? { ok: true, value: upload } : BUSY;
  } finally {
    if (!stored) await discard(deps, upload);
  }
}

/**
 * Indexes a stored write, checks the writer's token again and commits it
 * (the branch moves only from the head the commit was built on).
 */
export async function finishUpload(
  deps: FileWriteDeps,
  input: WriterOf<FileWriteInput>,
  upload: StoredUpload,
): Promise<Browsed<true>> {
  const { push } = deps;
  const { uploadId } = upload;
  let finalized = false;
  try {
    for (let step = 0; ; step++) {
      const progress = await push.status(uploadId, FILE_WRITE_POLICY.indexStepMs);
      if (progress.state === "ready") break;
      if (progress.state === "done") return refused(readPushReport(progress.response));
      // Indexing could not go on in this invocation (its lock or call budget is taken).
      if (step + 1 >= FILE_WRITE_POLICY.indexSteps) return BUSY;
      await new Promise((resolve) => setTimeout(resolve, FILE_WRITE_POLICY.indexPauseMs));
    }
    const decision = await reauthorizeByToken(
      deps.db,
      { tokenId: input.tokenId, principal: input.principal, repoId: input.repoId },
      deps.writerRole,
    );
    const response = await push.finalize(uploadId, decision, { repoId: input.repoId });
    // The push has settled its upload and scratch objects, committed or not.
    finalized = true;
    const report = readPushReport(response);
    return report.ok ? { ok: true, value: true } : refused(report);
  } finally {
    if (!finalized) await discard(deps, upload);
  }
}

/** Aborts an upload and deletes its scratch objects (its row may be gone already). */
async function discard(deps: FileWriteDeps, upload: StoredUpload): Promise<void> {
  await deps.push.abort(upload.uploadId);
  deps.metrics.count("r2.class_a", { bucket: BUCKET_NAME, op: "delete_scratch" });
  await deps.git.bucket.delete([...upload.keys]).catch(() => undefined);
}

/** A version 2 pack of `objects`, whole objects only. */
export async function packOf(
  git: RepoGitStorage,
  objects: readonly { type: "blob" | "tree" | "commit" | "tag"; oid: Oid; data: Uint8Array }[],
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const builder = await PackBuilder.start(objects.length, {
    sink: {
      async write(chunk) {
        chunks.push(chunk.slice());
      },
    },
    zlib: createWorkersZlib(),
    memory: git.memory,
  });
  try {
    for (const object of objects) await builder.addObject(object.type, object.data, object.oid);
    const finished = await builder.finish();
    finished.release();
  } finally {
    builder.release();
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** A push report's refusal, as the API answers it. */
function refused(report: ReturnType<typeof readPushReport>): Browsed<never> {
  const reason = report.ok ? "" : report.error;
  // The branch is not where the commit was built: moved, created or deleted meanwhile.
  if (
    reason.includes("incorrect old value provided") ||
    reason.includes("reference already exists") ||
    reason.includes("reference does not exist")
  )
    return fail(409, "head_moved", "The branch moved while the commit was being made; try again.");
  if (reason.includes(TOKEN_REVOKED))
    return fail(403, "token_revoked", "The token was revoked before the commit was made.");
  if (reason.includes(ACCESS_LOST))
    return fail(404, "repo_not_found", "You no longer have write access to this repository.");
  return fail(422, "write_refused", reason || "The write was refused.");
}

function buildRefused(error: CommitBuildError): Browsed<never> {
  switch (error.code) {
    case "not_found":
      return fail(404, "path_not_found", error.message);
    case "no_change":
      return fail(422, "no_change", error.message);
    default:
      return fail(422, error.code, error.message);
  }
}

function toFileChange(change: FileWriteChange): FileChange {
  const path = (pathSegments(change.path) ?? []) as Uint8Array[];
  return change.delete
    ? { path, delete: true }
    : { path, content: change.content as Uint8Array, ...(change.mode && { mode: change.mode }) };
}

export function ident(who: { readonly name: string; readonly email: string }, now: number): Ident {
  return {
    name: encoder.encode(who.name),
    email: encoder.encode(who.email),
    timestamp: now,
    timezone: "+0000",
  };
}

export function person(who: { readonly name: string; readonly email: string }, now: number) {
  return {
    name: who.name,
    email: who.email,
    date: new Date(now * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
}

/** What git can store as an ident's name or email. */
function validIdentPart(text: string): boolean {
  return !/[<>\n\0]/.test(text) && text === text.trimEnd() && text.length <= 256;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
