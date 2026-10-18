// Pushes indexed at once, each phase waiting for its share of the
// repository's memory before it holds any: phases that would each take
// part of what is free wait their turn instead, and a phase whose lock
// lapsed while it waited does not index.
import { env } from "cloudflare:workers";
import { createClockBlockCache } from "@fyrden/adapters-cloudflare";
import { createLogger } from "@fyrden/adapters-cloudflare/obs";
import { PushIndexer, pushIndexMemoryBytes } from "@fyrden/git-core";
import { describe, expect, inject, it, vi } from "vitest";
import { PACK_CAP_DEFAULTS } from "../src/git/maintenance/tail-merge-plan.js";
import { RepoPush } from "../src/git/push/repo-push.js";
import { setOffset } from "./helpers/maintenance.js";
import { pushBody, reportLines, ZERO } from "./helpers/push-fixtures.js";
import { inRepo, newRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");

describe("push: concurrent indexing", () => {
  it("indexes pushes at once that would each hold part of the memory left", async () => {
    const { stub } = await newRepo();
    const reports = await inRepo(stub, async (repo) => {
      const blocks = createClockBlockCache();
      const push = new RepoPush(
        repo.git,
        repo.git.context.metrics,
        createLogger({ test: "push-concurrent-indexing" }),
        () => PACK_CAP_DEFAULTS,
        () => blocks,
      );
      const run = async (ref: string) => {
        const bytes = pushBody([{ old: ZERO, new: fx.c2, ref }], { pack: fx.packC2 });
        const begun = push.begin({ principal: "usr_indexing", tokenId: "tok_indexing" });
        if (!begun.ok) throw new Error(begun.error);
        await env.GIT.put(begun.bodyKey, bytes);
        let progress = await push.run(begun.uploadId, bytes.length, 10_000);
        for (let i = 0; progress.state === "indexing" && i < 50; i++)
          progress = await push.status(begun.uploadId, 10_000);
        const response =
          progress.state === "done"
            ? progress.response
            : await push.finalize(begun.uploadId, {
                tokenId: "tok_indexing",
                decidedAt: Date.now(),
              });
        return reportLines(response).report;
      };
      // Other work holds all but one and a half phases' shares: two phases
      // never fit at once.
      const { totalBytes, reservedBytes } = repo.git.memory.stats();
      const free = Math.floor(1.5 * pushIndexMemoryBytes());
      const hog = repo.git.memory.tryReserve(totalBytes - reservedBytes - free);
      try {
        return await Promise.all(["a", "b", "c"].map((name) => run(`refs/heads/${name}`)));
      } finally {
        hog?.release();
      }
    });
    expect(reports).toEqual(
      ["a", "b", "c"].map((name) => ["unpack ok\n", `ok refs/heads/${name}\n`, "0000"]),
    );
  });

  it("indexes nothing once its lock lapsed while it waited for memory", async () => {
    const { stub } = await newRepo();
    const outcome = await inRepo(stub, async (repo) => {
      const step = vi.spyOn(PushIndexer.prototype, "step");
      try {
        const blocks = createClockBlockCache();
        const push = new RepoPush(
          repo.git,
          repo.git.context.metrics,
          createLogger({ test: "push-concurrent-indexing" }),
          () => PACK_CAP_DEFAULTS,
          () => blocks,
        );
        const bytes = pushBody([{ old: ZERO, new: fx.c2, ref: "refs/heads/a" }], {
          pack: fx.packC2,
        });
        const begun = push.begin({ principal: "usr_indexing", tokenId: "tok_indexing" });
        if (!begun.ok) throw new Error(begun.error);
        await env.GIT.put(begun.bodyKey, bytes);
        // Other work holds all but just less than a phase's share.
        const { totalBytes, reservedBytes } = repo.git.memory.stats();
        const hog = repo.git.memory.tryReserve(
          totalBytes - reservedBytes - pushIndexMemoryBytes() + 1,
        );
        const running = push.run(begun.uploadId, bytes.length, 10_000);
        await vi.waitFor(() => expect(repo.git.memory.stats().waiting).toBe(1));
        // Meanwhile its lock lapses, and another runner takes it.
        setOffset(repo.git, 10 * 60 * 1000);
        const other = repo.git.locks.tryAcquire(
          `push-index:${begun.uploadId}`,
          "index",
          60 * 60 * 1000,
        );
        hog?.release();
        const progress = await running;
        return { state: progress.state, other: other !== undefined, steps: step.mock.calls.length };
      } finally {
        step.mockRestore();
      }
    });
    expect(outcome).toEqual({ state: "indexing", other: true, steps: 0 });
  });
});
