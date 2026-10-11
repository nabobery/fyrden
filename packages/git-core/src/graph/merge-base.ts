import type { Oid } from "../object/oid.js";
import type { CommitGraph, CommitGraphView } from "../ports/commit-graph.js";
import { CommitQueue, CommitWalk, type WalkOptions } from "./commit-walk.js";

/*
 * Merge bases as git's paint_down_to_common computes them (commit-reach.c,
 * git v2.53.0, verified against the source), walking in generation order.
 *
 * git follows the walk with remove_redundant, because without generation
 * numbers it walks by commit date and can meet a common commit before a
 * descendant that makes it redundant. Here every parent has a strictly lower
 * generation than its child (CommitWalk checks this), so commits are popped
 * in decreasing generation and a commit's flags are final when it is popped:
 * if a common commit D descends from C, D and every commit between them are
 * popped before C and mark it STALE. The commits popped as common and not
 * STALE are therefore exactly the best common ancestors, and the extra pass
 * would remove nothing.
 */

const PARENT1 = 1;
const PARENT2 = 2;
const STALE = 4;
const QUEUED = 8;

/**
 * All best common ancestors of `one` and the hypothetical merge of `twos`,
 * as `git merge-base --all one twos...`: every commit reachable from `one`
 * and from some `two`, minus those that are ancestors of another such
 * commit. A criss-cross history has several; the order is git's (newest
 * commit date first). Throws `MissingCommitError` when a commit is not
 * visible in `view`.
 */
export async function mergeBases(
  graph: CommitGraph,
  view: CommitGraphView,
  one: Oid,
  twos: readonly Oid[],
  options?: WalkOptions,
): Promise<Oid[]> {
  const walk = new CommitWalk(graph, view, options);
  const first = walk.intern(one);
  const others = twos.map((two) => walk.intern(two));
  // Every tip must be visible in the view, also for the shortcuts below.
  await walk.load([first, ...others]);
  if (others.length === 0 || others.includes(first)) return [walk.oids.oidAt(first)];

  const queue = new CommitQueue(walk);
  // Queued commits without STALE: the walk ends when none are left.
  let live = 0;
  const enqueue = (i: number) => {
    walk.flags[i] = (walk.flags[i] as number) | QUEUED;
    queue.push(i);
    if (((walk.flags[i] as number) & STALE) === 0) live++;
  };
  walk.flags[first] = PARENT1;
  enqueue(first);
  for (const two of others) {
    walk.flags[two] = (walk.flags[two] as number) | PARENT2;
    if (((walk.flags[two] as number) & QUEUED) === 0) enqueue(two);
  }

  const bases: number[] = [];
  while (live > 0) {
    const commit = queue.pop();
    let flags = (walk.flags[commit] as number) & ~QUEUED;
    walk.flags[commit] = flags;
    if ((flags & STALE) === 0) live--;
    if (flags === (PARENT1 | PARENT2)) {
      bases.push(commit);
      // Ancestors of a common commit cannot be best common ancestors.
      flags |= STALE;
    }
    await walk.loadParents(commit);
    for (const parent of walk.parentsOf(commit)) {
      const before = walk.flags[parent] as number;
      if ((before & flags) === flags) continue;
      walk.flags[parent] = before | flags;
      if ((before & QUEUED) === 0) enqueue(parent);
      else if ((before & STALE) === 0 && (flags & STALE) !== 0) live--;
    }
  }
  // git's commit_list_sort_by_date: newest first, stable.
  bases.sort((a, b) => (walk.date[b] as number) - (walk.date[a] as number));
  return bases.map((i) => walk.oids.oidAt(i));
}
