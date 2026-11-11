// A blame request's tree scans are charged on the request's own work meter,
// the one its reader charges and its freshness check reads: through
// RepoBlame, as production wires it. Only tree scans are weighed here, so the
// limit falls between one scan of the tip's tree and two.
import { createClockBlockCache } from "@fyrden/adapters-cloudflare";
import { oidFromHex, type ReaderWorkKind } from "@fyrden/git-core";
import { describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { type BlameAnswer, type BlameResult, RepoBlame } from "../src/do/repo/blame.js";
import { openLiveReader } from "../src/git/live-reader.js";
import { postPush, pushTarget } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("blameFixtures");
const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

/** Weights that count tree scans only, a byte a unit. */
const TREE_SCANS_ONLY: Record<ReaderWorkKind, number> = {
  inflate: 0,
  "delta-program": 0,
  "delta-result": 0,
  "exact-copy": 0,
  "returned-copy": 0,
  "block-run": 0,
  lookup: 0,
  "tree-scan": 1,
};

async function pushed(): Promise<{ stub: DurableObjectStub<RepoDO>; repoId: string }> {
  const target = await pushTarget();
  const reply = await postPush(
    target,
    pushBody([{ old: ZERO, new: fx.tip, ref: "refs/heads/main" }], { pack: fx.pack }),
  );
  expect(reply.report).toContain("ok refs/heads/main\n");
  return { stub: target.repo.stub, repoId: target.repo.id };
}

const ok = (result: BlameResult): BlameAnswer => {
  if (!result.ok) throw new Error(`${result.failure.status} ${result.failure.code}`);
  return result.value;
};

describe("tree scans on the request's meter", () => {
  it("stop a step that isn't fresh, undone, and refuse one that is as work_limit", async () => {
    const { stub, repoId } = await pushed();
    const seen = await inRepo(stub, async (repo) => {
      // The tip's tree and its parent's, as the walk scans them for f.txt.
      const reader = await openLiveReader(
        { git: repo.git, memoryBlocks: createClockBlockCache() },
        { deltaBaseCacheBytes: 1 << 20, maxCacheCalls: 0 },
      );
      if (!reader) throw new Error("no packs");
      const treeSize = async (commit: string) => {
        const row = repo.git.commitGraph.readBounded(oidFromHex(commit), 16);
        if (!row) throw new Error(`no commit ${commit}`);
        const header = await reader.readHeader(row.tree);
        if (!header) throw new Error(`no tree for ${commit}`);
        return header.size;
      };
      const tip = await treeSize(fx.tip);
      const parent = await treeSize(fx.commits.merged as string);
      reader.release();

      const blame = new RepoBlame({
        git: repo.git,
        memoryBlocks: createClockBlockCache(),
        storage: repo.git.context.storage as unknown as DurableObjectStorage,
        repoId: () => repoId,
        epochGen: () => repo.events.epochGen(),
        now: () => NOW,
        // The start scans the tip's tree once; a step scans it and its parent's.
        decodingWork: { limit: tip + Math.floor(tip / 2), weights: TREE_SCANS_ONLY },
      });
      const first = ok(await blame.answer({ path: "f.txt" }));
      // With nothing left to walk there's no continuation, and no second request.
      const second =
        first.next_continuation === null
          ? undefined
          : ok(await blame.answer({ path: "f.txt", continuation: first.next_continuation }));
      const row = repo.git.context.storage.sql
        .exec<{ expires_at: number }>("SELECT expires_at FROM blame_runs WHERE path = 'f.txt'")
        .one();
      return { tip, parent, first, second, expiresAt: row.expires_at };
    });
    // Two scans of the parent's tree and the tip's pass the limit; one of the tip's doesn't.
    expect(seen.tip + seen.parent).toBeGreaterThan(seen.tip + Math.floor(seen.tip / 2));
    // The first request started the run, and its first step, not fresh, ran out: undone.
    expect(seen.first).toMatchObject({ state: "partial", pending_lines: 6, ranges: [] });
    // The next request's step is fresh, and too large for a whole request: refused.
    expect(seen.second).toMatchObject({ state: "complete", pending_lines: 0 });
    expect(seen.second?.ranges).toEqual([
      { start_line: 1, line_count: 6, unresolved: "work_limit" },
    ]);
    expect(seen.expiresAt).toBe(NOW + HOUR);
  });
});
