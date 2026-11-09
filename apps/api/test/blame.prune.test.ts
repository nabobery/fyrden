// Cleanup of blame runs: expired rows go, checkpoints no row names go once
// they're past the grace time, and the job runs until a whole pass finds
// nothing, never ending while a slice is writing. A restore forgets every
// run, and deleting the repository takes its checkpoints.
import { env } from "cloudflare:workers";
import { createClockBlockCache } from "@fyrden/adapters-cloudflare";
import {
  blameCheckpointKey,
  blameCheckpointPrefix,
  DEFAULT_JOB_POLICY,
  JobQueue,
  newUlid,
} from "@fyrden/adapters-cloudflare/git";
import { currentInvocation, measureInvocation } from "@fyrden/adapters-cloudflare/obs";
import { oidFromHex } from "@fyrden/git-core";
import { describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { RepoBlame } from "../src/do/repo/blame.js";
import { blamePruneHandler, PRUNE_GRACE_MS } from "../src/do/repo/blame-prune.js";
import { BlameRuns } from "../src/do/repo/blame-runs.js";
import { eraseRepository } from "../src/do/repo/erase.js";
import { postPush, pushTarget } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("blameFixtures");
const HOUR = 60 * 60 * 1000;
const RUN = "01J9ABCDEFGHJKMNPQRSTVWXYZ";

async function pushed(): Promise<{ stub: DurableObjectStub<RepoDO>; repoId: string }> {
  const target = await pushTarget();
  const reply = await postPush(
    target,
    pushBody([{ old: ZERO, new: fx.tip, ref: "refs/heads/main" }], { pack: fx.pack }),
  );
  expect(reply.report).toContain("ok refs/heads/main\n");
  return { stub: target.repo.stub, repoId: target.repo.id };
}

type Repo = Parameters<Parameters<typeof inRepo>[1]>[0];
const key = (n: number, epochGen = 0) => ({
  commit: oidFromHex(n.toString(16).padStart(40, "0")),
  path: `f${n}.txt`,
  engineVersion: 1,
  epochGen,
});
const job = (cursor: Uint8Array | null = null) => ({
  jobId: "blame_prune",
  kind: "blame_prune" as const,
  cursor,
  attempts: 0,
  claim: 1,
});

function handler(repo: Repo, repoId: string, active: Set<string> = new Set()) {
  return blamePruneHandler({ git: repo.git, active: () => active, repoId: () => repoId });
}

/** Writes an object under the repository's checkpoint prefix, as if written at `at`. */
async function checkpointAt(repo: Repo, repoId: string, at: number, run = RUN): Promise<string> {
  const k = blameCheckpointKey({ repoId, runId: run, generation: 1, ulid: newUlid(at) });
  await repo.git.bucket.put(k, new Uint8Array([1]));
  return k;
}

const keysUnder = async (repo: Repo, repoId: string) =>
  (await repo.git.bucket.list({ prefix: blameCheckpointPrefix(repoId) })).objects
    .map((o) => o.key)
    .sort();

/** Runs slices until the job is done, or `limit` slices; what each answered. */
async function untilDone(run: ReturnType<typeof handler>, limit = 20) {
  const results = [];
  let cursor: Uint8Array | null = null;
  for (let k = 0; k < limit; k++) {
    const result = await run.runSlice(job(cursor));
    results.push(result);
    if (result.done) break;
    cursor = result.cursor;
  }
  return results;
}

describe("blame_prune", () => {
  it("removes expired runs, never one being written, and asks again at the next expiry", async () => {
    const { stub, repoId } = await pushed();
    const seen = await inRepo(stub, async (repo) => {
      const runs = new BlameRuns(repo.git.context.storage);
      const now = repo.git.context.now();
      const old = runs.create(key(1), now - 48 * HOUR, new Set()).row.runId;
      const writing = runs.create(key(2), now - 48 * HOUR, new Set()).row.runId;
      const live = runs.create(key(3), now, new Set()).row.runId;
      const result = await handler(repo, repoId, new Set([writing])).runSlice(job());
      return {
        result,
        left: [old, writing, live].map((id) => runs.get(id) !== undefined),
        expiresIn: (runs.get(live)?.expiresAt ?? 0) - now,
      };
    });
    expect(seen.left).toEqual([false, true, true]);
    expect(seen.result.done).toBe(false);
    if (!seen.result.done) expect(seen.result.runAfterMs).toBeLessThanOrEqual(seen.expiresIn);
  });

  it("deletes a checkpoint no run names once past the grace time, and keeps a young one or a named one", async () => {
    const { stub, repoId } = await pushed();
    const seen = await inRepo(stub, async (repo) => {
      const now = repo.git.context.now();
      const orphan = await checkpointAt(repo, repoId, now - 2 * HOUR);
      const young = await checkpointAt(repo, repoId, now - 1000, "01J9ABCDEFGHJKMNPQRSTVWXY0");
      const runs = new BlameRuns(repo.git.context.storage);
      const run = runs.create(key(1), now, new Set()).row;
      const named = await checkpointAt(repo, repoId, now - 2 * HOUR, run.runId);
      runs.publish(
        run.runId,
        { generation: 0, epochGen: 0 },
        {
          blobOid: null,
          generation: 1,
          checkpointKey: named,
          checkpointBytes: 1,
          state: "running",
          lines: 1,
          settledRanges: 0,
          unresolvedLines: 0,
          touchedAt: now,
          expiresAt: now + 24 * HOUR,
        },
      );
      const result = await handler(repo, repoId).runSlice(job());
      return { result, keys: await keysUnder(repo, repoId), orphan, young, named };
    });
    expect(seen.keys).toEqual([seen.young, seen.named].sort());
    expect(seen.result.done).toBe(false);
    if (!seen.result.done) expect(seen.result.runAfterMs).toBeLessThanOrEqual(PRUNE_GRACE_MS);
  });

  it("pages through many objects, and ends only after a pass that finds nothing", async () => {
    const { stub, repoId } = await pushed();
    const seen = await inRepo(stub, async (repo) => {
      const now = repo.git.context.now();
      for (let k = 0; k < 130; k++) await checkpointAt(repo, repoId, now - 2 * HOUR - k);
      const results = await untilDone(handler(repo, repoId));
      return { results: results.map((r) => r.done), keys: await keysUnder(repo, repoId) };
    });
    expect(seen.keys).toEqual([]);
    // Two pages delete everything; one more pass finds nothing, and ends.
    expect(seen.results).toEqual([false, false, true]);
  });

  it("keeps an old unnamed checkpoint of a run being written, whatever its clock said", async () => {
    const { stub, repoId } = await pushed();
    const seen = await inRepo(stub, async (repo) => {
      const now = repo.git.context.now();
      const writing = await checkpointAt(repo, repoId, now - 2 * HOUR);
      await checkpointAt(repo, repoId, now - 2 * HOUR, "01J9ABCDEFGHJKMNPQRSTVWXY0");
      await handler(repo, repoId, new Set([RUN])).runSlice(job());
      return { keys: await keysUnder(repo, repoId), writing };
    });
    expect(seen.keys).toEqual([seen.writing]);
  });

  it("counts its R2 calls, so the scheduler stops the sweep at the invocation's budget", async () => {
    const { stub, repoId } = await pushed();
    const seen = await inRepo(stub, async (repo) => {
      const now = repo.git.context.now();
      for (let k = 0; k < 250; k++) await checkpointAt(repo, repoId, now - 2 * HOUR - k);
      return measureInvocation(
        repo.git.context.metrics,
        { where: "do", op: "test", doClass: "RepoDO" },
        async () => {
          const jobs = new JobQueue(repo.git.context, () => {}, {
            ...DEFAULT_JOB_POLICY,
            maxInternalCalls: 4,
          });
          jobs.ensure("blame_prune", "blame_prune");
          const ran = await jobs.runDue(
            { blame_prune: handler(repo, repoId) },
            repo.git.memory,
            now + 60_000,
          );
          return {
            ran,
            calls: currentInvocation()?.tally.internal ?? -1,
            job: jobs.get("blame_prune")?.state,
            left: (await keysUnder(repo, repoId)).length,
          };
        },
      );
    });
    // Each slice lists once and deletes once: two slices reach the budget of four.
    expect(seen.ran).toBe(2);
    expect(seen.calls).toBe(4);
    expect(seen.job).toBe("queued");
    expect(seen.left).toBe(50);
  });

  it("doesn't end while a slice is writing, even with nothing to remove", async () => {
    const { stub, repoId } = await pushed();
    const result = await inRepo(stub, (repo) =>
      handler(repo, repoId, new Set(["01J9ABCDEFGHJKMNPQRSTVWXYZ"])).runSlice(job()),
    );
    expect(result.done).toBe(false);
  });

  it("backs off when R2 fails, without throwing, and finishes once it's back", async () => {
    const { stub, repoId } = await pushed();
    const seen = await inRepo(stub, async (repo) => {
      const now = repo.git.context.now();
      await checkpointAt(repo, repoId, now - 2 * HOUR);
      let failing = true;
      const bucket = new Proxy(repo.git.bucket, {
        get(inner, property) {
          const value = Reflect.get(inner, property);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (failing && property === "list") return Promise.reject(new Error("R2 unavailable"));
            return value.apply(inner, args);
          };
        },
      });
      const git = new Proxy(repo.git, {
        get: (inner, property) => (property === "bucket" ? bucket : Reflect.get(inner, property)),
      });
      const run = blamePruneHandler({ git, active: () => new Set(), repoId: () => repoId });
      const first = await run.runSlice(job());
      const second = await run.runSlice(job(first.done ? null : first.cursor));
      failing = false;
      const rest = [];
      let cursor = second.done ? null : second.cursor;
      for (let k = 0; k < 5; k++) {
        const r = await run.runSlice(job(cursor));
        rest.push(r.done);
        if (r.done) break;
        cursor = r.cursor;
      }
      return {
        delays: [first, second].map((r) => (r.done ? -1 : (r.runAfterMs ?? 0))),
        rest,
        keys: await keysUnder(repo, repoId),
      };
    });
    expect(seen.delays[0]).toBeGreaterThan(0);
    expect(seen.delays[1]).toBe(2 * (seen.delays[0] as number));
    expect(seen.rest.at(-1)).toBe(true);
    expect(seen.keys).toEqual([]);
  });

  it("after a restore forgets every run, and queues the cleanup", async () => {
    const { stub, repoId } = await pushed();
    const seen = await inRepo(stub, async (repo) => {
      const runs = new BlameRuns(repo.git.context.storage);
      runs.create(key(1), repo.git.context.now(), new Set());
      runs.create(key(2), repo.git.context.now(), new Set());
      const blame = new RepoBlame({
        git: repo.git,
        storage: repo.git.context.storage as unknown as DurableObjectStorage,
        memoryBlocks: createClockBlockCache(),
        repoId: () => repoId,
        epochGen: () => repo.events.epochGen(),
      });
      blame.restored();
      const queued = repo.git.context.storage.sql
        .exec<{ state: string }>("SELECT state FROM jobs WHERE kind = 'blame_prune'")
        .toArray();
      return { runs: runs.count(), queued: queued.map((j) => j.state) };
    });
    expect(seen).toEqual({ runs: 0, queued: ["queued"] });
  });

  it("takes the checkpoints and runs when the repository is erased", async () => {
    const { stub, repoId } = await pushed();
    const seen = await inRepo(stub, async (repo) => {
      const now = repo.git.context.now();
      await checkpointAt(repo, repoId, now);
      new BlameRuns(repo.git.context.storage).create(key(1), now, new Set());
      let outcome = await eraseRepository(repo.git, env, repoId, undefined);
      for (let k = 0; k < 5 && outcome === "partial"; k++)
        outcome = await eraseRepository(repo.git, env, repoId, undefined);
      return {
        outcome,
        keys: await keysUnder(repo, repoId),
        runs: new BlameRuns(repo.git.context.storage).count(),
      };
    });
    expect(seen).toEqual({ outcome: "erased", keys: [], runs: 0 });
  });
});
