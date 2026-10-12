import { describe, expect, it } from "vitest";
import { OID_BYTES, type Oid, oidFromBytes } from "../../src/object/oid.js";
import type { CommitGraph, CommitGraphRow } from "../../src/ports/commit-graph.js";

export interface CommitGraphUnderTest {
  graph: CommitGraph;
  /**
   * Makes an upload's pending rows verified, as the ref store's commit
   * transaction does in the real implementation.
   */
  promote(uploadId: string): Promise<void>;
}

const oid = (n: number): Oid => {
  const bytes = new Uint8Array(OID_BYTES);
  bytes[0] = n;
  bytes[19] = 0x5a;
  return oidFromBytes(bytes);
};

const row = (n: number, parents: number[], generation = 1000 + n): CommitGraphRow => ({
  oid: oid(n),
  tree: oid(200 + n),
  parents: parents.map(oid),
  commitTime: 1000 + n,
  generation,
  level: n,
});

/** The behaviour every `CommitGraph` must have. `create` returns an empty graph. */
export function describeCommitGraphContract(
  name: string,
  create: () => Promise<CommitGraphUnderTest>,
): void {
  describe(`${name}: CommitGraph contract`, () => {
    it("returns nothing for unknown commits, one result per requested oid", async () => {
      const { graph } = await create();
      expect(await graph.read([], "verified")).toEqual([]);
      expect(await graph.read([oid(1), oid(1)], "verified")).toEqual([undefined, undefined]);
    });

    it("shows pending rows only to their own upload, until promoted", async () => {
      const { graph, promote } = await create();
      await graph.insertPending("up-a", [row(1, []), row(2, [1])]);
      expect(await graph.read([oid(1), oid(2)], "verified")).toEqual([undefined, undefined]);
      expect(await graph.read([oid(2)], { uploadId: "up-b" })).toEqual([undefined]);
      expect(await graph.read([oid(2), oid(3), oid(1)], { uploadId: "up-a" })).toEqual([
        { ...row(2, [1]), state: "pending" },
        undefined,
        { ...row(1, []), state: "pending" },
      ]);

      await promote("up-a");
      expect(await graph.read([oid(2)], "verified")).toEqual([
        { ...row(2, [1]), state: "verified" },
      ]);
      expect(await graph.read([oid(1)], { uploadId: "up-b" })).toEqual([
        { ...row(1, []), state: "verified" },
      ]);
      expect(await graph.read([oid(1)], { uploadId: "up-a" })).toEqual([
        { ...row(1, []), state: "verified" },
      ]);
    });

    it("keeps uploads apart and discards only the named upload's rows", async () => {
      const { graph, promote } = await create();
      await graph.insertPending("up-a", [row(1, [])]);
      await graph.insertPending("up-b", [row(1, []), row(2, [1])]);
      await graph.discardPending("up-a");
      expect(await graph.read([oid(1)], { uploadId: "up-a" })).toEqual([undefined]);
      expect(await graph.read([oid(1), oid(2)], { uploadId: "up-b" })).toEqual([
        { ...row(1, []), state: "pending" },
        { ...row(2, [1]), state: "pending" },
      ]);
      await graph.discardPending("up-missing");
      await promote("up-b");
      await graph.discardPending("up-b");
      expect(await graph.read([oid(2)], "verified")).toEqual([
        { ...row(2, [1]), state: "verified" },
      ]);
    });

    it("never changes a verified row through a later pending insert", async () => {
      const { graph, promote } = await create();
      await graph.insertPending("up-a", [row(1, [])]);
      await promote("up-a");
      await graph.insertPending("up-b", [row(1, [], 5)]);
      expect(await graph.read([oid(1)], { uploadId: "up-b" })).toEqual([
        { ...row(1, []), state: "verified" },
      ]);
      await promote("up-b");
      expect(await graph.read([oid(1)], "verified")).toEqual([
        { ...row(1, []), state: "verified" },
      ]);
    });

    it("keeps octopus parent order and large numbers exactly", async () => {
      const { graph } = await create();
      const big: CommitGraphRow = {
        ...row(9, [3, 1, 2, 7, 5]),
        commitTime: 2 ** 53 - 1,
        generation: 2 ** 52 + 17,
        level: 0x3fffffff,
      };
      await graph.insertPending("up-a", [big]);
      expect(await graph.read([oid(9)], { uploadId: "up-a" })).toEqual([
        { ...big, state: "pending" },
      ]);
    });

    it("cannot be changed through what it was given or what it returned", async () => {
      const { graph } = await create();
      const input = row(1, [2]);
      await graph.insertPending("up-a", [input]);
      input.oid.fill(9);
      (input.parents[0] as Oid).fill(9);
      const [first] = await graph.read([oid(1)], { uploadId: "up-a" });
      first?.tree.fill(0);
      first?.parents[0]?.fill(0);
      expect(await graph.read([oid(1)], { uploadId: "up-a" })).toEqual([
        { ...row(1, [2]), state: "pending" },
      ]);
    });
  });
}
