import { createHash } from "node:crypto";
import { addPendingCommits } from "../../src/graph/commit-graph.js";
import { type Oid, oidFromBytes, oidToHex } from "../../src/object/oid.js";
import type { CommitInfo } from "../../src/ports/commit-graph.js";
import {
  createMemoryCommitGraph,
  type MemoryCommitGraph,
} from "../../testing/fakes/memory-commit-graph.js";

/** A stand-in oid for a commit name in hand-built histories. */
export function fakeOid(name: string): Oid {
  return oidFromBytes(createHash("sha1").update(name).digest());
}

const EMPTY_TREE = fakeOid("tree");

/** `name: [parents...]` in any order; dates default to the position in the list. */
export type HistorySpec = readonly (readonly [string, readonly string[], number?])[];

export function commitsOf(spec: HistorySpec): CommitInfo[] {
  return spec.map(([name, parents, date], i) => ({
    oid: fakeOid(name),
    tree: EMPTY_TREE,
    parents: parents.map(fakeOid),
    commitTime: date ?? 1_700_000_000 + i,
  }));
}

/** A graph holding `spec` as verified rows. */
export async function verifiedGraph(spec: HistorySpec): Promise<MemoryCommitGraph> {
  const graph = createMemoryCommitGraph();
  await addPendingCommits(graph, "setup", commitsOf(spec));
  await graph.promote("setup");
  return graph;
}

/** Maps oids back to the names used in a spec, for readable assertions. */
export function namer(spec: HistorySpec): (oids: Iterable<Oid>) => string[] {
  const names = new Map(spec.map(([name]) => [oidToHex(fakeOid(name)), name]));
  return (oids) => [...oids].map((o) => names.get(oidToHex(o)) ?? oidToHex(o)).sort();
}
