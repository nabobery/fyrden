import { OID_BYTES, type Oid } from "../object/oid.js";
import type { CommitGraph, CommitGraphView } from "../ports/commit-graph.js";
import type { BitSet } from "./bitset.js";
import { CommitQueue, CommitWalk, type WalkOptions } from "./commit-walk.js";
import { OidTable } from "./oid-table.js";

const TARGET = 1;
const ASSIGNED = 2;
const RESULT = 4;
const SEEN = 8;
const UNINTERESTING = 16;
const QUEUED = 32;

/**
 * Whether `ancestor` is reachable from `descendant` (a commit is its own
 * ancestor), as `git merge-base --is-ancestor`. Throws `MissingCommitError`
 * when a commit is not visible in `view`.
 */
export function isAncestor(
  graph: CommitGraph,
  view: CommitGraphView,
  ancestor: Oid,
  descendant: Oid,
  options?: WalkOptions,
): Promise<boolean> {
  return canAllFromReach(graph, view, [descendant], [ancestor], options);
}

/**
 * Whether every commit in `from` reaches at least one commit in `to`: git's
 * can_all_from_reach (commit-reach.c, git v2.53.0). A depth-first walk from
 * each `from`, lowest generation first, that never descends below the lowest
 * generation among `from` and `to`, and remembers commits already proven to
 * reach a target.
 */
export async function canAllFromReach(
  graph: CommitGraph,
  view: CommitGraphView,
  from: readonly Oid[],
  to: readonly Oid[],
  options?: WalkOptions,
): Promise<boolean> {
  const walk = new CommitWalk(graph, view, options);
  const starts = from.map((oid) => walk.intern(oid));
  const targets = to.map((oid) => walk.intern(oid));
  await walk.load([...starts, ...targets]);
  let minGeneration = Number.POSITIVE_INFINITY;
  for (const i of [...starts, ...targets]) {
    minGeneration = Math.min(minGeneration, walk.generation[i] as number);
  }
  for (const i of targets) walk.flags[i] = (walk.flags[i] as number) | TARGET;
  const reaches = (i: number) => ((walk.flags[i] as number) & (TARGET | RESULT)) !== 0;

  const ordered = [...new Set(starts)].sort(
    (a, b) => (walk.generation[a] as number) - (walk.generation[b] as number),
  );
  for (const start of ordered) {
    walk.flags[start] = (walk.flags[start] as number) | ASSIGNED;
    const stack = [start];
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as number;
      if (reaches(top)) {
        stack.pop();
        const below = stack[stack.length - 1];
        if (below !== undefined) walk.flags[below] = (walk.flags[below] as number) | RESULT;
        continue;
      }
      await walk.loadParents(top);
      let descended = false;
      for (const parent of walk.parentsOf(top)) {
        if (reaches(parent)) walk.flags[top] = (walk.flags[top] as number) | RESULT;
        if (((walk.flags[parent] as number) & ASSIGNED) !== 0) continue;
        walk.flags[parent] = (walk.flags[parent] as number) | ASSIGNED;
        if ((walk.generation[parent] as number) < minGeneration) continue;
        stack.push(parent);
        descended = true;
        break;
      }
      if (!descended) stack.pop();
    }
    if (!reaches(start)) return false;
  }
  return true;
}

/**
 * The commits reachable from `include` and not from `exclude`, as
 * `git rev-list include... ^exclude...` lists them (as a set). The walk pops
 * commits in generation order, so a commit's flags are final when it is
 * popped, and it stops as soon as only uninteresting commits are queued.
 */
export async function reachableCommits(
  graph: CommitGraph,
  view: CommitGraphView,
  include: readonly Oid[],
  exclude: readonly Oid[] = [],
  options?: WalkOptions,
): Promise<OidTable> {
  const walk = new CommitWalk(graph, view, options);
  const tips = include.map((oid) => walk.intern(oid));
  const stops = exclude.map((oid) => walk.intern(oid));
  await walk.load([...tips, ...stops]);
  for (const i of stops) walk.flags[i] = (walk.flags[i] as number) | UNINTERESTING;

  const queue = new CommitQueue(walk);
  let interesting = 0;
  const enqueue = (i: number) => {
    walk.flags[i] = (walk.flags[i] as number) | SEEN | QUEUED;
    queue.push(i);
    if (((walk.flags[i] as number) & UNINTERESTING) === 0) interesting++;
  };
  for (const i of [...tips, ...stops]) if (((walk.flags[i] as number) & SEEN) === 0) enqueue(i);

  const result = new OidTable();
  while (interesting > 0) {
    const commit = queue.pop();
    const flags = walk.flags[commit] as number;
    walk.flags[commit] = flags & ~QUEUED;
    const uninteresting = (flags & UNINTERESTING) !== 0;
    if (!uninteresting) {
      interesting--;
      result.add(walk.oids.oidAt(commit));
    }
    await walk.loadParents(commit);
    for (const parent of walk.parentsOf(commit)) {
      const before = walk.flags[parent] as number;
      if (uninteresting && (before & UNINTERESTING) === 0) {
        walk.flags[parent] = before | UNINTERESTING;
        if ((before & QUEUED) !== 0) interesting--;
      }
      if ((before & SEEN) === 0) enqueue(parent);
    }
  }
  return result;
}

/**
 * Sets, in `bits`, the position of each of `commits` that `positionOf` finds
 * (for example, a binary search of a pack's `.idx`). `positionOf` receives
 * the table's packed oid bytes and an offset, so no oid is copied; it returns
 * -1 when the object is not in the pack. Returns how many bits were newly set.
 */
export function markPositions(
  commits: OidTable,
  positionOf: (oids: Uint8Array, offset: number) => number,
  bits: BitSet,
): number {
  const packed = commits.packedOids();
  let marked = 0;
  for (let i = 0; i < commits.size; i++) {
    const position = positionOf(packed, i * OID_BYTES);
    if (position >= 0 && bits.set(position)) marked++;
  }
  return marked;
}
