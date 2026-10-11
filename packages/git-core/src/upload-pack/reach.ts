import { CommitQueue, CommitWalk } from "../graph/commit-walk.js";
import { WalkLimitError } from "../graph/errors.js";
import type { Oid } from "../object/oid.js";
import type { CommitGraph } from "../ports/commit-graph.js";

const TARGET = 1;
const FOUND = 2;
const SEEN = 4;

/**
 * Which of `targets` are reachable from `starts` (a commit reaches
 * itself), over verified commit rows. The walk goes from the starts in
 * generation order and never descends below the lowest generation among
 * the targets, which no ancestor of theirs can hold. It loads at most
 * `maxCommits` rows; when that runs out, every target not found yet counts
 * as unreachable (fail closed). Every start and target must have a row.
 */
export async function reachedFrom(
  graph: CommitGraph,
  starts: readonly Oid[],
  targets: readonly Oid[],
  maxCommits: number,
): Promise<boolean[]> {
  if (targets.length === 0) return [];
  const walk = new CommitWalk(graph, "verified", { maxCommits });
  const targetIndex = targets.map((oid) => walk.intern(oid));
  const startIndex = starts.map((oid) => walk.intern(oid));
  const found = () => targetIndex.map((i) => ((walk.flags[i] as number) & FOUND) !== 0);
  try {
    await walk.load([...targetIndex, ...startIndex]);
  } catch (error) {
    if (error instanceof WalkLimitError) return found();
    throw error;
  }
  let floor = Number.POSITIVE_INFINITY;
  let remaining = 0;
  for (const i of targetIndex) {
    floor = Math.min(floor, walk.generation[i] as number);
    if (((walk.flags[i] as number) & TARGET) === 0) remaining++;
    walk.flags[i] = (walk.flags[i] as number) | TARGET;
  }
  const queue = new CommitQueue(walk);
  for (const i of startIndex) {
    if (((walk.flags[i] as number) & SEEN) !== 0) continue;
    walk.flags[i] = (walk.flags[i] as number) | SEEN;
    queue.push(i);
  }
  try {
    while (queue.size > 0 && remaining > 0) {
      const commit = queue.pop();
      const flags = walk.flags[commit] as number;
      if ((flags & TARGET) !== 0 && (flags & FOUND) === 0) {
        walk.flags[commit] = flags | FOUND;
        remaining--;
      }
      if ((walk.generation[commit] as number) <= floor) continue;
      await walk.loadParents(commit);
      for (const parent of walk.parentsOf(commit)) {
        const before = walk.flags[parent] as number;
        if ((before & SEEN) !== 0 || (walk.generation[parent] as number) < floor) continue;
        walk.flags[parent] = before | SEEN;
        queue.push(parent);
      }
    }
  } catch (error) {
    if (!(error instanceof WalkLimitError)) throw error;
  }
  return found();
}
