import { CommitQueue, CommitWalk } from "../graph/commit-walk.js";
import { OidTable } from "../graph/oid-table.js";
import type { Oid } from "../object/oid.js";
import type { CommitGraph } from "../ports/commit-graph.js";

const UNINTERESTING = 1;
const SEEN = 2;
const SENT = 4;
const PARENT_OF_SENT = 8;

export interface CommitSelection {
  /** Commits to send, newest generation first. */
  readonly sent: OidTable;
  /**
   * Commits the client is proven to have whose trees bound the object
   * walk: uninteresting parents of sent commits, plus `edges` given in.
   */
  readonly edges: OidTable;
}

/**
 * The commits reachable from `include` and not from `exclude`, as
 * `rev-list include ^exclude` lists them with `boundary` commits grafted
 * to have no parents (git's registered shallow commits). Walks the
 * verified commit graph in generation order, so a commit's flags are final
 * when it is popped, and stops once only uninteresting commits are queued.
 * Throws `WalkLimitError` past `maxCommits` rows.
 */
export async function selectCommits(
  graph: CommitGraph,
  include: readonly Oid[],
  exclude: readonly Oid[],
  boundary: OidTable,
  extraEdges: readonly Oid[],
  maxCommits: number,
): Promise<CommitSelection> {
  const walk = new CommitWalk(graph, "verified", { maxCommits });
  const tips = include.map((oid) => walk.intern(oid));
  const stops = exclude.map((oid) => walk.intern(oid));
  await walk.load([...tips, ...stops]);
  for (const i of stops) walk.flags[i] = (walk.flags[i] as number) | UNINTERESTING;

  const queue = new CommitQueue(walk);
  let interesting = 0;
  const enqueue = (i: number) => {
    walk.flags[i] = (walk.flags[i] as number) | SEEN;
    queue.push(i);
    if (((walk.flags[i] as number) & UNINTERESTING) === 0) interesting++;
  };
  for (const i of [...tips, ...stops]) if (((walk.flags[i] as number) & SEEN) === 0) enqueue(i);

  const sent = new OidTable();
  const parentsOfSent: number[] = [];
  while (interesting > 0) {
    const commit = queue.pop();
    const flags = walk.flags[commit] as number;
    const uninteresting = (flags & UNINTERESTING) !== 0;
    if (!uninteresting) {
      interesting--;
      walk.flags[commit] = flags | SENT;
      sent.add(walk.oids.oidAt(commit));
    }
    if (boundary.has(walk.oids.oidAt(commit))) continue;
    await walk.loadParents(commit);
    for (const parent of walk.parentsOf(commit)) {
      const before = walk.flags[parent] as number;
      if (!uninteresting && (before & PARENT_OF_SENT) === 0) {
        walk.flags[parent] = before | PARENT_OF_SENT;
        parentsOfSent.push(parent);
      }
      if (uninteresting && (before & UNINTERESTING) === 0) {
        walk.flags[parent] = (walk.flags[parent] as number) | UNINTERESTING;
        if ((before & SEEN) !== 0) interesting--;
      }
      if ((before & SEEN) === 0) enqueue(parent);
    }
  }
  const edges = new OidTable();
  for (const i of parentsOfSent) {
    const flags = walk.flags[i] as number;
    if ((flags & UNINTERESTING) !== 0 && (flags & SENT) === 0) edges.add(walk.oids.oidAt(i));
  }
  for (const oid of extraEdges) edges.add(oid);
  return { sent, edges };
}
