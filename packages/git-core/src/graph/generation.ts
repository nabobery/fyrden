import type { Oid } from "../object/oid.js";
import type { CommitGraphRow, CommitInfo } from "../ports/commit-graph.js";
import { MissingCommitError } from "./errors.js";
import { OidTable } from "./oid-table.js";

/*
 * git's two generation numbers, as defined in git's
 * Documentation/technical/commit-graph.adoc and computed by
 * compute_generation_from_max() in commit-graph.c (git v2.53.0, verified
 * against the source):
 *
 * - topological level (v1): 1 for a root, else 1 + the highest parent level,
 *   saturating at GENERATION_NUMBER_V1_MAX;
 * - corrected commit date (v2): for a root its commit date, else the larger
 *   of its commit date and 1 + the highest parent corrected date; a root
 *   dated 0 gets 1.
 *
 * Both satisfy "if A reaches B then gen(A) >= gen(B)"; the corrected date is
 * strictly greater than every parent's, which the walks rely on.
 */

/** git's GENERATION_NUMBER_V1_MAX: the 30 bits the commit-graph file has for a level. */
export const GENERATION_V1_MAX = 0x3fffffff;

/**
 * git's GENERATION_NUMBER_V2_OFFSET_MAX. The commit-graph file stores
 * `corrected date - commit date` in 31 bits; larger offsets go to its
 * overflow chunk. Rows here hold the corrected date itself, so this matters
 * only when writing git's file format.
 */
export const GENERATION_V2_OFFSET_MAX = 2 ** 31 - 1;

/**
 * Commit dates above this (about 142 million years after 1970) are treated
 * as this value when computing corrected dates, so corrected dates remain
 * exact integers in a double and stay strictly above their parents'. git
 * keeps 64-bit integers and has no such cap; it only affects absurd dates.
 */
export const GENERATION_DATE_MAX = 2 ** 52;

export interface Generations {
  readonly level: number;
  readonly generation: number;
}

/** Topological level of a commit whose highest parent level is `maxParentLevel` (0 for a root). */
export function topologicalLevel(maxParentLevel: number): number {
  return Math.min(maxParentLevel, GENERATION_V1_MAX - 1) + 1;
}

/** Corrected commit date of a commit whose highest parent corrected date is `maxParent` (0 for a root). */
export function correctedCommitDate(commitTime: number, maxParent: number): number {
  const date = Math.min(commitTime, GENERATION_DATE_MAX);
  return date > maxParent ? date : maxParent + 1;
}

/** What git's commit-graph file stores for a corrected date. */
export function correctedDateOffset(commitTime: number, generation: number): number {
  return generation - commitTime;
}

/**
 * Computes both generation numbers for a batch of new commits, given in any
 * order. A parent must be in the batch or known to `known`; otherwise the
 * call throws `MissingCommitError` listing every such parent. A commit listed
 * twice is computed once. Rows come back parents first.
 */
export function computeGenerations(
  commits: readonly CommitInfo[],
  known: (oid: Oid) => Generations | undefined,
): CommitGraphRow[] {
  const batch = new OidTable(commits.length);
  const unique: CommitInfo[] = [];
  for (const commit of commits) {
    if (batch.add(commit.oid) === unique.length) unique.push(commit);
  }

  // In-batch edges as flat arrays (children of each commit, CSR layout);
  // external parents contribute their numbers up front. A parent listed
  // twice counts twice on both sides, which stays consistent.
  const n = unique.length;
  const pending = new Int32Array(n);
  const childStart = new Int32Array(n + 1);
  const maxLevel = new Float64Array(n);
  const maxGeneration = new Float64Array(n);
  const missing = new OidTable();
  unique.forEach((commit, i) => {
    for (const parent of commit.parents) {
      const p = batch.indexOf(parent);
      if (p >= 0) {
        pending[i] = (pending[i] as number) + 1;
        childStart[p + 1] = (childStart[p + 1] as number) + 1;
        continue;
      }
      const numbers = known(parent);
      if (!numbers) {
        missing.add(parent);
        continue;
      }
      maxLevel[i] = Math.max(maxLevel[i] as number, numbers.level);
      maxGeneration[i] = Math.max(maxGeneration[i] as number, numbers.generation);
    }
  });
  if (missing.size > 0) throw new MissingCommitError([...missing]);
  for (let i = 0; i < n; i++)
    childStart[i + 1] = (childStart[i + 1] as number) + (childStart[i] as number);
  const children = new Int32Array(childStart[n] as number);
  const filled = childStart.slice(0, n);
  unique.forEach((commit, i) => {
    for (const parent of commit.parents) {
      const p = batch.indexOf(parent);
      if (p >= 0) children[(filled[p] as number)++] = i;
    }
  });

  // Kahn's algorithm: a commit is computed once all its in-batch parents are.
  const rows: CommitGraphRow[] = [];
  const ready: number[] = [];
  pending.forEach((count, i) => {
    if (count === 0) ready.push(i);
  });
  while (ready.length > 0) {
    const i = ready.pop() as number;
    const commit = unique[i] as CommitInfo;
    const level = topologicalLevel(maxLevel[i] as number);
    const generation = correctedCommitDate(commit.commitTime, maxGeneration[i] as number);
    rows.push({ ...commit, level, generation });
    for (let c = childStart[i] as number; c < (childStart[i + 1] as number); c++) {
      const child = children[c] as number;
      maxLevel[child] = Math.max(maxLevel[child] as number, level);
      maxGeneration[child] = Math.max(maxGeneration[child] as number, generation);
      pending[child] = (pending[child] as number) - 1;
      if (pending[child] === 0) ready.push(child);
    }
  }
  // Commit ids are hashes of their parents' ids, so a cycle means corrupt input.
  if (rows.length !== unique.length) throw new RangeError("commit batch contains a parent cycle");
  return rows;
}
