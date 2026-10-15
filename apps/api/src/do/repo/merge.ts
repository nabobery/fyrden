import type { SqliteCommitGraph } from "@fyrden/adapters-cloudflare/git";
import type { GitPerson, MergeContext } from "@fyrden/domain";
import {
  baseTreeOf,
  type Commit,
  createSha1Hasher,
  encodeCommit,
  type History,
  hashObject,
  MergeBudget,
  type MergeConflict,
  MergeLimitError,
  mergeBases,
  mergeTrees,
  type NewObject,
  type ObjectSource,
  type Oid,
  oidToHex,
  parseTree,
  type TreeEntry,
  WalkLimitError,
} from "@fyrden/git-core";
import type { PushReportSummary } from "../../git/chunked/head.js";
import { openLiveReader, ReadBudgetError } from "../../git/live-reader.js";
import { BROWSE_POLICY, type Browsed, fail } from "./browse.js";
import {
  BUSY,
  type FileWriteDeps,
  type FileWriteInput,
  finishUpload,
  ident,
  packOf,
  refused,
  type StoredUpload,
  storeUpload,
  type WriterOf,
} from "./file-writes.js";

/*
 * Merging a pull request: the base branch's tip and the pull request's head
 * are merged here (a three-way merge from their merge base, or from a
 * virtual base when there are several), the merge or squash commit is
 * built and signed, and it is finished through the push path as a file
 * write is: indexed, the merger's token checked again, the rulesets judged
 * with the pull request's own records, and the base branch moved with
 * compare-and-set on the tip the merge was made from. In the same
 * transaction the pull request becomes merged.
 */

/** Limits of one merge. Proposed (Workers Free: 1,000 subrequests, 128 MB). */
export const MERGE_POLICY = {
  /**
   * R2 reads for the trees and files the merge reads. As a file write's:
   * the push's indexing runs in the same invocation (its first
   * connectivity batch checks up to 512 objects without a call limit), and
   * the whole must stay within Free's 1,000 subrequests.
   */
  maxReads: 300,
  /** Trees read, the virtual base's included. */
  maxTrees: 1_500,
  /** The largest tree read, in bytes (about 37,000 entries; its memory hold stays well within the object's). */
  maxTreeBytes: 1024 * 1024,
  /** Tree and file bytes one merge reads in all. */
  maxReadBytes: 24 * 1024 * 1024,
  /**
   * Memory held per entry a tree read may hold (its parsed entry, name and
   * id, the merge's map slot), for the smallest entry a tree can have (28
   * bytes), on top of three times the tree's bytes, as a file write holds.
   */
  entryMemoryBytes: 640,
  /** The largest side of a file merged line by line; a larger one changed on both sides conflicts. */
  maxFileBytes: 1024 * 1024,
  /** Files merged line by line. */
  maxFileMerges: 300,
  /** Bytes of new objects (merged files, trees) one merge makes. */
  maxOutputBytes: 4 * 1024 * 1024,
  /** Commits walked to find merge bases. */
  maxCommits: 3 * BROWSE_POLICY.compareMaxCommits,
  /** Conflicting paths named in a refusal. */
  conflictsShown: 10,
  /** How long the merge waits for working memory before it answers `busy`. */
  memoryWaitMs: 5_000,
} as const;
export type MergePolicy = { readonly [K in keyof typeof MERGE_POLICY]: number };

/** Why a merge's commit was refused because the pull request changed meanwhile. */
export const PULL_CHANGED =
  "the pull request changed while it was being merged; review it and try the merge again";

export interface MergeRun {
  readonly writer: WriterOf<FileWriteInput>;
  readonly method: "merge" | "squash";
  /** The base branch, as a full ref name, and its tip the merge is made from. */
  readonly baseRef: string;
  readonly baseTip: Oid;
  readonly head: Oid;
  /** The head contains the base tip: the merged tree is the head's. */
  readonly upToDate: boolean;
  readonly author: GitPerson;
  readonly committer: GitPerson;
  readonly message: string;
  /** What the commit point needs of the pull request: its rules' context, the fence and the record. */
  readonly merge: MergeContext;
  readonly fence: () => string | undefined;
  /** In the commit's transaction, with the commit made: the pull request becomes merged. */
  readonly inCommit: (commit: Oid) => void;
  /** Runs with the commit stored, before it is finished. For tests. */
  readonly beforeFinish?: () => Promise<void>;
}

export interface MergeMade {
  readonly sha: string;
}

/** Merges a pull request as `run` says: builds the commit and moves the base branch to it. */
export async function mergePull(
  deps: FileWriteDeps,
  run: MergeRun,
  policy: MergePolicy = MERGE_POLICY,
): Promise<Browsed<MergeMade>> {
  // The new objects, the pack builder's chunks and the pack, and room for the
  // commit: held until the pack is stored, which hands on only ids.
  const memory = await deps.git.memory.reserveWithin(
    3 * policy.maxOutputBytes + 1024 * 1024,
    policy.memoryWaitMs,
  );
  if (!memory) return BUSY;
  let commit: Oid;
  let upload: Browsed<StoredUpload>;
  try {
    const made = await build(deps, run, policy);
    if (!made.ok) return made;
    commit = made.value.commit;
    upload = await storeUpload(deps, run.writer, {
      ref: run.baseRef,
      head: run.baseTip,
      commit,
      pack: made.value.pack,
    });
  } finally {
    memory.release();
  }
  if (!upload.ok) return upload;
  await run.beforeFinish?.();
  const committed = await finishUpload(
    deps,
    run.writer,
    upload.value,
    { merge: run.merge, fence: run.fence, inCommit: () => run.inCommit(commit), via: "merge" },
    mergeRefused,
  );
  return committed.ok ? { ok: true, value: { sha: oidToHex(commit) } } : committed;
}

/** The merged tree, the commit on it and their pack (the caller holds their memory). */
async function build(
  deps: FileWriteDeps,
  run: MergeRun,
  policy: MergePolicy,
): Promise<Browsed<{ commit: Oid; pack: Uint8Array }>> {
  const { git } = deps;
  const merged = await mergedTree(deps, run, policy);
  if (!merged.ok) return merged;
  const { tree, objects } = merged.value;
  const now = Math.floor((deps.now ?? Date.now)() / 1000);
  const unsigned: Commit = {
    tree,
    parents: run.method === "merge" ? [run.baseTip, run.head] : [run.baseTip],
    author: ident(run.author, now),
    committer: ident(run.committer, now),
    headers: [],
    message: new TextEncoder().encode(run.message),
  };
  const signed: Commit = deps.signer
    ? {
        ...unsigned,
        headers: [{ key: "gpgsig", value: await deps.signer.sign(encodeCommit(unsigned)) }],
      }
    : unsigned;
  const data = encodeCommit(signed);
  const commit = await hashObject(() => createSha1Hasher(), "commit", data);
  const pack = await packOf(git, [
    ...objects.map((o) => ({ type: o.type, oid: o.oid, data: o.bytes })),
    { type: "commit" as const, oid: commit, data },
  ]);
  return { ok: true, value: { commit, pack } };
}

/** The smallest tree entry: mode, space, a one-byte name, NUL, a 20-byte id. */
const MIN_TREE_ENTRY_BYTES = 28;

/** An object the merge needs cannot be read (gone, or not what it should be). */
class UnreadableObjectError extends Error {
  override name = "UnreadableObjectError";
}

/** The merge would read more, or larger objects, than its limits allow. */
class MergeTooLargeError extends Error {
  override name = "MergeTooLargeError";
}

const UNREADABLE = fail(422, "unreadable", "An object the merge needs cannot be read.");
const TOO_EXPENSIVE = fail(
  422,
  "too_expensive",
  "The pull request is too large to merge here; merge it locally and push.",
);

/**
 * The tree the merge commit has: the head's when it contains the base tip,
 * else the three-way merge of the base tip and the head.
 */
async function mergedTree(
  deps: FileWriteDeps,
  run: MergeRun,
  policy: MergePolicy,
): Promise<Browsed<{ tree: Oid; objects: readonly NewObject[] }>> {
  const graph: SqliteCommitGraph = deps.git.commitGraph;
  const treeOf = async (commit: Oid): Promise<Oid> => {
    const row = graph.readSync([commit], "verified")[0];
    if (!row) throw new UnreadableObjectError();
    return row.tree;
  };
  try {
    if (run.upToDate) return { ok: true, value: { tree: await treeOf(run.head), objects: [] } };
    const walk = { maxCommits: policy.maxCommits };
    const bases = await mergeBases(graph, "verified", run.baseTip, [run.head], walk);
    if (bases.length === 0)
      return fail(405, "not_mergeable", "The base branch and the head share no history.");
    return await withSource(deps, policy, async (source) => {
      const history: History = {
        mergeBases: (one, others) => mergeBases(graph, "verified", one, others, walk),
        treeOf,
      };
      const options = {
        maxFileBytes: policy.maxFileBytes,
        budget: new MergeBudget(policy.maxTrees, policy.maxFileMerges, policy.maxOutputBytes),
      };
      const under = await baseTreeOf(source, history, bases, options);
      if (under.kind === "manual")
        return fail(
          405,
          "merge_conflict",
          "The pull request's history needs a merge made by hand (its merge bases conflict); merge it locally and push.",
        );
      // What the virtual base was made of is read from here: it is in no store.
      const made = new Map(under.objects.map((o) => [oidToHex(o.oid), o]));
      const overlay: ObjectSource = {
        readTree: async (oid) => {
          const object = made.get(oidToHex(oid));
          return object ? parseTree(object.bytes).value : source.readTree(oid);
        },
        readBlob: async (oid, maxBytes) => {
          const object = made.get(oidToHex(oid));
          if (!object) return source.readBlob(oid, maxBytes);
          return object.bytes.length > maxBytes ? undefined : object.bytes;
        },
      };
      const result = await mergeTrees(
        overlay,
        under.tree,
        await treeOf(run.baseTip),
        await treeOf(run.head),
        options,
      );
      if (result.kind === "conflicts") return conflicted(result.conflicts, policy);
      return { ok: true, value: { tree: result.tree, objects: result.objects } };
    });
  } catch (error) {
    if (
      error instanceof WalkLimitError ||
      error instanceof MergeLimitError ||
      error instanceof MergeTooLargeError ||
      error instanceof ReadBudgetError
    )
      return TOO_EXPENSIVE;
    if (error instanceof UnreadableObjectError) return UNREADABLE;
    throw error;
  }
}

/**
 * Runs `use` with an object source over the live packs: each tree and file
 * read is bounded and its memory held until `use` is done, and trees read
 * once are kept for its other reads.
 */
async function withSource<T>(
  deps: FileWriteDeps,
  policy: MergePolicy,
  use: (source: ObjectSource) => Promise<T>,
): Promise<T> {
  const reader = await openLiveReader(deps, {
    deltaBaseCacheBytes: 4 * 1024 * 1024,
    maxCacheCalls: BROWSE_POLICY.cacheCalls,
    maxReads: policy.maxReads,
  });
  if (!reader) throw new UnreadableObjectError();
  const holds: { release(): void }[] = [];
  const trees = new Map<string, readonly TreeEntry[]>();
  let readBytes = 0;
  // Set once `use` is done: a read still under way then holds and parses nothing.
  let done = false;
  // Reads under way: cleanup waits for them before it lets their memory go.
  const pending = new Set<Promise<unknown>>();
  const tracked = <R>(read: () => Promise<R>): Promise<R> => {
    if (done) return Promise.reject(new UnreadableObjectError());
    const running = read();
    pending.add(running);
    void running.then(
      () => pending.delete(running),
      () => pending.delete(running),
    );
    return running;
  };
  const hold = (read: number, memory: number) => {
    readBytes += read;
    if (readBytes > policy.maxReadBytes) throw new MergeTooLargeError();
    let held: { release(): void } | undefined;
    try {
      held = deps.git.memory.tryReserve(Math.max(1, memory));
    } catch (error) {
      // More than the object's whole budget.
      if (!(error instanceof RangeError)) throw error;
    }
    if (!held) throw new MergeTooLargeError();
    if (done) {
      held.release();
      throw new UnreadableObjectError();
    }
    holds.push(held);
  };
  const source: ObjectSource = {
    readTree: (oid) =>
      tracked(async () => {
        const hex = oidToHex(oid);
        const known = trees.get(hex);
        if (known) return known;
        const header = await reader.readHeader(oid);
        if (header?.type !== "tree") throw new UnreadableObjectError();
        if (header.size > policy.maxTreeBytes) throw new MergeTooLargeError();
        const mostEntries = Math.ceil(header.size / MIN_TREE_ENTRY_BYTES);
        hold(header.size, 3 * header.size + mostEntries * policy.entryMemoryBytes);
        const object = await reader.readObject(oid);
        if (done || object?.type !== "tree") throw new UnreadableObjectError();
        const entries = parseTree(object.bytes).value;
        trees.set(hex, entries);
        return entries;
      }),
    readBlob: (oid, maxBytes) =>
      tracked(async () => {
        const header = await reader.readHeader(oid);
        if (header?.type !== "blob") throw new UnreadableObjectError();
        if (header.size > maxBytes) return undefined;
        // The bytes, and the lines a merge splits them into.
        hold(header.size, 3 * header.size);
        const object = await reader.readObject(oid);
        if (done || object?.type !== "blob") throw new UnreadableObjectError();
        return object.bytes;
      }),
  };
  try {
    return await use(source);
  } finally {
    done = true;
    // A sibling read (the merge reads three trees at once) may still be under way.
    while (pending.size > 0) await Promise.allSettled([...pending]);
    for (const held of holds.splice(0)) held.release();
    reader.release();
  }
}

/** A merge refused for its conflicts, naming the first few. */
function conflicted(conflicts: readonly MergeConflict[], policy: MergePolicy): Browsed<never> {
  const shown = conflicts
    .slice(0, policy.conflictsShown)
    .map((c) => `${c.path} (${c.kind.replaceAll("_", "/")})`);
  const more = conflicts.length - shown.length;
  return fail(
    405,
    "merge_conflict",
    `The pull request has conflicts with its base branch: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`,
  );
}

/** A merge's push refused at its commit point, as the API answers it. */
function mergeRefused(report: PushReportSummary): Browsed<never> {
  const reason = report.ok ? "" : report.error;
  if (
    reason.includes("incorrect old value provided") ||
    reason.includes("reference does not exist")
  )
    return fail(
      405,
      "base_moved",
      "The base branch was modified while the merge was being made; review it and try the merge again.",
    );
  if (reason.includes(PULL_CHANGED))
    return fail(
      409,
      "pull_changed",
      "The pull request changed while it was being merged; review it and try the merge again.",
    );
  const answered = refused(report);
  return !answered.ok && answered.code === "write_refused"
    ? fail(405, "merge_refused", reason || "The merge was refused.")
    : answered;
}
