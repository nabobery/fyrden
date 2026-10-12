import { CommitQueue, CommitWalk } from "../graph/commit-walk.js";
import { WalkLimitError } from "../graph/errors.js";
import { OidTable } from "../graph/oid-table.js";
import { type Oid, oidToHex } from "../object/oid.js";
import type { CommitGraph } from "../ports/commit-graph.js";
import { UploadPackError } from "./errors.js";
import type { PeelReader } from "./peel.js";
import { type RefTips, reachableFromRefs } from "./wants.js";

/*
 * Shallow boundaries as git v2.53.0 upload-pack.c computes them
 * (`send_shallow_info`, `deepen`, `deepen_by_rev_list`, `send_unshallow`;
 * shallow.c `get_shallow_commits`, `get_shallow_commits_by_rev_list`,
 * verified against the source):
 *
 * - `deepen N`: commits at depth N from the wants (a want is depth 1)
 *   become the new boundary; with `deepen-relative`, depth is counted from
 *   the client's current boundary commits that the refs reach (N + 1 from
 *   them). `deepen 2147483647` (`--unshallow`) removes every boundary.
 * - `deepen-since` and `deepen-not`: the commits `rev-list --max-age=T
 *   wants --not <deepen-not>` lists; those with a parent outside the list
 *   are the boundary.
 * - A client boundary commit the new depth passes through is
 *   "unshallowed": its parents are wanted, and the commit itself is an
 *   edge the client has. Unlike git, a client boundary commit is lifted
 *   only when the current refs reach it.
 * - Every boundary commit, the client's and the new ones, is treated as
 *   having no parents when the pack's commits are chosen.
 */

/** git's INFINITE_DEPTH: what `fetch --unshallow` sends. */
export const INFINITE_DEPTH = 0x7fffffff;

export interface ShallowRequest {
  /** Wanted commits (tags already peeled). */
  readonly wants: readonly Oid[];
  /** The client's `shallow` lines. */
  readonly clientShallow: readonly Oid[];
  readonly deepen: number | undefined;
  readonly deepenRelative: boolean;
  /** Seconds since the epoch. */
  readonly deepenSince: number | undefined;
  /** Commits the `deepen-not` refs name (tags already peeled). */
  readonly deepenNot: readonly Oid[];
}

export interface ShallowPlan {
  /** Whether the response carries a shallow-info section. */
  readonly active: boolean;
  /** New boundary commits to announce with `shallow` lines. */
  readonly shallow: readonly Oid[];
  /** Client boundary commits to announce with `unshallow` lines. */
  readonly unshallow: readonly Oid[];
  /** Commits whose parents the commit walk must not follow. */
  readonly boundary: OidTable;
  /** Parents of unshallowed commits: wanted as well. */
  readonly extraWants: readonly Oid[];
  /** Unshallowed commits: the client has them, and their trees. */
  readonly extraEdges: readonly Oid[];
}

export const NO_SHALLOW: ShallowPlan = Object.freeze({
  active: false,
  shallow: [],
  unshallow: [],
  boundary: new OidTable(1),
  extraWants: [],
  extraEdges: [],
});

/** The client's boundary commits this repository knows; a known object that is not a commit is refused, as in git. */
async function knownClientShallow(
  graph: CommitGraph,
  reader: Pick<PeelReader, "readHeader">,
  shallow: readonly Oid[],
): Promise<Oid[]> {
  const rows = await graph.read(shallow, "verified");
  const known: Oid[] = [];
  for (const [i, oid] of shallow.entries()) {
    if (rows[i]) known.push(oid);
    else if (await reader.readHeader(oid)) {
      throw new UploadPackError("invalid-shallow", `invalid shallow object ${oidToHex(oid)}`, oid);
    }
  }
  return known;
}

export async function planShallow(
  graph: CommitGraph,
  reader: Pick<PeelReader, "readHeader">,
  tips: RefTips,
  request: ShallowRequest,
  maxCommits: number,
): Promise<ShallowPlan> {
  const clientShallow = await knownClientShallow(graph, reader, request.clientShallow);
  const { deepen, deepenSince, deepenNot } = request;
  const byRevList = deepenSince !== undefined || deepenNot.length > 0;
  if (deepen === undefined && !byRevList && clientShallow.length === 0) return NO_SHALLOW;

  let computed: { shallow: Oid[]; notShallow: OidTable } = {
    shallow: [],
    notShallow: new OidTable(),
  };
  try {
    if (deepen === INFINITE_DEPTH) {
      // Only a boundary the current refs reach is lifted: its parents become
      // wants, so an unreachable one (kept after a force push, or a
      // sibling's) would serve history no ref names. A walk out of budget
      // counts as unreachable, and the client stays shallow there.
      const reached = await reachableFromRefs(graph, tips, clientShallow, maxCommits);
      for (const [i, oid] of clientShallow.entries()) {
        if (reached[i]) computed.notShallow.add(oid);
      }
    } else if (deepen !== undefined) {
      let heads = request.wants;
      let depth = deepen;
      if (request.deepenRelative) {
        const reached = await reachableFromRefs(graph, tips, clientShallow, maxCommits);
        heads = clientShallow.filter((_, i) => reached[i]);
        depth = deepen + 1;
      }
      computed = await shallowByDepth(graph, heads, depth, maxCommits);
    } else if (byRevList) {
      computed = await shallowByRevList(graph, request.wants, deepenSince, deepenNot, maxCommits);
    }
  } catch (error) {
    if (error instanceof WalkLimitError) throw tooLarge(error.limit);
    throw error;
  }

  const client = new OidTable(clientShallow.length);
  for (const oid of clientShallow) client.add(oid);
  const shallow = computed.shallow.filter(
    (oid) => !client.has(oid) && !computed.notShallow.has(oid),
  );
  const unshallow = clientShallow.filter((oid) => computed.notShallow.has(oid));
  const rows = await graph.read(unshallow, "verified");
  const extraWants = rows.flatMap((row) => row?.parents ?? []);
  const boundary = new OidTable(shallow.length + clientShallow.length);
  for (const oid of [...shallow, ...clientShallow]) boundary.add(oid);
  return { active: true, shallow, unshallow, boundary, extraWants, extraEdges: unshallow };
}

function tooLarge(limit: number): UploadPackError {
  return new UploadPackError(
    "too-large",
    `upload-pack: the shallow request needs more than ${limit} commits; fetch less history`,
  );
}

/**
 * Breadth-first from `heads` (depth 1): commits first reached at a depth
 * below `depth` are not shallow, those first reached at `depth` are the
 * new boundary. This is the minimum depth git's walk settles on.
 */
async function shallowByDepth(
  graph: CommitGraph,
  heads: readonly Oid[],
  depth: number,
  maxCommits: number,
): Promise<{ shallow: Oid[]; notShallow: OidTable }> {
  const walk = new CommitWalk(graph, "verified", { maxCommits });
  const shallow: Oid[] = [];
  const notShallow = new OidTable();
  const visited = new Set<number>();
  let level: number[] = [];
  for (const oid of heads) {
    const i = walk.intern(oid);
    if (!visited.has(i)) {
      visited.add(i);
      level.push(i);
    }
  }
  for (let d = 1; level.length > 0; d++) {
    await walk.load(level);
    if (d >= depth) {
      for (const i of level) shallow.push(walk.oids.oidAt(i));
      break;
    }
    const next: number[] = [];
    for (const i of level) {
      notShallow.add(walk.oids.oidAt(i));
      for (const parent of walk.parentsOf(i)) {
        if (visited.has(parent)) continue;
        visited.add(parent);
        next.push(parent);
      }
    }
    level = next;
  }
  return { shallow, notShallow };
}

const UNINTERESTING = 1;
const SEEN = 2;
const SHOWN = 4;

/**
 * `rev-list [--max-age=since] wants --not deepenNot`, in generation
 * order. Without `deepen-not` the walk is git's unlimited one: a commit
 * older than `since` is dropped and its parents are not followed from it.
 * With `deepen-not` (git then limits the list) an old commit is marked
 * uninteresting and so are its ancestors. The listed commits whose parents
 * are not all listed form the boundary.
 */
async function shallowByRevList(
  graph: CommitGraph,
  wants: readonly Oid[],
  since: number | undefined,
  deepenNot: readonly Oid[],
  maxCommits: number,
): Promise<{ shallow: Oid[]; notShallow: OidTable }> {
  const walk = new CommitWalk(graph, "verified", { maxCommits });
  const limited = deepenNot.length > 0;
  const starts = wants.map((oid) => walk.intern(oid));
  const stops = deepenNot.map((oid) => walk.intern(oid));
  await walk.load([...starts, ...stops]);
  for (const i of stops) walk.flags[i] = (walk.flags[i] as number) | UNINTERESTING;
  const queue = new CommitQueue(walk);
  let interesting = 0;
  const enqueue = (i: number) => {
    walk.flags[i] = (walk.flags[i] as number) | SEEN;
    queue.push(i);
    if (((walk.flags[i] as number) & UNINTERESTING) === 0) interesting++;
  };
  for (const i of [...starts, ...stops]) if (((walk.flags[i] as number) & SEEN) === 0) enqueue(i);

  const shown: number[] = [];
  while (queue.size > 0 && (!limited || interesting > 0)) {
    const commit = queue.pop();
    let flags = walk.flags[commit] as number;
    if ((flags & UNINTERESTING) === 0) interesting--;
    const old = since !== undefined && (walk.date[commit] as number) < since;
    if (old && !limited) continue;
    if (old) flags |= UNINTERESTING;
    if ((flags & UNINTERESTING) === 0) {
      flags |= SHOWN;
      shown.push(commit);
    }
    walk.flags[commit] = flags;
    await walk.loadParents(commit);
    for (const parent of walk.parentsOf(commit)) {
      const before = walk.flags[parent] as number;
      if ((flags & UNINTERESTING) !== 0 && (before & UNINTERESTING) === 0) {
        walk.flags[parent] = before | UNINTERESTING;
        // Queued as interesting, now uninteresting.
        if ((before & SEEN) !== 0) interesting--;
      }
      if ((before & SEEN) === 0) enqueue(parent);
    }
  }
  if (shown.length === 0) {
    throw new UploadPackError("no-shallow-commits", "no commits selected for shallow requests");
  }
  const shallow: Oid[] = [];
  const notShallow = new OidTable(shown.length);
  for (const i of shown) {
    const border = Array.from(walk.parentsOf(i)).some(
      (p) => ((walk.flags[p] as number) & SHOWN) === 0,
    );
    if (border) shallow.push(walk.oids.oidAt(i));
    else notShallow.add(walk.oids.oidAt(i));
  }
  return { shallow, notShallow };
}
