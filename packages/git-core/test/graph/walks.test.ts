import { describe, expect, it } from "vitest";
import { BitSet } from "../../src/graph/bitset.js";
import { addPendingCommits } from "../../src/graph/commit-graph.js";
import { MissingCommitError, WalkLimitError } from "../../src/graph/errors.js";
import { mergeBases } from "../../src/graph/merge-base.js";
import { OidTable } from "../../src/graph/oid-table.js";
import {
  canAllFromReach,
  isAncestor,
  markPositions,
  reachableCommits,
} from "../../src/graph/reachability.js";
import { compareOids, oidToHex } from "../../src/object/oid.js";
import { createMemoryCommitGraph } from "../../testing/fakes/memory-commit-graph.js";
import { commitsOf, type HistorySpec, namer, fakeOid as o, verifiedGraph } from "./support.js";

// Criss-cross: a1 and b1 are both best common ancestors of a3 and b3.
//
//   r - a1 - a2 - a3
//     \    X
//       b1 - b2 - b3
const CRISS_CROSS: HistorySpec = [
  ["r", []],
  ["a1", ["r"]],
  ["b1", ["r"]],
  ["a2", ["a1", "b1"]],
  ["b2", ["b1", "a1"]],
  ["a3", ["a2"]],
  ["b3", ["b2"]],
  ["x", []],
  ["oct", ["a1", "b1", "x"]],
];
// "c" is pushed later, in the quarantine tests.
const names = namer([...CRISS_CROSS, ["c", []]]);

describe("mergeBases", () => {
  it("returns every best common ancestor of a criss-cross merge", async () => {
    const graph = await verifiedGraph(CRISS_CROSS);
    expect(names(await mergeBases(graph, "verified", o("a3"), [o("b3")]))).toEqual(["a1", "b1"]);
    expect(names(await mergeBases(graph, "verified", o("a2"), [o("b2")]))).toEqual(["a1", "b1"]);
  });

  it("returns the ancestor itself when one side contains the other", async () => {
    const graph = await verifiedGraph(CRISS_CROSS);
    expect(names(await mergeBases(graph, "verified", o("r"), [o("a3")]))).toEqual(["r"]);
    expect(names(await mergeBases(graph, "verified", o("a3"), [o("a1")]))).toEqual(["a1"]);
    expect(names(await mergeBases(graph, "verified", o("a3"), [o("a3")]))).toEqual(["a3"]);
    expect(names(await mergeBases(graph, "verified", o("a3"), []))).toEqual(["a3"]);
  });

  it("finds nothing across disconnected roots, and merges octopus parents", async () => {
    const graph = await verifiedGraph(CRISS_CROSS);
    expect(await mergeBases(graph, "verified", o("x"), [o("a3")])).toEqual([]);
    expect(names(await mergeBases(graph, "verified", o("oct"), [o("b1")]))).toEqual(["b1"]);
    expect(names(await mergeBases(graph, "verified", o("oct"), [o("b3")]))).toEqual(["a1", "b1"]);
    expect(names(await mergeBases(graph, "verified", o("oct"), [o("a3")]))).toEqual(["a1", "b1"]);
    expect(names(await mergeBases(graph, "verified", o("oct"), [o("x")]))).toEqual(["x"]);
  });

  it("takes several 'twos' as git merge-base does (one against their hypothetical merge)", async () => {
    const graph = await verifiedGraph(CRISS_CROSS);
    expect(names(await mergeBases(graph, "verified", o("a2"), [o("b1"), o("x")]))).toEqual(["b1"]);
    expect(names(await mergeBases(graph, "verified", o("oct"), [o("a3"), o("x")]))).toEqual([
      "a1",
      "b1",
      "x",
    ]);
  });

  it("is ordered by generation, not fooled by clock skew", async () => {
    // Dates run backwards: every child is older than its parents.
    const skewed = CRISS_CROSS.map(([n, p], i) => [n, p, 2_000_000_000 - i * 1000] as const);
    const graph = await verifiedGraph(skewed);
    expect(names(await mergeBases(graph, "verified", o("a3"), [o("b3")]))).toEqual(["a1", "b1"]);
    expect(await isAncestor(graph, "verified", o("r"), o("b3"))).toBe(true);
  });
});

describe("isAncestor and canAllFromReach", () => {
  it("answers ancestry, including a commit being its own ancestor", async () => {
    const graph = await verifiedGraph(CRISS_CROSS);
    expect(await isAncestor(graph, "verified", o("r"), o("a3"))).toBe(true);
    expect(await isAncestor(graph, "verified", o("b1"), o("a2"))).toBe(true);
    expect(await isAncestor(graph, "verified", o("a3"), o("r"))).toBe(false);
    expect(await isAncestor(graph, "verified", o("a2"), o("b3"))).toBe(false);
    expect(await isAncestor(graph, "verified", o("x"), o("oct"))).toBe(true);
    expect(await isAncestor(graph, "verified", o("a3"), o("a3"))).toBe(true);
  });

  it("checks that every 'from' reaches some 'to'", async () => {
    const graph = await verifiedGraph(CRISS_CROSS);
    expect(await canAllFromReach(graph, "verified", [o("a3"), o("b3")], [o("b1")])).toBe(true);
    expect(await canAllFromReach(graph, "verified", [o("a3"), o("oct")], [o("a2"), o("x")])).toBe(
      true,
    );
    expect(await canAllFromReach(graph, "verified", [o("a3"), o("b3")], [o("a2")])).toBe(false);
    expect(await canAllFromReach(graph, "verified", [], [o("a2")])).toBe(true);
    expect(await canAllFromReach(graph, "verified", [o("a2")], [])).toBe(false);
  });
});

describe("reachableCommits", () => {
  it("lists commits reachable from the includes and not from the excludes", async () => {
    const graph = await verifiedGraph(CRISS_CROSS);
    expect(names(await reachableCommits(graph, "verified", [o("a3")]))).toEqual([
      "a1",
      "a2",
      "a3",
      "b1",
      "r",
    ]);
    expect(
      names(await reachableCommits(graph, "verified", [o("a3"), o("oct")], [o("b2")])),
    ).toEqual(["a2", "a3", "oct", "x"]);
    expect(names(await reachableCommits(graph, "verified", [o("a1")], [o("a3")]))).toEqual([]);
  });
});

describe("pending rows (quarantine)", () => {
  async function withPendingPush() {
    const graph = await verifiedGraph(CRISS_CROSS);
    await addPendingCommits(graph, "push-1", commitsOf([["c", ["a3", "b3"]]]));
    return graph;
  }

  it("are invisible to merge-base, ancestry and reachability in the verified view", async () => {
    const graph = await withPendingPush();
    await expect(mergeBases(graph, "verified", o("c"), [o("a1")])).rejects.toThrow(
      MissingCommitError,
    );
    await expect(isAncestor(graph, "verified", o("a1"), o("c"))).rejects.toThrow(
      MissingCommitError,
    );
    await expect(reachableCommits(graph, "verified", [o("c")])).rejects.toThrow(MissingCommitError);
    await expect(
      mergeBases(graph, { uploadId: "push-2" }, o("c"), [o("a1")]),
    ).rejects.toBeInstanceOf(MissingCommitError);
  });

  it("are invisible to merge-base's shortcuts too: equal tips and no 'twos'", async () => {
    const graph = await withPendingPush();
    for (const view of ["verified", { uploadId: "push-2" }] as const) {
      await expect(mergeBases(graph, view, o("c"), [o("c")])).rejects.toThrow(MissingCommitError);
      await expect(mergeBases(graph, view, o("c"), [])).rejects.toThrow(MissingCommitError);
      await expect(mergeBases(graph, view, o("a1"), [o("a1"), o("c")])).rejects.toThrow(
        MissingCommitError,
      );
    }
    // A commit no view has at all.
    await expect(mergeBases(graph, "verified", o("nowhere"), [])).rejects.toThrow(
      MissingCommitError,
    );
    expect(names(await mergeBases(graph, { uploadId: "push-1" }, o("c"), [o("c")]))).toEqual(["c"]);
  });

  it("are walked by their own upload together with verified rows", async () => {
    const graph = await withPendingPush();
    const view = { uploadId: "push-1" };
    expect(names(await mergeBases(graph, view, o("c"), [o("oct")]))).toEqual(["a1", "b1"]);
    expect(await isAncestor(graph, view, o("b3"), o("c"))).toBe(true);
    expect(names(await reachableCommits(graph, view, [o("c")], [o("a2"), o("b2")]))).toEqual([
      "a3",
      "b3",
      "c",
    ]);
  });

  it("must have every parent visible to the upload; nothing is inserted otherwise", async () => {
    const graph = await withPendingPush();
    const orphan = commitsOf([
      ["d", ["c"]],
      ["e", ["d", "missing"]],
    ]);
    const error = await addPendingCommits(graph, "push-2", orphan).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MissingCommitError);
    // "c" is pending in another upload, so for push-2 it is missing too.
    expect((error as MissingCommitError).oids.map(oidToHex).sort()).toEqual(
      [o("c"), o("missing")].map(oidToHex).sort(),
    );
    expect(await graph.read([o("d"), o("e")], { uploadId: "push-2" })).toEqual([
      undefined,
      undefined,
    ]);
    // The same upload may add children of its own pending commits later.
    expect(await addPendingCommits(graph, "push-1", orphan.slice(0, 1))).toBe(1);
    expect(await addPendingCommits(graph, "push-1", orphan.slice(0, 1))).toBe(0);
  });

  it("skips commits the repository already has", async () => {
    const graph = await verifiedGraph(CRISS_CROSS);
    expect(await addPendingCommits(graph, "push-3", commitsOf(CRISS_CROSS))).toBe(0);
  });
});

describe("walk limits", () => {
  it("fails closed with WalkLimitError once a walk loads more commits than allowed", async () => {
    const chain: [string, string[]][] = [["n0", []]];
    for (let i = 1; i < 50; i++) chain.push([`n${i}`, [`n${i - 1}`]]);
    const graph = await verifiedGraph(chain);
    await expect(
      isAncestor(graph, "verified", o("n0"), o("n49"), { maxCommits: 10 }),
    ).rejects.toThrow(WalkLimitError);
    await expect(
      reachableCommits(graph, "verified", [o("n49")], [], { maxCommits: 10 }),
    ).rejects.toThrow(WalkLimitError);
    await expect(
      mergeBases(graph, "verified", o("n49"), [o("n0")], { maxCommits: 10 }),
    ).rejects.toThrow(WalkLimitError);
    expect(await isAncestor(graph, "verified", o("n0"), o("n49"), { maxCommits: 50 })).toBe(true);
  });

  it("rejects graphs whose generations do not decrease from child to parent", async () => {
    const graph = createMemoryCommitGraph();
    const [a, b] = commitsOf([
      ["a", []],
      ["b", ["a"]],
    ]);
    if (!a || !b) throw new Error("fixture");
    await graph.insertPending("bad", [
      { ...a, generation: 10, level: 1 },
      { ...b, generation: 10, level: 2 },
    ]);
    await expect(reachableCommits(graph, { uploadId: "bad" }, [b.oid])).rejects.toThrow(
      /generation/,
    );
  });
});

describe("markPositions", () => {
  it("sets the bit of each commit's position in a pack index, skipping absent ones", async () => {
    const graph = await verifiedGraph(CRISS_CROSS);
    const reachable = await reachableCommits(graph, "verified", [o("a3")]);
    // A fake .idx: sorted oids of some commits plus an unrelated one.
    const inPack = [o("a1"), o("a3"), o("b2"), o("x"), o("r")].sort(compareOids);
    const lookup = new OidTable();
    for (const oid of inPack) lookup.add(oid);
    const bits = new BitSet(inPack.length);
    const marked = markPositions(reachable, (bytes, offset) => lookup.indexOf(bytes, offset), bits);
    expect(marked).toBe(3);
    expect(names([...bits.indices()].map((i) => inPack[i] as (typeof inPack)[number]))).toEqual([
      "a1",
      "a3",
      "r",
    ]);
  });
});
