// An erased run's log chunks: purged from R2 by a job its erasure leaves,
// once a write in flight would have landed; in bounded slices; retried
// without end on failure; for a run retired at its retention and for one
// erased with its repository. Then nothing is left but its identity and
// tombstone: no job rows, no alarm.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { countSubrequests } from "@fyrden/adapters-cloudflare/obs";
import { describe, expect, it } from "vitest";
import { RUN_JOB } from "../src/do/run/engine.js";
import { LOG_LATE_MS } from "../src/do/run/logs.js";
import {
  at,
  finish,
  inRun,
  job,
  repoWithCommit,
  runStub,
  started,
  T0,
  workflow,
} from "./helpers/runs.js";

const DAY = 24 * 60 * 60 * 1000;
const RETENTION = 2 * DAY;

async function chunks(runId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i += 100)
    await Promise.all(
      Array.from({ length: Math.min(100, n - i) }, (_, k) =>
        env.CI.put(`runs/${runId}/1/1/1/${String(i + k).padStart(10, "0")}-x.ndjson`, "{}"),
      ),
    );
}

async function count(prefix: string): Promise<number> {
  let n = 0;
  let cursor: string | undefined;
  do {
    const page = await env.CI.list({ prefix, ...(cursor && { cursor }) });
    n += page.objects.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return n;
}

const left = async (runId: string) => ({
  jobs: await inRun(runId, (run) =>
    run.engine
      .rows<{ job_id: string; state: string }>("SELECT job_id, state FROM jobs ORDER BY job_id")
      .map((row) => `${row.job_id}:${row.state}`),
  ),
  alarm: await runInDurableObject(runStub(runId), (_, state) => state.storage.getAlarm()),
});

const alarmAt = (
  runId: string,
  t: number,
  set: (run: Parameters<Parameters<typeof inRun>[1]>[0]) => void = () => {},
) =>
  inRun(runId, async (run) => {
    (run.context as { now: () => number }).now = () => t;
    set(run);
    await run.alarm();
  });

async function erasedRun(n: number) {
  const f = await repoWithCommit();
  const runId = await started(f, workflow(job("build")));
  await finish(runId, "build");
  await chunks(runId, n);
  await at(runId, T0);
  expect(await runStub(runId).erase(f.repo.id)).toBe(true);
  return { f, runId };
}

describe("an erased run's log purge", () => {
  it("waits for a write in flight, then deletes every chunk under the run's prefix only", async () => {
    const { runId } = await erasedRun(3);
    const other = await (async () => {
      const f = await repoWithCommit();
      const id = await started(f, workflow(job("build")));
      await chunks(id, 2);
      return id;
    })();
    expect(await left(runId)).toEqual({
      jobs: [`${RUN_JOB.logPurge}:queued`],
      alarm: T0 + LOG_LATE_MS,
    });
    await alarmAt(runId, T0 + LOG_LATE_MS - 1);
    expect(await count(`runs/${runId}/`)).toBe(3);
    await alarmAt(runId, T0 + LOG_LATE_MS);
    expect(await count(`runs/${runId}/`)).toBe(0);
    expect(await count(`runs/${other}/`)).toBe(2);
    expect(await left(runId)).toEqual({ jobs: [], alarm: null });
  });

  it("purges in bounded slices", async () => {
    const { runId } = await erasedRun(2500);
    // R2 calls by the slice (the job's claim) that made them.
    const bySlice = new Map<number, number>();
    const slice = (run: Parameters<Parameters<typeof inRun>[1]>[0]) => {
      run.logPurgeCalls = 2;
      run.hooks.beforeLogPurgeCall = () => {
        const [row] = run.engine.rows<{ claim: number }>(
          "SELECT claim FROM jobs WHERE job_id = ?",
          RUN_JOB.logPurge,
        );
        const claim = row?.claim ?? -1;
        bySlice.set(claim, (bySlice.get(claim) ?? 0) + 1);
      };
    };
    await alarmAt(runId, T0 + LOG_LATE_MS, slice);
    // One slice is one list and one delete of up to 1,000; the alarm runs slices while due.
    expect(await count(`runs/${runId}/`)).toBe(0);
    expect([...bySlice.values()]).toEqual([2, 2, 2, 1]);
    expect(await left(runId)).toEqual({ jobs: [], alarm: null });
  });

  it("stops at the invocation's call budget, leaving the rest to the next alarm", async () => {
    const { runId } = await erasedRun(2500);
    await alarmAt(runId, T0 + LOG_LATE_MS, (run) => {
      run.logPurgeCalls = 2;
      let spent = false;
      run.hooks.beforeLogPurgeCall = () => {
        // Other work of this invocation took its allowance of internal calls.
        if (!spent) countSubrequests("internal", 1_000_000);
        spent = true;
      };
    });
    expect(await count(`runs/${runId}/`)).toBe(1500);
    expect((await left(runId)).jobs).toEqual([`${RUN_JOB.logPurge}:queued`]);
    await alarmAt(runId, T0 + LOG_LATE_MS, (run) => {
      delete run.hooks.beforeLogPurgeCall;
    });
    expect(await count(`runs/${runId}/`)).toBe(0);
  });

  it("retries a failed slice at the sweep's interval, never giving up", async () => {
    const { runId } = await erasedRun(3);
    const sweep = await inRun(runId, (run) => run.policy.sweepMs);
    for (let i = 0; i < 12; i++)
      await alarmAt(runId, T0 + LOG_LATE_MS + i * sweep, (run) => {
        run.hooks.beforeLogPurgeCall = () => {
          throw new Error("R2 is unavailable");
        };
      });
    expect(await count(`runs/${runId}/`)).toBe(3);
    expect(
      await inRun(runId, (run) =>
        run.engine.rows("SELECT state, attempts FROM jobs WHERE job_id = ?", RUN_JOB.logPurge),
      ),
    ).toEqual([{ state: "queued", attempts: 0 }]);
    await alarmAt(runId, T0 + LOG_LATE_MS + 12 * sweep, (run) => {
      delete run.hooks.beforeLogPurgeCall;
    });
    expect(await count(`runs/${runId}/`)).toBe(0);
    expect(await left(runId)).toEqual({ jobs: [], alarm: null });
  });

  it("purges again when an erased run is erased again, and keeps one purge pending", async () => {
    const { f, runId } = await erasedRun(3);
    expect(await runStub(runId).erase(f.repo.id)).toBe(true);
    expect((await left(runId)).jobs).toEqual([`${RUN_JOB.logPurge}:queued`]);
    await alarmAt(runId, T0 + LOG_LATE_MS);
    expect(await left(runId)).toEqual({ jobs: [], alarm: null });
    // A tombstone whose purge ended (or one from before the purge existed): purged again.
    await chunks(runId, 1);
    expect(await runStub(runId).erase(f.repo.id)).toBe(true);
    expect((await left(runId)).jobs).toEqual([`${RUN_JOB.logPurge}:queued`]);
    await alarmAt(runId, T0 + 2 * LOG_LATE_MS);
    expect(await count(`runs/${runId}/`)).toBe(0);
  });

  it("drops any other job queued on the erased run, so its alarm does not fire again at once", async () => {
    const { runId } = await erasedRun(1);
    await inRun(runId, (run) => {
      run.jobs.ensure("run_sweep", RUN_JOB.sweep, { runAt: T0 });
    });
    await alarmAt(runId, T0 + 1);
    expect(await left(runId)).toEqual({
      jobs: [`${RUN_JOB.logPurge}:queued`],
      alarm: T0 + LOG_LATE_MS,
    });
  });

  it("purges a run retired at its retention, through the retirement seam at once", async () => {
    const f = await repoWithCommit();
    const runId = await started(f, workflow(job("build")));
    await inRun(runId, (run) => {
      run.policy = { ...run.policy, retentionMs: RETENTION };
    });
    await finish(runId, "build");
    await chunks(runId, 5);
    const after = await inRun(runId, (run) => {
      run.policy = { ...run.policy, retentionMs: RETENTION };
      return run.ciReconcileAt(T0 + RETENTION);
    });
    expect(after).toEqual({ erased: true, jobs: [], alarm: null });
    expect(await count(`runs/${runId}/`)).toBe(0);
  });
});
