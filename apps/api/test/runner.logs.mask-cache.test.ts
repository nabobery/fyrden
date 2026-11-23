// A task's log-mask matchers kept between log requests: the next request
// reuses them, extends them with a value an earlier request stored, or
// builds them again after a reset or eviction, and stores the same text
// either way. They hold a reservation from the run's memory pool within a
// cap, give way to a request that needs the room, and go when the task's
// masks go: a final store, the close job, an erasure.
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MASK_HEADROOM_BYTES } from "../src/do/run/logs.js";
import type { MaskCacheOutcome } from "../src/do/run/mask-cache.js";
import { type LogRow, Result } from "../src/runner/proto/messages.js";
import { decodeUpdateLogResponse, encodeUpdateLogRequest } from "./helpers/runner-proto.js";
import {
  type Credentials,
  fetchTask,
  gate,
  jobTokenOf,
  orgRepo,
  pendingOf,
  proto,
  registerRunner,
  runnerCall,
  taskRow,
  tasksVersionOf,
  updateTask,
} from "./helpers/runners.js";
import { at, drain, inRun, job, now, runStub, started, T0, workflow } from "./helpers/runs.js";

const MIN = 60_000;
const LATE_MS = 10 * MIN;

/** A run of `jobs` jobs in a new organization, a runner holding each job's task. */
async function withTasks(jobs = 1) {
  const f = await orgRepo();
  const names = Array.from({ length: jobs }, (_, k) => String.fromCharCode(0x61 + k));
  const runId = await started(f, workflow(names.map((name) => job(name)).join("\n")));
  const tasks = [];
  for (let k = 0; k < jobs; k++) {
    const runner = await registerRunner(f.org.login, f.owner);
    const task = (await fetchTask(runner, 0)).task;
    if (!task) throw new Error(`no task ${k}`);
    const number = (await taskRow(task.id))?.task;
    if (typeof number !== "number") throw new Error("the task was not recorded");
    // Running: the next runner's poll takes the next job.
    await updateTask(runner, task.id);
    tasks.push({ runner, task, number, token: jobTokenOf(task) });
  }
  return { f, runId, tasks };
}

async function withTask() {
  const { f, runId, tasks } = await withTasks(1);
  return { f, runId, ...(tasks[0] as (typeof tasks)[number]) };
}

const row = (content: string): LogRow => ({ content });
const filler = (from: number, n: number): LogRow[] =>
  Array.from({ length: n }, (_, k) => row(`line ${from + k}`));

type LogRequest = { taskId: number; index: number; rows?: LogRow[]; noMore?: boolean };

const sendLog = (runner: Credentials, request: LogRequest) =>
  runnerCall("UpdateLog", encodeUpdateLogRequest(request), { credentials: runner });

async function ackOf(runner: Credentials, request: LogRequest): Promise<number> {
  return decodeUpdateLogResponse(await proto(await sendLog(runner, request))).ackIndex;
}

/** Every stored line's text, in order. */
async function contents(runId: string, task: number): Promise<string[]> {
  const keys = await inRun(runId, (r) =>
    r.engine
      .rows<{ r2_key: string }>(
        "SELECT r2_key FROM ci_log_chunks WHERE task = ? ORDER BY start_index",
        task,
      )
      .map((c) => c.r2_key),
  );
  const lines: string[] = [];
  for (const key of keys) {
    const text = (await (await env.CI.get(key))?.text()) ?? "";
    for (const line of text.split("\n")) {
      if (line === "") continue;
      const parsed = JSON.parse(line) as { c?: string };
      lines.push(parsed.c ?? "<omitted>");
    }
  }
  return lines;
}

/** Records what each log request's masking did with the kept matchers, from now on. */
async function outcomes(runId: string): Promise<MaskCacheOutcome[]> {
  const seen: MaskCacheOutcome[] = [];
  await inRun(runId, (r) => {
    r.hooks = { ...r.hooks, maskMatcher: (_task, outcome) => seen.push(outcome) };
  });
  return seen;
}

/** The kept matchers' estimate and the pool's reservations, with no request in progress. */
const held = (runId: string) =>
  inRun(runId, (r) => ({
    cache: r.maskCacheBytesHeld(),
    reserved: r.memory.stats().reservedBytes,
    total: r.memory.stats().totalBytes,
  }));

async function reset(runId: string) {
  await evictDurableObject(runStub(runId));
  await at(runId, now(runId));
}

describe("kept log-mask matchers", () => {
  it("are reused by the task's next request, which stores the same text", async () => {
    const { runId, runner, task, number, token } = await withTask();
    const seen = await outcomes(runId);
    expect(
      await ackOf(runner, {
        taskId: task.id,
        index: 0,
        rows: [row(`a ${token}`), ...filler(1, 49)],
      }),
    ).toBe(50);
    const first = await held(runId);
    expect(first.cache).toBeGreaterThan(0);
    // With no request in progress, the pool holds only the kept matchers.
    expect(first.reserved).toBe(first.cache);
    expect(
      await ackOf(runner, {
        taskId: task.id,
        index: 50,
        rows: [row(`b ${token}`), ...filler(51, 49)],
      }),
    ).toBe(100);
    expect(seen).toEqual(["built", "hit"]);
    const lines = await contents(runId, number);
    expect(lines[0]).toBe("a ***");
    expect(lines[50]).toBe("b ***");
    expect((await held(runId)).cache).toBe(first.cache);
  });

  it("are extended with a value an earlier request registered", async () => {
    const { runId, runner, task, number } = await withTask();
    const seen = await outcomes(runId);
    const value = "hunter2-kept-matcher-value";
    expect(
      await ackOf(runner, {
        taskId: task.id,
        index: 0,
        rows: [row(`::add-mask::${value}`), ...filler(1, 49)],
      }),
    ).toBe(50);
    const before = (await held(runId)).cache;
    expect(
      await ackOf(runner, {
        taskId: task.id,
        index: 50,
        rows: [row(`x ${value} y`), ...filler(51, 49)],
      }),
    ).toBe(100);
    expect(seen).toEqual(["built", "extended"]);
    expect((await contents(runId, number))[50]).toBe("x *** y");
    expect((await held(runId)).cache).toBeGreaterThan(before);
  });

  it("stay within the cap, least recently used evicted first, each reserved from the pool", async () => {
    const { runId, tasks } = await withTasks(3);
    const [a, b, c] = tasks as [(typeof tasks)[0], (typeof tasks)[0], (typeof tasks)[0]];
    const seen = await outcomes(runId);
    const send = (t: typeof a, index: number) =>
      ackOf(t.runner, {
        taskId: t.task.id,
        index,
        rows: [row(`v ${t.token}`), ...filler(index + 1, 49)],
      });
    expect(await send(a, 0)).toBe(50);
    const one = (await held(runId)).cache;
    // Room for two tasks' matchers (each task's are the same size: one token each).
    const cap = Math.floor(2.5 * one);
    await inRun(runId, (r) => {
      r.maskCacheBytes = cap;
    });
    expect(await send(b, 0)).toBe(50);
    expect(await send(c, 0)).toBe(50);
    let state = await held(runId);
    expect(state.cache).toBe(2 * one);
    expect(state.cache).toBeLessThanOrEqual(cap);
    expect(state.reserved).toBe(state.cache);
    // `a` was the least recently used: built again, evicting `b`; `c` is still kept.
    expect(await send(a, 50)).toBe(100);
    expect(await send(c, 50)).toBe(100);
    // `c`'s hit made `a` the least recently used: `b` evicts `a`, not `c`, which was kept first.
    expect(await send(b, 50)).toBe(100);
    expect(await send(c, 100)).toBe(150);
    expect(seen).toEqual(["built", "built", "built", "built", "hit", "built", "hit"]);
    state = await held(runId);
    expect(state.cache).toBeLessThanOrEqual(cap);
    expect(state.reserved).toBe(state.cache);
    for (const t of tasks) expect((await contents(runId, t.number))[50]).toBe("v ***");
  });

  it("report the first pass's outcome when a store masks the rows again, forced", async () => {
    const { runId, runner, task, number, token } = await withTask();
    const seen = await outcomes(runId);
    // A partial match over more rows than may be held: the store masks it, forced.
    const partial = token.slice(0, 16).split("").map(row);
    const rows = [...filler(0, 50 - partial.length), ...partial];
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows })).toBe(50);
    expect(seen).toEqual(["built"]);
    // The 13 rows held as a partial match are masked whole.
    expect((await contents(runId, number)).slice(37)).toEqual(Array(13).fill("***"));
  });

  for (const lose of [false, true]) {
    it(`mask a token split across two requests the same ${lose ? "after a reset, building again" : "when kept"}`, async () => {
      const { runId, runner, task, number, token } = await withTask();
      const head = row(`pre ${token.slice(0, 12)}`);
      // The partial match of 12 chars holds its row: the ack stops before it.
      expect(
        await ackOf(runner, { taskId: task.id, index: 0, rows: [...filler(0, 49), head] }),
      ).toBe(49);
      if (lose) {
        await reset(runId);
        expect((await held(runId)).cache).toBe(0);
      }
      const seen = await outcomes(runId);
      const rows = [head, row(`${token.slice(12)} post`), ...filler(51, 48)];
      expect(await ackOf(runner, { taskId: task.id, index: 49, rows })).toBe(99);
      expect(seen).toEqual([lose ? "built" : "hit"]);
      const lines = await contents(runId, number);
      expect(lines.slice(49, 51)).toEqual(["pre ***", "*** post"]);
    });
  }

  it("give way to a request that needs their room", async () => {
    const { runId, runner, task, number, token } = await withTask();
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: filler(0, 50) })).toBe(50);
    const kept = await held(runId);
    expect(kept.cache).toBeGreaterThan(0);
    const request = { taskId: task.id, index: 50, rows: [row(`z ${token}`), ...filler(51, 49)] };
    const trust = await inRun(
      runId,
      (r) => r.engine.rows<{ trust: string }>("SELECT trust FROM runs")[0]?.trust,
    );
    const headroom =
      trust === "trusted" ? MASK_HEADROOM_BYTES.trusted : MASK_HEADROOM_BYTES.untrusted;
    const need = 4 * encodeUpdateLogRequest(request).byteLength + headroom;
    // The request fits only once the kept matchers are dropped (half their size of slack
    // either way for framing the body does not count).
    const filled = kept.total - kept.reserved - need + Math.floor(kept.cache / 2);
    const seen = await outcomes(runId);
    await inRun(runId, (r) => {
      const hold = r.memory.tryReserve(filled);
      if (!hold) throw new Error("the pool did not take the filler");
      (globalThis as { maskCacheFiller?: { release(): void } }).maskCacheFiller = hold;
    });
    try {
      expect(await ackOf(runner, request)).toBe(100);
      // The request's own matchers did not fit beside it: nothing is kept.
      expect(seen).toEqual(["uncached"]);
      expect((await held(runId)).cache).toBe(0);
      expect((await contents(runId, number))[50]).toBe("z ***");
    } finally {
      await inRun(runId, () => {
        (globalThis as { maskCacheFiller?: { release(): void } }).maskCacheFiller?.release();
      });
    }
    expect((await held(runId)).reserved).toBe(0);
  });

  it("go when a final request completes the log", async () => {
    const { runId, runner, task } = await withTask();
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: filler(0, 50) })).toBe(50);
    expect((await held(runId)).cache).toBeGreaterThan(0);
    expect(
      await ackOf(runner, { taskId: task.id, index: 50, rows: filler(50, 10), noMore: true }),
    ).toBe(60);
    expect(await held(runId)).toMatchObject({ cache: 0, reserved: 0 });
  });

  it("go when a final request seals a log with an omitted row", async () => {
    const { runId, runner, task, number } = await withTask();
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: filler(0, 50) })).toBe(50);
    expect(
      await ackOf(runner, { taskId: task.id, index: 50, rows: [row("x".repeat(4 * 1024 * 1024))] }),
    ).toBe(51);
    expect(await ackOf(runner, { taskId: task.id, index: 51, rows: filler(51, 50) })).toBe(101);
    expect((await held(runId)).cache).toBeGreaterThan(0);
    expect(
      await ackOf(runner, { taskId: task.id, index: 101, rows: filler(101, 5), noMore: true }),
    ).toBe(106);
    const state = await inRun(
      runId,
      (r) =>
        r.engine.rows<{ state: string; finalized: number }>(
          "SELECT state, finalized FROM ci_logs WHERE task = ?",
          number,
        )[0],
    );
    expect(state).toEqual({ state: "incomplete", finalized: 1 });
    expect(await held(runId)).toMatchObject({ cache: 0, reserved: 0 });
  });

  it("go when the close job deletes an incomplete log's masks", async () => {
    const { runId, runner, task } = await withTask();
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: filler(0, 50) })).toBe(50);
    await at(runId, T0 + MIN);
    await updateTask(runner, task.id, Result.SUCCESS);
    expect((await held(runId)).cache).toBeGreaterThan(0);
    await at(runId, T0 + MIN + LATE_MS);
    expect(await runDurableObjectAlarm(runStub(runId))).toBe(true);
    expect(await held(runId)).toMatchObject({ cache: 0, reserved: 0 });
  });

  it("go when the close job visits a closed log with no masks to delete", async () => {
    const { runId, runner, task, number } = await withTask();
    await inRun(runId, (r) => r.engine.exec("DELETE FROM ci_log_masks WHERE task = ?", number));
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: filler(0, 50) })).toBe(50);
    await at(runId, T0 + MIN);
    await updateTask(runner, task.id, Result.SUCCESS);
    expect((await held(runId)).cache).toBeGreaterThan(0);
    await at(runId, T0 + MIN + LATE_MS);
    expect(await runDurableObjectAlarm(runStub(runId))).toBe(true);
    expect(await held(runId)).toMatchObject({ cache: 0, reserved: 0 });
  });

  it("go when the run is erased", async () => {
    const { f, runId, runner, task } = await withTask();
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: filler(0, 50) })).toBe(50);
    expect((await held(runId)).cache).toBeGreaterThan(0);
    await runStub(runId).erase(f.repo.id);
    expect(await held(runId)).toMatchObject({ cache: 0, reserved: 0 });
  });

  it("are not kept by a request whose run is erased while its masks open", async () => {
    const { f, runId, runner, task } = await withTask();
    const opening = gate();
    await inRun(runId, (r) => {
      r.hooks = { beforeLogMasksOpen: () => opening.hold() };
    });
    // Read in the chain that sent it: the test resumes inside the run object after the gate.
    const answer = sendLog(runner, { taskId: task.id, index: 0, rows: filler(0, 50) }).then(
      async (res) => ({ status: res.status, body: await res.json<{ code: string }>() }),
    );
    await opening.started;
    await runStub(runId).erase(f.repo.id);
    opening.release();
    expect(await answer).toMatchObject({ status: 404, body: { code: "not_found" } });
    expect(await held(runId)).toMatchObject({ cache: 0, reserved: 0 });
  });

  it("are not kept by a request whose log closes while its masks open", async () => {
    const { runId, runner, task } = await withTask();
    await at(runId, T0 + MIN);
    await updateTask(runner, task.id, Result.SUCCESS);
    await at(runId, T0 + MIN + LATE_MS - 1);
    const opening = gate();
    const seen = await outcomes(runId);
    await inRun(runId, (r) => {
      r.hooks = { ...r.hooks, beforeLogMasksOpen: () => opening.hold() };
    });
    // Read in the chain that sent it: the test resumes inside the run object after the gate.
    const answer = sendLog(runner, { taskId: task.id, index: 0, rows: filler(0, 50) }).then(
      async (res) => ({ status: res.status, body: await res.json<{ code: string }>() }),
    );
    await opening.started;
    // The late window ends and the close job deletes the masks while the request waits.
    await at(runId, T0 + MIN + LATE_MS);
    await drain(runId);
    opening.release();
    expect(await answer).toMatchObject({ status: 404, body: { code: "not_found" } });
    expect(seen).toEqual(["uncached"]);
    expect(await held(runId)).toMatchObject({ cache: 0, reserved: 0 });
  });

  it("resume a carry into a value stored after two tokens, kept or built again", async () => {
    const run = async (lose: boolean) => {
      const f = await orgRepo();
      const runner = await registerRunner(f.org.login, f.owner);
      // A first run cancelled, so the poll version the second run's task is offered at is known.
      const primer = await started(f, workflow(job("a")));
      await runStub(primer).cancel(f.owner.principalId, "graceful");
      await drain(primer);
      expect(await pendingOf(primer)).toEqual([]);
      const version = await tasksVersionOf(f.org.id);
      const runId = await started(f, workflow(job("a")));
      const lost = (await fetchTask(runner, version)).task;
      if (!lost) throw new Error("no task");
      // Its answer was lost: the task is offered again with a second token.
      const again = (await fetchTask(runner, version)).task;
      if (again?.id !== lost.id) throw new Error("the task was not offered again");
      const number = (await taskRow(lost.id))?.task as number;
      const value = "qwertyuiop-kept-secret";
      // The rows end 3 chars into the value: the carry at the ack names it.
      const first = [
        row(`::add-mask::${value}`),
        ...filler(1, 48),
        row(`tail ${value.slice(0, 3)}`),
      ];
      expect(await ackOf(runner, { taskId: again.id, index: 0, rows: first })).toBe(50);
      if (lose) await reset(runId);
      const seen = await outcomes(runId);
      const rows = [
        row(`${value.slice(3)} done`),
        row(`${jobTokenOf(lost)} ${jobTokenOf(again)}`),
        ...filler(52, 48),
      ];
      expect(await ackOf(runner, { taskId: again.id, index: 50, rows })).toBe(100);
      return { seen, lines: (await contents(runId, number)).slice(49, 52) };
    };
    const kept = await run(false);
    const rebuilt = await run(true);
    expect(kept.seen).toEqual(["extended"]);
    expect(rebuilt.seen).toEqual(["built"]);
    expect(kept.lines).toEqual(rebuilt.lines);
    expect(kept.lines).toEqual(["tail qwe", "*** done", "*** ***"]);
  });
});
