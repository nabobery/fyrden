import {
  createSha1Hasher,
  hashObject,
  MergeBudget,
  type MergeConflict,
  MergeLimitError,
  mergeTrees,
  type NewObject,
  type ObjectSource,
  type Oid,
  oidFromBytes,
  oidToHex,
  parseTree,
  reachableCommits,
  replayCommit,
  type TreeEntry,
  WalkLimitError,
} from "@fyrden/git-core";
import { ReadBudgetError } from "../../git/live-reader.js";
import { type Browsed, type BrowseFailure, fail } from "./browse.js";
import { type FileWriteDeps, ident } from "./file-writes.js";
import { ReadsTooLargeError, treeMemoryBytes, UnreadableObjectError } from "./held-reads.js";
import { MERGE_POLICY, TOO_EXPENSIVE, UNREADABLE, withSource } from "./merge.js";

/*
 * The replay a rebase merge makes (see `RebaseSagas`, which owns the saga,
 * its job and its publication): the pull request's commits it replays,
 * each one replayed onto the tip so far, its tree merged from the saga's
 * kept objects and the live packs. A slice replays within its bounds
 * (commits, reads, the invocation's calls) and hands each commit to
 * `stage`, the saga's own transaction under the job's claim, which keeps
 * its new objects with `keepObjects`; what stopped the slice comes back as
 * a bounded result (`ReplayEnd`).
 */

/** Limits of a rebase merge. Proposed (Workers Free: 1,000 subrequests, 128 MB). */
export const REBASE_POLICY = {
  /** Commits a rebase replays (else `too_expensive`). */
  maxCommits: 250,
  /** Bytes of new objects a saga keeps, its signed commits included (as a merge makes). */
  maxStagedBytes: MERGE_POLICY.maxOutputBytes,
  /** New objects a saga keeps: each is a row written, and deleted at the end. */
  maxStagedObjects: 2_000,
  /** The largest object kept (SQLite rows hold at most 2 MB). */
  maxObjectBytes: 1024 * 1024,
  /** Commits one slice replays. */
  commitsPerSlice: 25,
  /**
   * R2 reads one slice makes; a commit that needs more alone is
   * `too_expensive`. Under the 200 calls the job queue leaves a slice
   * (it starts one with up to 800 made).
   */
  sliceReads: 120,
  /** Internal calls past which a request stops replaying and leaves the rest to the alarm. */
  requestCalls: 400,
  /**
   * Internal calls past which finishing (storing the pack, indexing it,
   * committing) waits for a fresh invocation: indexing's first
   * connectivity batch checks up to 512 objects within the 1,000 calls.
   */
  finishCalls: 200,
  /** Internal calls past which, its push indexed, the commit waits for a fresh invocation. */
  commitCalls: 600,
  /** How long a request drives its saga before it answers. */
  requestMs: 15_000,
  /** Sagas running at once in one repository (their objects are kept here). */
  maxRunning: 3,
  /** A saga still running after this is given up. */
  maxAgeMs: 60 * 60_000,
  /** Unexpected errors in a row after which a saga is given up. */
  maxFailures: 3,
  /** Delay before a slice after an unexpected error. */
  retryMs: 5_000,
  /** Delay before looking at the final push's indexing again, or waiting for a fresh invocation. */
  waitMs: 1_000,
} as const;
export type RebasePolicy = { readonly [K in keyof typeof REBASE_POLICY]: number };

/** A rebase refused for keeping more new objects than a saga may. */
const TOO_MANY_OBJECTS = fail(
  422,
  "too_expensive",
  "The rebase makes more new objects than one may make here; rebase locally and push.",
);

/** A new object a step keeps. */
export type Kept =
  | NewObject
  | { readonly type: "commit"; readonly oid: Oid; readonly bytes: Uint8Array };

/** One commit replayed: its new tip and tree and the objects it made, or dropped as empty. */
export type Replayed = { tip: Oid; tree: Oid; objects: readonly Kept[] } | "dropped";

/** Where a saga's replay stands: the next commit, the tip and its tree, and what it keeps. */
export interface ReplayCursor {
  next: number;
  tip: Oid;
  tipTree: Oid;
  bytes: number;
  objects: number;
}

/** How a slice's replay ended: go on later (after `runAfterMs`), or the saga is refused. */
type ReplayEnd =
  | { readonly kind: "later"; readonly runAfterMs: number }
  | { readonly kind: "refused"; readonly failure: BrowseFailure };

/** A commit that stops the rebase (it conflicts, or is too large): the saga fails with it. */
class ReplayRefusal extends Error {
  override name = "ReplayRefusal";
  constructor(readonly failure: BrowseFailure) {
    super(failure.error);
  }
}

/**
 * Replays the saga's commits from `at.next` within the slice's bounds,
 * each staged (`stage`, in its own transaction) before the next; `stage`
 * answers false when the saga is no longer the runner's, which ends the
 * slice. `at` moves with each commit staged.
 */
export async function replayCommits(
  git: FileWriteDeps["git"],
  input: {
    readonly sagaId: string;
    readonly commits: Uint8Array;
    readonly at: ReplayCursor;
    readonly committer: { readonly name: string; readonly email: string };
    readonly committedAt: number;
    readonly writeDeps: FileWriteDeps;
    readonly mode: "request" | "alarm";
    /** The saga's limits now (see `REBASE_POLICY`). */
    readonly policy: () => {
      readonly sliceReads: number;
      readonly commitsPerSlice: number;
      readonly requestCalls: number;
    };
    /** Internal-service calls the invocation has made so far. */
    readonly internalCalls: () => number;
    readonly stage: (made: Replayed) => boolean;
  },
): Promise<ReplayEnd> {
  const { commits, at, writeDeps } = input;
  let replayed = 0;
  let budgetLeft = false;
  const holds: { release(): void }[] = [];
  try {
    await withSource(
      writeDeps,
      { ...MERGE_POLICY, maxReads: input.policy().sliceReads },
      async (live, readCommit) => {
        const source = overlay(git, input.sagaId, live, holds);
        while (at.next * 20 < commits.length && replayed < input.policy().commitsPerSlice) {
          if (input.mode === "request" && input.internalCalls() >= input.policy().requestCalls) {
            budgetLeft = true;
            return;
          }
          const commit = oidFromBytes(commits, at.next * 20);
          const made = await replayOne(git, source, readCommit, commit, at, {
            committer: ident(input.committer, input.committedAt),
            signer: writeDeps.signer,
          });
          if (!input.stage(made)) return;
          replayed++;
        }
      },
    );
  } catch (error) {
    if (error instanceof ReplayRefusal) return { kind: "refused", failure: error.failure };
    // Out of this slice's reads: the next slice goes on, unless one commit alone needs more.
    if (error instanceof ReadBudgetError && replayed > 0) return { kind: "later", runAfterMs: 0 };
    if (
      error instanceof ReadBudgetError ||
      error instanceof MergeLimitError ||
      error instanceof ReadsTooLargeError ||
      error instanceof WalkLimitError
    )
      return { kind: "refused", failure: TOO_EXPENSIVE };
    if (error instanceof UnreadableObjectError) return { kind: "refused", failure: UNREADABLE };
    throw error;
  } finally {
    for (const held of holds.splice(0)) held.release();
  }
  // A request out of calls stops here; the alarm goes on (a delay ends the request's run).
  return { kind: "later", runAfterMs: budgetLeft ? 1 : 0 };
}

/** One commit replayed onto `at.tip`: its new objects, or nothing when it comes out empty. */
async function replayOne(
  git: FileWriteDeps["git"],
  source: ObjectSource,
  readCommit: (oid: Oid) => Promise<Uint8Array>,
  commit: Oid,
  at: { tip: Oid; tipTree: Oid },
  made: { committer: ReturnType<typeof ident>; signer: FileWriteDeps["signer"] },
): Promise<Replayed> {
  const graph = git.commitGraph;
  const [row] = graph.readSync([commit], "verified");
  const parentOid = row?.parents.length === 1 ? row.parents[0] : undefined;
  const [parent] = parentOid ? graph.readSync([parentOid], "verified") : [];
  if (!row || !parent) throw new UnreadableObjectError();
  const same = (a: Oid, b: Oid) => oidToHex(a) === oidToHex(b);
  let tree: Oid;
  let objects: readonly Kept[] = [];
  if (same(row.tree, parent.tree)) {
    // Empty from the start: kept, as git rebase keeps it.
    tree = at.tipTree;
  } else if (same(parent.tree, at.tipTree)) {
    tree = row.tree;
  } else {
    const merged = await mergeTrees(source, parent.tree, at.tipTree, row.tree, {
      maxFileBytes: MERGE_POLICY.maxFileBytes,
      budget: new MergeBudget(
        MERGE_POLICY.maxTrees,
        MERGE_POLICY.maxFileMerges,
        MERGE_POLICY.maxOutputBytes,
      ),
    });
    if (merged.kind === "conflicts")
      throw new ReplayRefusal(conflictsIn(oidToHex(commit), merged.conflicts));
    // Its changes are in the base already: dropped, as git rebase drops it.
    if (same(merged.tree, at.tipTree)) return "dropped";
    tree = merged.tree;
    objects = merged.objects;
  }
  const bytes = await replayCommit(await readCommit(commit), {
    tree,
    parent: at.tip,
    committer: made.committer,
    ...(made.signer && { signer: made.signer }),
  });
  const tip = await hashObject(() => createSha1Hasher(), "commit", bytes);
  return { tip, tree, objects: [...objects, { type: "commit", oid: tip, bytes }] };
}

/**
 * Reads the saga's kept objects first, then the live packs. A kept
 * object's memory is held as a live read's is (`holds`, released when
 * the slice ends), and a kept tree is parsed once.
 */
function overlay(
  git: FileWriteDeps["git"],
  sagaId: string,
  live: ObjectSource,
  holds: { release(): void }[],
): ObjectSource {
  const trees = new Map<string, readonly TreeEntry[]>();
  const hold = (bytes: number) => {
    let held: { release(): void } | undefined;
    try {
      held = git.memory.tryReserve(Math.max(1, bytes));
    } catch (error) {
      // More than the object's whole budget.
      if (!(error instanceof RangeError)) throw error;
    }
    if (!held) throw new ReadsTooLargeError();
    holds.push(held);
  };
  const kept = (oid: Oid) =>
    git.context.storage.sql
      .exec<{ data: ArrayBuffer }>(
        "SELECT data FROM merge_saga_objects WHERE saga_id = ? AND oid = ?",
        sagaId,
        oid,
      )
      .toArray()[0]?.data;
  return {
    readTree: async (oid) => {
      const hex = oidToHex(oid);
      const known = trees.get(hex);
      if (known) return known;
      const data = kept(oid);
      if (!data) return live.readTree(oid);
      // As a live tree read holds it.
      hold(treeMemoryBytes(data.byteLength));
      const entries = parseTree(new Uint8Array(data)).value;
      trees.set(hex, entries);
      return entries;
    },
    readBlob: async (oid, maxBytes) => {
      const data = kept(oid);
      if (!data) return live.readBlob(oid, maxBytes);
      if (data.byteLength > maxBytes) return undefined;
      hold(3 * data.byteLength);
      return new Uint8Array(data);
    },
  };
}

/**
 * The commits a rebase of `head` onto `baseTip` replays, oldest first: the
 * head's commits the base tip does not reach, one chain of single-parent
 * commits.
 */
export async function rebaseCommits(
  graph: FileWriteDeps["git"]["commitGraph"],
  baseTip: Oid,
  head: Oid,
  policy: { readonly maxCommits: number; readonly maxWalk: number },
): Promise<Browsed<Oid[]>> {
  let ahead: Set<string>;
  try {
    const found = await reachableCommits(graph, "verified", [head], [baseTip], {
      maxCommits: policy.maxWalk,
    });
    ahead = new Set([...found].map(oidToHex));
  } catch (error) {
    if (!(error instanceof WalkLimitError)) throw error;
    return TOO_EXPENSIVE;
  }
  if (ahead.size > policy.maxCommits)
    return fail(
      422,
      "too_expensive",
      `The pull request has more than ${policy.maxCommits} commits to rebase; rebase locally and push.`,
    );
  const chain: Oid[] = [];
  for (let at: Oid | undefined = head; at && ahead.has(oidToHex(at)); ) {
    const [row] = graph.readSync([at], "verified");
    if (!row) return UNREADABLE;
    if (row.parents.length > 1)
      return fail(
        405,
        "not_mergeable",
        "The pull request contains merge commits, which a rebase merge does not replay; merge it another way.",
      );
    if (row.parents.length === 0)
      return fail(405, "not_mergeable", "The base branch and the head share no history.");
    chain.push(at);
    at = row.parents[0];
  }
  // Single parents all the way: the chain is every commit found (else the graph is inconsistent).
  if (chain.length !== ahead.size) return UNREADABLE;
  return { ok: true, value: chain.reverse() };
}

/** A rebase refused for a commit's conflicts, naming the first few. */
function conflictsIn(commit: string, conflicts: readonly MergeConflict[]): BrowseFailure {
  const shown = conflicts
    .slice(0, MERGE_POLICY.conflictsShown)
    .map((c) => `${c.path} (${c.kind.replaceAll("_", "/")})`);
  const more = conflicts.length - shown.length;
  return fail(
    405,
    "merge_conflict",
    `Commit ${commit} does not apply cleanly to the base branch: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`,
  );
}

/** `made`'s new objects, refused when one is larger than a row may hold. */
export function keptObjects(
  made: Replayed,
  policy: { readonly maxObjectBytes: number },
): readonly Kept[] {
  const objects = made === "dropped" ? [] : made.objects;
  if (objects.some((o) => o.bytes.length > policy.maxObjectBytes))
    throw new ReplayRefusal(TOO_EXPENSIVE);
  return objects;
}

/**
 * In the caller's transaction: keeps a replayed commit's new `objects`
 * with the saga's (one kept already counts once), refused past the
 * saga's limits. Answers what it added, and the tip and tree the replay
 * moves to.
 */
export function keepObjects(
  git: FileWriteDeps["git"],
  input: {
    readonly sagaId: string;
    readonly at: ReplayCursor;
    readonly made: Replayed;
    readonly objects: readonly Kept[];
  },
  policy: { readonly maxStagedBytes: number; readonly maxStagedObjects: number },
): { bytes: number; count: number; tip: Oid; tree: Oid } {
  const { at, made } = input;
  let bytes = 0;
  let count = 0;
  for (const object of input.objects) {
    const written = git.context.storage.sql.exec(
      `INSERT OR IGNORE INTO merge_saga_objects (saga_id, oid, type, data)
       VALUES (?, ?, ?, ?)`,
      input.sagaId,
      object.oid,
      object.type,
      object.bytes,
    ).rowsWritten;
    if (written > 0) {
      bytes += object.bytes.length;
      count++;
    }
  }
  if (at.bytes + bytes > policy.maxStagedBytes) throw new ReplayRefusal(TOO_EXPENSIVE);
  if (at.objects + count > policy.maxStagedObjects) throw new ReplayRefusal(TOO_MANY_OBJECTS);
  const tip = made === "dropped" ? at.tip : made.tip;
  const tree = made === "dropped" ? at.tipTree : made.tree;
  return { bytes, count, tip, tree };
}
