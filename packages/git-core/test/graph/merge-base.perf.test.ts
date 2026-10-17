import { describe, expect, it } from "vitest";
import { addPendingCommits } from "../../src/graph/commit-graph.js";
import { WalkLimitError } from "../../src/graph/errors.js";
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
 * The work is asserted as commits walked (each walk's `maxCommits`), never
 * as time. Measured [M] (Apple M4, Node 24, in-memory fake graph,
 * 2026-10-11): insert with generation numbers 433 ms, merge-base 72 ms,
 * is-ancestor(root, tip) 127 ms and rev-list of all 100,000 commits 266 ms;
 * `FYRDEN_BENCH=1` prints the times again. A Durable Object reading SQLite
 * rows is slower and is measured separately.
 */
const BENCH = Boolean(process.env.FYRDEN_BENCH);
// biome-ignore lint/style/noRestrictedGlobals: printed under FYRDEN_BENCH, never asserted.
const clock = () => performance.now();
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

describe("walks on 100k commits", () => {
  it("find the two merge bases within 25,000 commits walked, and walk the rest once", async () => {
    const { commits, a, b, root } = history();
    const graph = createMemoryCommitGraph();

    let start = clock();
    await addPendingCommits(graph, "import", commits);
    await graph.promote("import");
    const insertMs = clock() - start;

    // Bounded: the walk stops at the boundary, so a budget a little above
    // its 20,000 commits is enough, and one well below it is not.
    await expect(
      mergeBases(graph, "verified", fakeOid(a), [fakeOid(b)], { maxCommits: 10_000 }),
    ).rejects.toThrow(WalkLimitError);
    start = clock();
    const bases = await mergeBases(graph, "verified", fakeOid(a), [fakeOid(b)], {
      maxCommits: 25_000,
    });
    const mergeBaseMs = clock() - start;
    expect(bases.map(oidToHex).sort()).toEqual(
      [fakeOid("a39999"), fakeOid("b39999")].map(oidToHex).sort(),
    );

    start = clock();
    expect(
      await isAncestor(graph, "verified", fakeOid(root), fakeOid(a), {
        maxCommits: commits.length,
      }),
    ).toBe(true);
    const ancestorMs = clock() - start;

    start = clock();
    const all = await reachableCommits(graph, "verified", [fakeOid(a), fakeOid(b)], [], {
      maxCommits: commits.length,
    });
    const revListMs = clock() - start;
    expect(all.size).toBe(commits.length);

    if (BENCH)
      console.info(
        `100k commits: insert ${insertMs.toFixed(0)} ms, merge-base ${mergeBaseMs.toFixed(0)} ms, ` +
          `is-ancestor(root) ${ancestorMs.toFixed(0)} ms, rev-list ${revListMs.toFixed(0)} ms, ` +
          `walk table ${(all.byteLength / 1024 / 1024).toFixed(1)} MiB of oids`,
      );
  }, 60_000);
});
