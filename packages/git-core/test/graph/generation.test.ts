import { describe, expect, it } from "vitest";
import { MissingCommitError } from "../../src/graph/errors.js";
import {
  computeGenerations,
  correctedCommitDate,
  correctedDateOffset,
  GENERATION_DATE_MAX,
  GENERATION_V1_MAX,
  GENERATION_V2_OFFSET_MAX,
  topologicalLevel,
} from "../../src/graph/generation.js";
import { OID_BYTES, type Oid, oidFromBytes, oidToHex } from "../../src/object/oid.js";
import type { CommitInfo } from "../../src/ports/commit-graph.js";

const oid = (n: number): Oid => {
  const bytes = new Uint8Array(OID_BYTES);
  bytes[0] = n;
  bytes[19] = 0xaa;
  return oidFromBytes(bytes);
};
const TREE = oid(250);
const commit = (n: number, parents: number[], commitTime: number): CommitInfo => ({
  oid: oid(n),
  tree: TREE,
  parents: parents.map(oid),
  commitTime,
});

// Expected values follow git's definitions (Documentation/technical/
// commit-graph.adoc and compute_generation_from_max in commit-graph.c, git
// v2.53.0); the differential suite checks them against commit-graph files
// git writes.
describe("generation numbers", () => {
  it("topological level: roots are 1, others one more than their highest parent", () => {
    expect(topologicalLevel(0)).toBe(1);
    expect(topologicalLevel(7)).toBe(8);
  });

  it("topological level saturates at GENERATION_NUMBER_V1_MAX (0x3FFFFFFF)", () => {
    expect(GENERATION_V1_MAX).toBe(0x3fffffff);
    expect(topologicalLevel(GENERATION_V1_MAX - 2)).toBe(GENERATION_V1_MAX - 1);
    expect(topologicalLevel(GENERATION_V1_MAX - 1)).toBe(GENERATION_V1_MAX);
    expect(topologicalLevel(GENERATION_V1_MAX)).toBe(GENERATION_V1_MAX);
  });

  it("corrected commit date: the commit date, or one more than the highest parent", () => {
    expect(correctedCommitDate(1000, 0)).toBe(1000);
    // Clock skew: a child older than its parent.
    expect(correctedCommitDate(50, 100)).toBe(101);
    expect(correctedCommitDate(100, 100)).toBe(101);
    expect(correctedCommitDate(101, 100)).toBe(101);
    expect(correctedCommitDate(102, 100)).toBe(102);
  });

  it("a root dated 0 gets corrected date 1, so it differs from 'not computed'", () => {
    expect(correctedCommitDate(0, 0)).toBe(1);
    expect(correctedCommitDate(0, 5)).toBe(6);
  });

  it("stays strictly above its parents for dates past 2^53, where doubles lose integers", () => {
    const parent = correctedCommitDate(2 ** 63 - 1, 0);
    expect(parent).toBe(GENERATION_DATE_MAX);
    expect(Number.isSafeInteger(parent)).toBe(true);
    expect(correctedCommitDate(2 ** 63 - 1, parent)).toBe(parent + 1);
  });

  it("offsets above 2^31 - 1 are git's overflow case", () => {
    expect(GENERATION_V2_OFFSET_MAX).toBe(2 ** 31 - 1);
    expect(correctedDateOffset(5, 5)).toBe(0);
    expect(correctedDateOffset(1, 4_000_000_001)).toBe(4_000_000_000);
    expect(correctedDateOffset(1, 4_000_000_001) > GENERATION_V2_OFFSET_MAX).toBe(true);
  });
});

describe("computeGenerations", () => {
  it("computes both numbers for a batch in any order, using known parents outside it", () => {
    const known = new Map([[oidToHex(oid(1)), { level: 4, generation: 500 }]]);
    // 4 merges 2 and 3; 2 and 3 have parent 1 (outside the batch); 3 is skewed.
    const rows = computeGenerations(
      [commit(4, [2, 3], 450), commit(3, [1], 100), commit(2, [1], 600)],
      (o) => known.get(oidToHex(o)),
    );
    const byOid = new Map(rows.map((r) => [oidToHex(r.oid), r]));
    expect(rows).toHaveLength(3);
    expect(byOid.get(oidToHex(oid(2)))).toMatchObject({ level: 5, generation: 600 });
    expect(byOid.get(oidToHex(oid(3)))).toMatchObject({ level: 5, generation: 501 });
    expect(byOid.get(oidToHex(oid(4)))).toMatchObject({ level: 6, generation: 601 });
    // Parents come before children, so rows can be inserted in order.
    expect(rows.map((r) => r.oid[0]).at(-1)).toBe(4);
  });

  it("handles roots, octopus merges and a commit listed twice", () => {
    const rows = computeGenerations(
      [commit(1, [], 0), commit(2, [], 10), commit(3, [1, 2, 1], 5), commit(1, [], 0)],
      () => undefined,
    );
    const sorted = rows.map((r) => [r.oid[0], r.level, r.generation]);
    expect(sorted.sort((a, b) => (a[0] as number) - (b[0] as number))).toEqual([
      [1, 1, 1],
      [2, 1, 10],
      [3, 2, 11],
    ]);
  });

  it("lists every parent that is neither in the batch nor known", () => {
    try {
      computeGenerations([commit(3, [1, 2], 5), commit(4, [9], 5)], (o) =>
        o[0] === 2 ? { level: 1, generation: 1 } : undefined,
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MissingCommitError);
      expect((error as MissingCommitError).oids.map((o) => o[0]).sort()).toEqual([1, 9]);
    }
  });
});
