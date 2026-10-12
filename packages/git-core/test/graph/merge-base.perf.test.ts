import { describe, expect, it } from "vitest";
import { addPendingCommits } from "../../src/graph/commit-graph.js";
import { mergeBases } from "../../src/graph/merge-base.js";
import { isAncestor, reachableCommits } from "../../src/graph/reachability.js";
import { oidToHex } from "../../src/object/oid.js";
import type { CommitInfo } from "../../src/ports/commit-graph.js";
import { createMemoryCommitGraph } from "../../testing/fakes/memory-commit-graph.js";
import { fakeOid } from "./support.js";

/*
 * CPU budget for walks on a 100,000-commit history: two branches of 50,000
 * commits from one root, with a criss-cross pair of merges every 1,000
 * commits until the last 10,000, so the merge-base walk has to cover about
 * 20,000 commits and find two bases. A walk from tip to root covers all
 * 100,000.
 *
 * Measured [M] (Apple M4, Node 24, in-memory fake graph, 2026-10-11):
 * insert with generation numbers 433 ms, merge-base 72 ms (two bases, about
 * 20,000 commits walked), is-ancestor(root, tip) 127 ms and rev-list of all
 * 100,000 commits 266 ms. The bounds asserted below are deliberately
 * generous so the test does not flake on slow CI machines; a Durable Object
 * reading SQLite rows will be slower and is measured separately.
 */
const PER_BRANCH = 50_000;

function history(): { commits: CommitInfo[]; a: string; b: string; root: string } {
  const commits: CommitInfo[] = [];
  const add = (name: string, parents: string[], time: number) =>
    commits.push({
      oid: fakeOid(name),
      tree: fakeOid("tree"),
      parents: parents.map(fakeOid),
      commitTime: time,
    });
  add("root", [], 1_600_000_000);
  for (let i = 1; i <= PER_BRANCH; i++) {
    const crossed = i % 1000 === 0 && i <= PER_BRANCH - 10_000;
    add(
      `a${i}`,
      i === 1 ? ["root"] : crossed ? [`a${i - 1}`, `b${i - 1}`] : [`a${i - 1}`],
      1_600_000_000 + i,
    );
    add(
      `b${i}`,
      i === 1 ? ["root"] : crossed ? [`b${i - 1}`, `a${i - 1}`] : [`b${i - 1}`],
      1_600_000_000 + i,
    );
  }
  return { commits, a: `a${PER_BRANCH}`, b: `b${PER_BRANCH}`, root: "root" };
}

describe("walk performance on 100k commits", () => {
  it("merge-base in 72 ms measured, bounded at 5 s", async () => {
    const { commits, a, b, root } = history();
    const graph = createMemoryCommitGraph();

    let start = performance.now();
    await addPendingCommits(graph, "import", commits);
    await graph.promote("import");
    const insertMs = performance.now() - start;

    start = performance.now();
    const bases = await mergeBases(graph, "verified", fakeOid(a), [fakeOid(b)]);
    const mergeBaseMs = performance.now() - start;
    expect(bases.map(oidToHex).sort()).toEqual(
      [fakeOid("a39999"), fakeOid("b39999")].map(oidToHex).sort(),
    );

    start = performance.now();
    expect(await isAncestor(graph, "verified", fakeOid(root), fakeOid(a))).toBe(true);
    const ancestorMs = performance.now() - start;

    start = performance.now();
    const all = await reachableCommits(graph, "verified", [fakeOid(a), fakeOid(b)]);
    const revListMs = performance.now() - start;
    expect(all.size).toBe(commits.length);

    console.info(
      `100k commits: insert ${insertMs.toFixed(0)} ms, merge-base ${mergeBaseMs.toFixed(0)} ms, ` +
        `is-ancestor(root) ${ancestorMs.toFixed(0)} ms, rev-list ${revListMs.toFixed(0)} ms, ` +
        `walk table ${(all.byteLength / 1024 / 1024).toFixed(1)} MiB of oids`,
    );
    expect(mergeBaseMs).toBeLessThan(5_000);
    expect(ancestorMs).toBeLessThan(5_000);
    expect(revListMs).toBeLessThan(5_000);
  }, 60_000);
});
