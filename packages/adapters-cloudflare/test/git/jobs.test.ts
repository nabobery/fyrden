import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  createDoMemoryBudget,
  enqueueReflogPrune,
  JobQueue,
  REFLOG_RETENTION_MS,
  reflogPruneHandler,
} from "../../src/git/index.js";
import type { GitStorageContext } from "../../src/git/sql.js";
import { inProbe, newProbe } from "./harness.js";

const DAY = 24 * 60 * 60 * 1000;
const policy = { leaseMs: 1_000, maxAttempts: 3, backoffMs: 100, memoryRetryMs: 500 };

/** The probe's storage with a clock the test controls. */
function withClock(context: GitStorageContext, clock: { now: number }): GitStorageContext {
  return { ...context, now: () => clock.now };
}

function seedReflog(context: GitStorageContext, old: number, recent: number, now: number) {
  for (let i = 0; i < old + recent; i++) {
    context.storage.sql.exec(
      "INSERT INTO reflog (ref, version, at) VALUES ('refs/heads/main', ?, ?)",
      i + 1,
      i < old ? now - REFLOG_RETENTION_MS - DAY : now - DAY,
    );
  }
}

const countReflog = (context: GitStorageContext) =>
  context.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM reflog").one().n;

describe("JobQueue and the reflog prune job", () => {
  it("prunes in slices, survives eviction mid-job, and keeps recent entries", async () => {
    const { stub } = await newProbe();
    const clock = { now: 10 * REFLOG_RETENTION_MS };
    const first = await inProbe(stub, async ({ git }) => {
      const context = withClock(git.context, clock);
      seedReflog(context, 250, 7, clock.now);
      const alarms: number[] = [];
      const jobs = new JobQueue(context, (at) => alarms.push(at), policy);
      const jobId = enqueueReflogPrune(jobs, clock.now);
      // One slice of 100 rows, then the slice "dies" with the object: its
      // claim (state running, lease) is left behind.
      const handler = reflogPruneHandler(context, 100);
      await jobs.runDue(
        {
          reflog_prune: {
            async runSlice(job) {
              const result = await handler.runSlice(job);
              clock.now += 1; // past the deadline below: no second slice
              return result;
            },
          },
        },
        createDoMemoryBudget(1024),
        clock.now + 1,
      );
      context.storage.sql.exec(
        "UPDATE jobs SET state = 'running', lease_expires_at = ? WHERE job_id = ?",
        clock.now + policy.leaseMs,
        jobId,
      );
      return { jobId, left: countReflog(context), alarms };
    });
    expect(first.left).toBe(257 - 100);
    expect(first.alarms.length).toBeGreaterThan(0);

    await evictDurableObject(stub);

    const second = await inProbe(stub, async ({ git }) => {
      const context = withClock(git.context, clock);
      const jobs = new JobQueue(context, () => {}, policy);
      const handlers = { reflog_prune: reflogPruneHandler(context, 100) };
      const memory = createDoMemoryBudget(1024);
      // The dead slice's lease still holds the job.
      const blocked = await jobs.runDue(handlers, memory, clock.now + 10_000);
      clock.now += policy.leaseMs;
      const slices = await jobs.runDue(handlers, memory, clock.now + 10_000);
      return { blocked, slices, left: countReflog(context), job: jobs.get(first.jobId)?.state };
    });
    expect(second.blocked).toBe(0);
    expect(second.slices).toBe(3); // 100 + 50 rows, then a slice that finds nothing
    expect(second.left).toBe(7);
    expect(second.job).toBe("done");
  });

  it("puts a job back for a later alarm when the memory pool is short", async () => {
    const { stub } = await newProbe();
    const result = await inProbe(stub, async ({ git }) => {
      const clock = { now: 1_000_000 };
      const context = withClock(git.context, clock);
      const alarms: number[] = [];
      const jobs = new JobQueue(context, (at) => alarms.push(at), policy);
      const jobId = jobs.enqueue("compact");
      const memory = createDoMemoryBudget(100);
      const held = memory.tryReserve(80);
      let ran = 0;
      const handlers = {
        compact: {
          memoryBytes: 50,
          async runSlice() {
            ran++;
            return { done: true as const };
          },
        },
      };
      const whileShort = await jobs.runDue(handlers, memory, clock.now + 10_000);
      const nextAlarm = alarms.at(-1);
      held?.release();
      clock.now += policy.memoryRetryMs;
      const afterRelease = await jobs.runDue(handlers, memory, clock.now + 10_000);
      return {
        whileShort,
        nextAlarm,
        afterRelease,
        ran,
        state: jobs.get(jobId),
        free: memory.stats().reservedBytes,
      };
    });
    expect(result.whileShort).toBe(0);
    expect(result.nextAlarm).toBe(1_000_000 + policy.memoryRetryMs);
    expect(result.afterRelease).toBe(1);
    expect(result.ran).toBe(1);
    expect(result.state).toMatchObject({ state: "done", attempts: 0 });
    expect(result.free).toBe(0);
  });

  it("retries a failing slice with backoff and gives up after the last attempt", async () => {
    const { stub } = await newProbe();
    const result = await inProbe(stub, async ({ git }) => {
      const clock = { now: 1_000_000 };
      const context = withClock(git.context, clock);
      const jobs = new JobQueue(context, () => {}, policy);
      const jobId = jobs.enqueue("archive");
      const handlers = {
        archive: {
          async runSlice(): Promise<never> {
            throw new Error("R2 unavailable");
          },
        },
      };
      const memory = createDoMemoryBudget(1024);
      const attempts: (number | undefined)[] = [];
      for (let i = 0; i < 4; i++) {
        await jobs.runDue(handlers, memory, clock.now + 10_000);
        attempts.push(jobs.get(jobId)?.attempts);
        clock.now += 10_000;
      }
      return { attempts, state: jobs.get(jobId)?.state };
    });
    expect(result.attempts).toEqual([1, 2, 2, 2]);
    expect(result.state).toBe("failed");
  });
  it("a slice that checkpoints and then fails is retried from its checkpoint; a taken-over slice cannot checkpoint", async () => {
    const { stub } = await newProbe();
    const result = await inProbe(stub, async ({ git }) => {
      const clock = { now: 1_000_000 };
      const context = withClock(git.context, clock);
      const jobs = new JobQueue(context, () => {}, policy);
      const memory = createDoMemoryBudget(1024);
      const jobId = jobs.enqueue("archive", new Uint8Array([1]));
      const seen: number[] = [];
      const handler = {
        async runSlice(job: Parameters<JobQueue["checkpoint"]>[0]) {
          seen.push(job.cursor?.[0] ?? -1);
          if (job.cursor?.[0] === 1) {
            // The slice's effect and its next cursor commit together, then it fails.
            context.storage.transactionSync(() => {
              if (!jobs.checkpoint(job, new Uint8Array([2]))) throw new Error("taken over");
            });
            throw new Error("cleanup failed");
          }
          return { done: true as const };
        },
      };
      await jobs.runDue({ archive: handler }, memory, clock.now + 10_000);
      const afterFailure = jobs.get(jobId);
      clock.now += 10_000;
      await jobs.runDue({ archive: handler }, memory, clock.now + 10_000);
      // A stale claim checkpoints nothing.
      const stale = jobs.checkpoint(
        { jobId, kind: "archive", cursor: null, attempts: 0, claim: 1 },
        new Uint8Array([9]),
      );
      return { seen, afterFailure, stale, final: jobs.get(jobId) };
    });
    expect(result.seen).toEqual([1, 2]);
    expect(result.afterFailure).toEqual({
      state: "queued",
      attempts: 1,
      cursor: new Uint8Array([2]),
    });
    expect(result.stale).toBe(false);
    expect(result.final?.state).toBe("done");
  });

  it("ignores what a runner records after its claim expired and another run took the job", async () => {
    const { stub } = await newProbe();
    const result = await inProbe(stub, async ({ git }) => {
      const clock = { now: 1_000_000 };
      const context = withClock(git.context, clock);
      const jobs = new JobQueue(context, () => {}, policy);
      const memory = createDoMemoryBudget(1024);
      const outcomes: Record<string, unknown> = {};
      for (const ending of ["checkpoint", "throw"] as const) {
        const jobId = jobs.enqueue("archive", new Uint8Array([0]));
        let started!: () => void;
        const running = new Promise<void>((resolve) => {
          started = resolve;
        });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        // A: claims the job and is still waiting (on R2, say) when its lease ends.
        let aSlices = 0;
        const a = jobs.runJob(
          jobId,
          {
            async runSlice() {
              if (aSlices++ > 0) return { done: true }; // never reached with the claim check
              started();
              await gate;
              if (ending === "throw") throw new Error("A's late failure");
              return { done: false, cursor: new Uint8Array([0xaa]) };
            },
          },
          memory,
          clock.now + 10_000,
        );
        await running;
        clock.now += policy.leaseMs;
        // B: takes the job over and finishes it.
        const b = await jobs.runJob(
          jobId,
          {
            async runSlice(job) {
              return job.cursor?.[0] === 0
                ? { done: false, cursor: new Uint8Array([0xbb]), runAfterMs: 0 }
                : { done: true };
            },
          },
          memory,
          clock.now + 10_000,
        );
        release();
        const late = await a;
        outcomes[ending] = { b, late, job: jobs.get(jobId) };
      }
      return outcomes;
    });
    for (const ending of ["checkpoint", "throw"]) {
      expect(result[ending]).toEqual({
        b: { slices: 2, state: "done" },
        late: { slices: 0, state: "busy" },
        job: { state: "done", attempts: 0, cursor: new Uint8Array([0xbb]) },
      });
    }
  });
  it("starts no slice once the invocation has nearly spent its internal-call budget, and leaves the rest to the alarm", async () => {
    const { stub } = await newProbe();
    const result = await inProbe(stub, async ({ git }) => {
      const clock = { now: 1_000_000 };
      const context = withClock(git.context, clock);
      const alarms: number[] = [];
      // A fake invocation counter: each slice makes 4 internal calls.
      const invocation = { internal: 0 };
      const jobs = new JobQueue(
        context,
        (at) => alarms.push(at),
        { ...policy, maxInternalCalls: 10 },
        () => invocation.internal,
      );
      const memory = createDoMemoryBudget(1024);
      const jobId = jobs.enqueue("archive", new Uint8Array([0]));
      const handler = {
        async runSlice(job: { cursor: Uint8Array | null }) {
          invocation.internal += 4;
          const step = (job.cursor?.[0] ?? 0) + 1;
          return step === 5
            ? { done: true as const }
            : { done: false as const, cursor: new Uint8Array([step]) };
        },
      };
      const due = await jobs.runDue({ archive: handler }, memory, clock.now + 10_000);
      const afterDue = { calls: invocation.internal, job: jobs.get(jobId), alarm: alarms.at(-1) };
      // Already past the budget: runJob starts nothing.
      const spent = await jobs.runJob(jobId, handler, memory, clock.now + 10_000);
      // The alarm is a new invocation with a fresh budget.
      invocation.internal = 0;
      const next = await jobs.runJob(jobId, handler, memory, clock.now + 10_000);
      return { due, afterDue, spent, next, calls: invocation.internal };
    });
    expect(result.due).toBe(3);
    expect(result.afterDue).toEqual({
      calls: 12,
      job: { state: "queued", attempts: 0, cursor: new Uint8Array([3]) },
      alarm: 1_000_000,
    });
    expect(result.spent).toEqual({ slices: 0, state: "queued" });
    expect(result.next).toEqual({ slices: 2, state: "done" });
    expect(result.calls).toBe(8);
  });
});

describe("memory admission and delays", () => {
  it("lets a run whose lease expired keep its claim while the pool is short", async () => {
    const { stub } = await newProbe();
    const result = await inProbe(stub, async ({ git }) => {
      const clock = { now: 1_000_000 };
      const context = withClock(git.context, clock);
      const jobs = new JobQueue(context, () => {}, policy);
      const jobId = jobs.enqueue("compact");
      const memory = createDoMemoryBudget(100);
      // A slice that holds the pool and outlives its lease.
      let release: () => void = () => {};
      let started: () => void = () => {};
      const running = new Promise<void>((resolve) => {
        started = resolve;
      });
      const slow = {
        compact: {
          memoryBytes: 80,
          // The first slice waits to be released; later ones finish the job.
          runSlice: (job: { cursor: Uint8Array | null }) =>
            job.cursor
              ? Promise.resolve({ done: true as const })
              : new Promise<{ done: false; cursor: Uint8Array }>((resolve) => {
                  release = () => resolve({ done: false, cursor: Uint8Array.of(7) });
                  started();
                }),
        },
      };
      const first = jobs.runDue(slow, memory, clock.now + 10_000);
      await running;
      clock.now += policy.leaseMs + 1;
      // Another run finds the lease expired but no memory: it must not take the job.
      const second = await jobs.runDue(slow, memory, clock.now + 10_000);
      release();
      await first;
      return { second, job: jobs.get(jobId) };
    });
    expect(result.second).toBe(0);
    // The first run recorded its slice (its claim was still the job's) and went on to finish it.
    expect(result.job).toMatchObject({ state: "done", cursor: Uint8Array.of(7), attempts: 0 });
  });

  it("does not run a slice that asked to go on later again in the same run", async () => {
    const { stub } = await newProbe();
    const slices = await inProbe(stub, async ({ git }) => {
      const jobs = new JobQueue(git.context, () => {}, policy);
      const jobId = jobs.enqueue("compact");
      let runs = 0;
      const outcome = await jobs.runJob(
        jobId,
        {
          async runSlice() {
            runs++;
            return { done: false as const, cursor: null, runAfterMs: 60_000 };
          },
        },
        createDoMemoryBudget(100),
        Date.now() + 10_000,
      );
      return { runs, outcome };
    });
    expect(slices.runs).toBe(1);
    expect(slices.outcome).toMatchObject({ slices: 1, state: "queued" });
  });
});

describe("a claim that fails", () => {
  it("gives the slice's memory back, in runDue and in runJob", async () => {
    const { stub } = await newProbe();
    const reserved = await inProbe(stub, async ({ git }) => {
      // Storage whose next transaction (the claim) throws once.
      let failNext = false;
      const storage = new Proxy(git.context.storage, {
        get(target, property) {
          if (property !== "transactionSync") {
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return <T>(fn: () => T): T => {
            if (failNext) {
              failNext = false;
              throw new Error("the claim failed");
            }
            return target.transactionSync(fn);
          };
        },
      });
      const jobs = new JobQueue({ ...git.context, storage }, () => {}, policy);
      const memory = createDoMemoryBudget(100);
      const handlers = {
        compact: { memoryBytes: 60, runSlice: async () => ({ done: true as const }) },
      };
      const jobId = jobs.enqueue("compact");
      failNext = true;
      await expect(jobs.runDue(handlers, memory, Date.now() + 10_000)).rejects.toThrow(
        "the claim failed",
      );
      const afterDue = memory.stats().reservedBytes;
      failNext = true;
      await expect(
        jobs.runJob(jobId, handlers.compact, memory, Date.now() + 10_000),
      ).rejects.toThrow("the claim failed");
      const afterJob = memory.stats().reservedBytes;
      // And the job still runs once claims work again.
      const ran = await jobs.runJob(jobId, handlers.compact, memory, Date.now() + 10_000);
      return { afterDue, afterJob, ran };
    });
    expect(reserved).toEqual({ afterDue: 0, afterJob: 0, ran: { slices: 1, state: "done" } });
  });
});
