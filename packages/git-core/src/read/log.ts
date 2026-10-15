import { CommitQueue, CommitWalk, type WalkOptions } from "../graph/commit-walk.js";
import { WalkLimitError } from "../graph/errors.js";
import type { Oid } from "../object/oid.js";
import type { CommitGraph, CommitGraphView } from "../ports/commit-graph.js";

/*
 * Commit history as `git log [-- <path>]` lists it, one page at a time.
 *
 * The walk pops commits in generation order (corrected commit date, then
 * commit date, then id: git's order when commit dates do not go backwards
 * and no two are equal; git keeps equal ones in the order it met them,
 * which a resumed walk could not reproduce), so a
 * page can end anywhere and the next one resumes from the commits still
 * queued, the frontier, with no record of what was shown: every parent has
 * a strictly lower generation than its child, so nothing already popped is
 * an ancestor of a frontier commit, and no commit is shown twice.
 *
 * With a path, history is simplified as git does by default: a commit
 * whose entry at the path equals one parent's ("TREESAME") is not shown,
 * and only the first such parent is followed; a commit that differs from
 * every parent is shown and all its parents are followed. A root commit is
 * shown when the path exists in it.
 */

/** The entry at the log's path in `tree` (any value that compares equal for equal entries), or null. */
export type PathEntryLookup = (tree: Oid) => Promise<string | null>;

export interface LogPageOptions extends WalkOptions {
  /** Commits to start from: the tips, or a previous page's frontier. */
  readonly from: readonly Oid[];
  /** Most commits the page lists. */
  readonly limit: number;
  /**
   * Most commits the page examines before it ends, shown or not (a path
   * that rarely changes); the next page continues. Defaults to no limit.
   */
  readonly maxExamined?: number;
  /** Restricts the log to commits that change this path. */
  readonly path?: PathEntryLookup;
  /**
   * Most commits a frontier may hold; a wider history fails with
   * `WalkLimitError`. A page also ends before its commits and its queue
   * together reach it, so a caller that shows only some of the page's
   * commits can hand the rest back with the frontier and stay within it
   * (an octopus merge popped last can still pass it).
   */
  readonly maxFrontier?: number;
  /**
   * Asked before each commit after the first: true ends the page there
   * (the caller's own budget, such as storage reads, ran out).
   */
  readonly stop?: () => boolean;
}

export interface LogPage {
  readonly commits: Oid[];
  /** Where the next page starts; empty when the history is exhausted. */
  readonly frontier: Oid[];
}

const QUEUED = 1;

/** One page of history from `from`. Throws `MissingCommitError` for a commit not visible in `view`. */
export async function logPage(
  graph: CommitGraph,
  view: CommitGraphView,
  options: LogPageOptions,
): Promise<LogPage> {
  const maxFrontier = options.maxFrontier ?? Number.POSITIVE_INFINITY;
  if (options.from.length > maxFrontier) throw new WalkLimitError(maxFrontier);
  const walk = new CommitWalk(graph, view, { ...options, keepTrees: options.path !== undefined });
  const queue = new CommitQueue(walk, { byOidOnTies: true });
  const enqueue = (i: number) => {
    if (((walk.flags[i] as number) & QUEUED) !== 0) return;
    walk.flags[i] = (walk.flags[i] as number) | QUEUED;
    queue.push(i);
  };
  const tips = options.from.map((oid) => walk.intern(oid));
  await walk.load(tips);
  for (const i of tips) enqueue(i);

  const commits: Oid[] = [];
  const maxExamined = options.maxExamined ?? Number.POSITIVE_INFINITY;
  let examined = 0;
  while (
    queue.size > 0 &&
    commits.length < options.limit &&
    examined < maxExamined &&
    !(examined > 0 && (commits.length + queue.size >= maxFrontier || options.stop?.()))
  ) {
    const commit = queue.pop();
    examined++;
    await walk.loadParents(commit);
    const parents = Array.from(walk.parentsOf(commit));
    const follow = options.path ? await simplify(walk, options.path, commit, parents) : null;
    if (follow === null) commits.push(walk.oids.oidAt(commit));
    for (const parent of follow ?? parents) enqueue(parent);
  }

  const frontier: Oid[] = [];
  while (queue.size > 0) frontier.push(walk.oids.oidAt(queue.pop()));
  if (frontier.length > maxFrontier) throw new WalkLimitError(maxFrontier);
  return { commits, frontier };
}

/**
 * For a path-limited log: null when the commit is shown (follow every
 * parent), or the one parent to follow when it is TREESAME to it.
 */
async function simplify(
  walk: CommitWalk,
  path: PathEntryLookup,
  commit: number,
  parents: readonly number[],
): Promise<number[] | null> {
  const mine = await path(walk.treeOf(commit));
  if (parents.length === 0) return mine === null ? [] : null;
  for (const parent of parents) {
    if ((await path(walk.treeOf(parent))) === mine) return [parent];
  }
  return null;
}
