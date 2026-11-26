// UpdateLog: a runner's log rows. The Worker reads at most 4 MiB and routes
// by the task id it scans; the task's run decodes the rows, stores the new
// ones as one NDJSON object in R2 named in its manifest, and acks only what
// is stored. The runner keeps and resends every row past its ack, so rows
// that are not stored yet are never lost: a held request, a busy task, a
// full memory pool or a reset only means the runner sends them again. A row
// too large for any request is the one exception: proven so, it is stored as
// an omission record, and the log after it keeps flowing but never completes.
import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { LOG_ROW_TOO_LARGE } from "@fyrden/domain/ci";
import { describe, expect, it } from "vitest";
import type { RunDO } from "../src/do/RunDO.js";
import { UPDATE_LOG_PREFIX_BYTES } from "../src/runner/connect.js";
import { type LogRow, Result } from "../src/runner/proto/messages.js";
import { Writer } from "../src/runner/proto/wire.js";
import {
  decodeUpdateLogResponse,
  encodeLogRow,
  encodeUpdateLogRequest,
} from "./helpers/runner-proto.js";
import {
  type Credentials,
  connectError,
  fetchTask,
  jobTokenOf,
  orgRepo,
  proto,
  registerRunner,
  runnerCall,
  taskRow,
  tasksOfRun,
  updateTask,
} from "./helpers/runners.js";
import { at, drain, inRun, job, now, runStub, started, T0, workflow } from "./helpers/runs.js";
import { logs } from "./setup/log-capture.js";

const one = workflow(job("a"));
const two = workflow([job("a"), job("b")].join("\n"));
const KiB = 1024;
const MiB = 1024 * KiB;

async function withTask(source = one) {
  const f = await orgRepo();
  const runId = await started(f, source);
  const runner = await registerRunner(f.org.login, f.owner);
  const task = (await fetchTask(runner, 0)).task;
  if (!task) throw new Error("no task");
  const number = (await taskRow(task.id))?.task;
  if (typeof number !== "number") throw new Error("the task was not recorded");
  return { f, runId, runner, task, number };
}

const rowsAt = (from: number, n: number, content = (i: number) => `line ${i}`): LogRow[] =>
  Array.from({ length: n }, (_, k) => ({
    time: { seconds: 1_900_000_000 + from + k, nanos: 250_000_000 },
    content: content(from + k),
  }));

function sendLog(
  runner: Credentials,
  request: { taskId: number; index: number; rows?: LogRow[]; noMore?: boolean },
) {
  return runnerCall("UpdateLog", encodeUpdateLogRequest(request), { credentials: runner });
}

async function ackOf(
  runner: Credentials,
  request: { taskId: number; index: number; rows?: LogRow[]; noMore?: boolean },
): Promise<number> {
  return decodeUpdateLogResponse(await proto(await sendLog(runner, request))).ackIndex;
}

const ackOfRaw = async (res: Response) => decodeUpdateLogResponse(await proto(res)).ackIndex;

interface LogState {
  task: number;
  ack_index: number;
  state: string;
  rows: number;
  bytes: number;
  omitted_rows: number;
}

interface Chunk {
  task: number;
  start_index: number;
  end_index: number;
  bytes: number;
  r2_key: string;
}

const logOf = (runId: string, task: number) =>
  inRun(
    runId,
    (r) =>
      r.engine.rows<LogState>(
        "SELECT task, ack_index, state, rows, bytes, omitted_rows FROM ci_logs WHERE task = ?",
        task,
      )[0],
  );

const chunksOf = (runId: string, task: number) =>
  inRun(runId, (r) =>
    r.engine.rows<Chunk>(
      "SELECT task, start_index, end_index, bytes, r2_key FROM ci_log_chunks WHERE task = ? ORDER BY start_index",
      task,
    ),
  );

async function objectsOf(runId: string, task: number): Promise<string[]> {
  const listed = await env.CI.list({ prefix: `runs/${runId}/` });
  return listed.objects.map((o) => o.key).filter((key) => key.split("/")[4] === String(task));
}

interface Line {
  i: number;
  t?: number | null;
  c?: string;
  omitted?: string;
  bytes?: number;
}

async function storedLines(runId: string, task: number): Promise<Line[]> {
  const lines: Line[] = [];
  let next = 0;
  for (const chunk of await chunksOf(runId, task)) {
    expect(chunk.start_index).toBe(next);
    const object = await env.CI.get(chunk.r2_key);
    if (!object) throw new Error(`the manifest names ${chunk.r2_key}, which is not stored`);
    const text = await object.text();
    expect(new TextEncoder().encode(text).length).toBe(chunk.bytes);
    const parsed = text
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Line);
    lines.push(...parsed);
    next = chunk.end_index;
  }
  return lines;
}

const instanceLog = (runId: string, task: number) =>
  inRun(
    runId,
    (r) =>
      r.engine.rows<{
        status: string;
        conclusion: string | null;
        log_complete: number | null;
        heartbeat_at: number | null;
      }>(
        "SELECT status, conclusion, log_complete, heartbeat_at FROM run_instances WHERE task = ?",
        task,
      )[0],
  );

/** Sets the run's log hooks for the rest of the object's life (an eviction clears them). */
const hook = (runId: string, set: (run: RunDO) => RunDO["hooks"]) =>
  inRun(runId, (r) => {
    r.hooks = set(r);
  });

async function reset(runId: string) {
  await evictDurableObject(runStub(runId));
  await at(runId, now(runId));
}

function gate() {
  let reached!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    started,
    release,
    hold: async () => {
      reached();
      await released;
    },
  };
}

describe("UpdateLog", () => {
  it("holds fewer than 50 new rows: the ack stays, nothing is stored", async () => {
    const { runId, runner, task, number } = await withTask();
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: rowsAt(0, 49) })).toBe(0);
    expect(await objectsOf(runId, number)).toEqual([]);
    expect(await chunksOf(runId, number)).toEqual([]);
  });

  it("stores 50 new rows at once as one chunk named by its range, one line per row", async () => {
    const { runId, runner, task, number } = await withTask();
    const rows = rowsAt(0, 50);
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows })).toBe(50);
    const [chunk] = await chunksOf(runId, number);
    const jobId = (await taskRow(task.id))?.job_id;
    expect(chunk?.r2_key).toMatch(
      new RegExp(
        `^runs/${runId}/1/${jobId}/${number}/0000000000-0000000050-[0-9a-f]{32}\\.ndjson$`,
      ),
    );
    expect(await objectsOf(runId, number)).toEqual([chunk?.r2_key]);
    const lines = await storedLines(runId, number);
    expect(lines).toEqual(
      rows.map((row, i) => ({ i, t: (1_900_000_000 + i) * 1000 + 250, c: row.content })),
    );
    expect(await logOf(runId, number)).toMatchObject({
      ack_index: 50,
      state: "streaming",
      rows: 50,
      bytes: chunk?.bytes,
    });
  });

  it("stores only the rows past the ack from a resend, at the positions they were sent at", async () => {
    const { runId, runner, task, number } = await withTask();
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: rowsAt(0, 50) })).toBe(50);
    // A resend after a lost answer: rows 30..99, of which 50..99 are new.
    expect(await ackOf(runner, { taskId: task.id, index: 30, rows: rowsAt(30, 70) })).toBe(100);
    const chunks = await chunksOf(runId, number);
    expect(chunks.map((c) => [c.start_index, c.end_index])).toEqual([
      [0, 50],
      [50, 100],
    ]);
    // Content may repeat; positions never do.
    const lines = await storedLines(runId, number);
    expect(lines.map((l) => l.i)).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(lines.map((l) => l.c)).toEqual(rowsAt(0, 100).map((r) => r.content));
  });

  it("stores rows held 15 s from when the first of them was seen", async () => {
    const { runId, runner, task, number } = await withTask();
    await at(runId, T0 + 1_000);
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: rowsAt(0, 3) })).toBe(0);
    await at(runId, T0 + 1_000 + 14_999);
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: rowsAt(0, 3) })).toBe(0);
    await at(runId, T0 + 1_000 + 15_000);
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: rowsAt(0, 4) })).toBe(4);
    expect((await storedLines(runId, number)).map((l) => l.i)).toEqual([0, 1, 2, 3]);
  });

  it("rows held when the object resets are stored from the runner's resend", async () => {
    const { runId, runner, task, number } = await withTask();
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: rowsAt(0, 10) })).toBe(0);
    await reset(runId);
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: rowsAt(0, 60) })).toBe(60);
    expect((await storedLines(runId, number)).map((l) => l.i)).toEqual(
      Array.from({ length: 60 }, (_, i) => i),
    );
  });

  it("answers a request for a task whose previous request is in progress with the stored ack, before decoding it", async () => {
    const { runId, runner, task, number } = await withTask();
    const held = gate();
    await hook(runId, () => ({ beforeLogStore: () => held.hold() }));
    // Read where it is answered: the test continues in the object's context once the hook is reached.
    const first = sendLog(runner, { taskId: task.id, index: 0, rows: rowsAt(0, 50) }).then(
      ackOfRaw,
    );
    await held.started;
    // A row that does not decode: an answer other than the stored ack would mean it was read.
    const unreadable = new Writer()
      .uint64(1, task.id)
      .message(3, new Uint8Array([0x12, 0x01, 0xff]))
      .finish();
    expect(await ackOfRaw(await runnerCall("UpdateLog", unreadable, { credentials: runner }))).toBe(
      0,
    );
    held.release();
    expect(await first).toBe(50);
    expect((await chunksOf(runId, number)).length).toBe(1);
  });

  it("a flush that loses the manifest to an equal range deletes only its own object", async () => {
    const { runId, runner, task, number } = await withTask();
    let winner = "";
    await hook(runId, (r) => ({
      afterLogPut: async (key: string) => {
        // Another flush of the same rows commits first, under its own key.
        winner = key.replace(/-[0-9a-f]{32}\.ndjson$/, `-${"0".repeat(32)}.ndjson`);
        const object = await env.CI.get(key);
        await env.CI.put(winner, (await object?.text()) ?? "");
        r.engine.exec(
          `INSERT INTO ci_log_chunks (task, start_index, end_index, bytes, r2_key, created_at)
           VALUES (?, 0, 50, ?, ?, 0)`,
          number,
          object?.size ?? 0,
          winner,
        );
        r.engine.exec(
          `INSERT INTO ci_logs (task, ack_index, rows, bytes, updated_at) VALUES (?, 50, 50, ?, 0)
           ON CONFLICT (task) DO UPDATE SET ack_index = 50, rows = 50, bytes = excluded.bytes`,
          number,
          object?.size ?? 0,
        );
      },
    }));
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: rowsAt(0, 50) })).toBe(50);
    expect(await objectsOf(runId, number)).toEqual([winner]);
    const chunks = await chunksOf(runId, number);
    expect(chunks.map((c) => c.r2_key)).toEqual([winner]);
    expect((await storedLines(runId, number)).length).toBe(50);
  });

  it("with the memory pool taken, answers another task's request with its stored ack at once and drops it", async () => {
    const f = await orgRepo();
    const runId = await started(f, two);
    const a = await registerRunner(f.org.login, f.owner);
    const b = await registerRunner(f.org.login, f.owner);
    const taskA = (await fetchTask(a, 0)).task;
    const taskB = (await fetchTask(b, 0)).task;
    if (!taskA || !taskB) throw new Error("no tasks");
    const numberB = (await taskRow(taskB.id))?.task as number;
    // 60 rows of 64 KiB: just under 4 MiB, so a request reserves about 15.7 MiB and its 1 MiB
    // mask headroom of the 17.
    const big = (from: number) => rowsAt(from, 60, (i) => `${i}`.padEnd(64 * KiB, "x"));
    const held = gate();
    await hook(runId, () => ({ beforeLogStore: () => held.hold() }));
    const first = sendLog(a, { taskId: taskA.id, index: 0, rows: big(0) }).then(ackOfRaw);
    await held.started;
    // Kept mask matchers aside: a request that needs their room drops them.
    const pool = (r: RunDO) => ({
      ...r.memory.stats(),
      reservedBytes: r.memory.stats().reservedBytes - r.maskCacheBytesHeld(),
    });
    const during = await inRun(runId, pool);
    expect(during.reservedBytes).toBeGreaterThan(11 * MiB);
    expect(await ackOf(b, { taskId: taskB.id, index: 0, rows: big(0) })).toBe(0);
    const refused = await inRun(runId, pool);
    // Retained input stays within the pool: the refused body reserved nothing.
    expect(refused.reservedBytes).toBe(during.reservedBytes);
    expect(refused.peakBytes).toBeLessThanOrEqual(17 * MiB);
    expect(await objectsOf(runId, numberB)).toEqual([]);
    held.release();
    expect(await first).toBe(60);
    await hook(runId, () => ({}));
    expect((await inRun(runId, pool)).reservedBytes).toBe(0);
    // The runner resends, and now there is room.
    expect(await ackOf(b, { taskId: taskB.id, index: 0, rows: big(0) })).toBe(60);
    expect((await storedLines(runId, numberB)).length).toBe(60);
  });

  it("refuses a request starting past the stored rows, and logs it as a broken invariant", async () => {
    const { runner, task } = await withTask();
    await connectError(
      await sendLog(runner, { taskId: task.id, index: 5, rows: rowsAt(5, 1) }),
      "invalid_argument",
      400,
    );
    expect(logs.lines.some((l) => l.includes("log index ahead of stored rows"))).toBe(true);
  });
});

describe("the final UpdateLog", () => {
  it("of 10,000 rows completes the log", async () => {
    const { runId, runner, task, number } = await withTask();
    const rows = rowsAt(0, 10_000, (i) => `${i}`);
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows, noMore: true })).toBe(10_000);
    expect(await logOf(runId, number)).toMatchObject({ ack_index: 10_000, state: "complete" });
    expect((await storedLines(runId, number)).length).toBe(10_000);
  });

  it("of 10,001 rows stores 10,000 and stays streaming until the resend of the last", async () => {
    const { runId, runner, task, number } = await withTask();
    const rows = rowsAt(0, 10_001, (i) => `${i}`);
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows, noMore: true })).toBe(10_000);
    expect(await logOf(runId, number)).toMatchObject({ ack_index: 10_000, state: "streaming" });
    expect(
      await ackOf(runner, {
        taskId: task.id,
        index: 10_000,
        rows: rows.slice(10_000),
        noMore: true,
      }),
    ).toBe(10_001);
    expect(await logOf(runId, number)).toMatchObject({ ack_index: 10_001, state: "complete" });
    expect((await storedLines(runId, number)).map((l) => l.i)).toEqual(
      Array.from({ length: 10_001 }, (_, i) => i),
    );
  });

  it("of 10,001 rows with no_more written before them is not final either", async () => {
    const { runId, runner, task, number } = await withTask();
    const w = new Writer().uint64(1, task.id).bool(4, true);
    for (const row of rowsAt(0, 10_001, (i) => `${i}`)) w.message(3, encodeLogRow(row));
    expect(await ackOfRaw(await runnerCall("UpdateLog", w.finish(), { credentials: runner }))).toBe(
      10_000,
    );
    expect(await logOf(runId, number)).toMatchObject({ ack_index: 10_000, state: "streaming" });
  });

  it("with no rows (the newer runner) completes the log at the ack sent", async () => {
    const { runId, runner, task, number } = await withTask();
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: rowsAt(0, 50) })).toBe(50);
    expect(await ackOf(runner, { taskId: task.id, index: 50, rows: [], noMore: true })).toBe(50);
    expect(await logOf(runId, number)).toMatchObject({ ack_index: 50, state: "complete" });
    expect((await chunksOf(runId, number)).length).toBe(1);
    await updateTask(runner, task.id, Result.SUCCESS);
    expect(await instanceLog(runId, number)).toMatchObject({
      status: "completed",
      log_complete: 1,
    });
  });

  it("with the older runner's empty sentinel row acks it without storing a line", async () => {
    const { runId, runner, task, number } = await withTask();
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: rowsAt(0, 50) })).toBe(50);
    expect(
      await ackOf(runner, { taskId: task.id, index: 50, rows: [{ content: "" }], noMore: true }),
    ).toBe(51);
    expect(await logOf(runId, number)).toMatchObject({ ack_index: 51, state: "complete" });
    expect((await storedLines(runId, number)).length).toBe(50);
    await updateTask(runner, task.id, Result.SUCCESS);
    expect((await instanceLog(runId, number))?.log_complete).toBe(1);
  });

  it("in a body over 4 MiB acks only the complete rows of its prefix and is never final", async () => {
    const { runId, runner, task, number } = await withTask();
    const rows = rowsAt(0, 70, (i) => `${i}`.padEnd(64 * KiB, "y"));
    const ack = await ackOf(runner, { taskId: task.id, index: 0, rows, noMore: true });
    expect(ack).toBe(63);
    expect(await logOf(runId, number)).toMatchObject({ ack_index: 63, state: "streaming" });
    const lines = await storedLines(runId, number);
    expect(lines.map((l) => l.c)).toEqual(rows.slice(0, 63).map((r) => r.content));
    expect(
      await ackOf(runner, { taskId: task.id, index: 63, rows: rows.slice(63), noMore: true }),
    ).toBe(70);
    expect(await logOf(runId, number)).toMatchObject({ ack_index: 70, state: "complete" });
  });

  it("after the final UpdateTask completes the log the task reported incomplete", async () => {
    const { runId, runner, task, number } = await withTask();
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: rowsAt(0, 10) })).toBe(0);
    await updateTask(runner, task.id, Result.SUCCESS);
    expect(await instanceLog(runId, number)).toMatchObject({
      status: "completed",
      log_complete: 0,
    });
    expect((await logOf(runId, number))?.state).toBe("incomplete");
    // A held final call lands after the runner gave up on it.
    expect(
      await ackOf(runner, { taskId: task.id, index: 0, rows: rowsAt(0, 10), noMore: true }),
    ).toBe(10);
    expect((await logOf(runId, number))?.state).toBe("complete");
    expect((await instanceLog(runId, number))?.log_complete).toBe(1);
  });

  it("before the final UpdateTask: the task completes with its log complete", async () => {
    const { runId, runner, task, number } = await withTask();
    expect(
      await ackOf(runner, { taskId: task.id, index: 0, rows: rowsAt(0, 3), noMore: true }),
    ).toBe(3);
    await updateTask(runner, task.id, Result.FAILURE);
    expect(await instanceLog(runId, number)).toMatchObject({
      status: "completed",
      log_complete: 1,
    });
  });
});

/** Has the hook throw once, as a reset there would; the test then drops the object's memory. */
async function resetOnce(runId: string, point: "afterLogPut" | "afterLogCommit") {
  let armed = true;
  await hook(runId, () => ({
    [point]: () => {
      if (armed) {
        armed = false;
        throw new Error("reset");
      }
    },
  }));
}

describe("a reset", () => {
  it("after the object is written, before the manifest: the resend stores the rows once, under one manifest row", async () => {
    const { runId, runner, task, number } = await withTask();
    await resetOnce(runId, "afterLogPut");
    const lost = await sendLog(runner, { taskId: task.id, index: 0, rows: rowsAt(0, 50) });
    await connectError(lost, "unavailable", 503);
    await reset(runId);
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: rowsAt(0, 60) })).toBe(60);
    expect((await chunksOf(runId, number)).map((c) => c.start_index)).toEqual([0]);
    expect((await storedLines(runId, number)).map((l) => l.i)).toEqual(
      Array.from({ length: 60 }, (_, i) => i),
    );
    // The first write is an orphan nothing names, left for retention.
    expect((await objectsOf(runId, number)).length).toBe(2);
  });

  it("after the manifest, before the answer: the resend's stored rows are dropped and the rest stored", async () => {
    const { runId, runner, task, number } = await withTask();
    await resetOnce(runId, "afterLogCommit");
    await connectError(
      await sendLog(runner, { taskId: task.id, index: 0, rows: rowsAt(0, 50) }),
      "unavailable",
      503,
    );
    await reset(runId);
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: rowsAt(0, 100) })).toBe(100);
    expect((await chunksOf(runId, number)).map((c) => [c.start_index, c.end_index])).toEqual([
      [0, 50],
      [50, 100],
    ]);
    expect((await storedLines(runId, number)).map((l) => l.i)).toEqual(
      Array.from({ length: 100 }, (_, i) => i),
    );
  });

  it("during the terminal flush: the resent final call completes the log once", async () => {
    const { runId, runner, task, number } = await withTask();
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: rowsAt(0, 50) })).toBe(50);
    await resetOnce(runId, "afterLogPut");
    const final = { taskId: task.id, index: 50, rows: rowsAt(50, 7), noMore: true };
    await connectError(await sendLog(runner, final), "unavailable", 503);
    await reset(runId);
    expect(await ackOf(runner, final)).toBe(57);
    expect(await logOf(runId, number)).toMatchObject({ ack_index: 57, state: "complete" });
    expect((await storedLines(runId, number)).map((l) => l.i)).toEqual(
      Array.from({ length: 57 }, (_, i) => i),
    );
  });
});

describe("UpdateLog fencing", () => {
  it("confirms the task once and counts as a heartbeat", async () => {
    const { runId, runner, task, number } = await withTask();
    await at(runId, T0 + 60_000);
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: rowsAt(0, 1) })).toBe(0);
    expect(typeof (await taskRow(task.id))?.confirmed_at).toBe("number");
    expect((await instanceLog(runId, number))?.heartbeat_at).toBe(T0 + 60_000);
  });

  it("refuses another runner's task, an unknown task, and a decoded id that differs from the routed one", async () => {
    const { f, runner, task } = await withTask();
    const other = await registerRunner(f.org.login, f.owner);
    await connectError(
      await sendLog(other, { taskId: task.id, index: 0, rows: rowsAt(0, 50) }),
      "permission_denied",
      403,
    );
    await connectError(await sendLog(runner, { taskId: 2 ** 40, index: 0 }), "not_found", 404);
    const twice = new Writer()
      .uint64(1, task.id)
      .uint64(1, task.id + 1)
      .finish();
    await connectError(
      await runnerCall("UpdateLog", twice, { credentials: runner }),
      "invalid_argument",
      400,
    );
    await connectError(
      await runnerCall("UpdateLog", new Uint8Array(), { credentials: runner }),
      "invalid_argument",
      400,
    );
    expect((await taskRow(task.id))?.confirmed_at).toBeNull();
  });

  it("refuses an offer whose assignment the directory never recorded, confirming nothing", async () => {
    const f = await orgRepo();
    const runId = await started(f, one);
    const runner = await registerRunner(f.org.login, f.owner);
    await inRun(runId, (r) => {
      r.hooks = {
        beforeTaskRecord: () => {
          throw new Error("the directory write failed");
        },
      };
    });
    expect(
      (await runnerCall("FetchTask", new Uint8Array(), { credentials: runner })).status,
    ).not.toBe(200);
    await inRun(runId, (r) => {
      r.hooks = {};
    });
    const [offer] = await tasksOfRun(runId);
    expect(offer).toMatchObject({ runner_id: runner.id, task: null });
    await connectError(
      await sendLog(runner, { taskId: offer?.id ?? 0, index: 0, rows: rowsAt(0, 50) }),
      "not_found",
      404,
    );
    expect((await taskRow(offer?.id ?? 0))?.confirmed_at).toBeNull();
  });

  it("refuses rows for a task of an erased run", async () => {
    const { runId, runner, task } = await withTask();
    await inRun(runId, (r) =>
      r.engine.exec("INSERT INTO run_erasure (id, erased_at) VALUES (1, 0)"),
    );
    await connectError(
      await sendLog(runner, { taskId: task.id, index: 0, rows: rowsAt(0, 50) }),
      "not_found",
      404,
    );
  });

  it("erasing the run removes its log state and manifest", async () => {
    const { f, runId, runner, task, number } = await withTask();
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: rowsAt(0, 50) })).toBe(50);
    expect((await chunksOf(runId, number)).length).toBe(1);
    await runStub(runId).erase(f.repo.id);
    expect(await inRun(runId, (r) => r.engine.rows("SELECT * FROM ci_logs"))).toEqual([]);
    expect(await inRun(runId, (r) => r.engine.rows("SELECT * FROM ci_log_chunks"))).toEqual([]);
  });

  it("a flush whose run is erased while its object is written records nothing, deletes the object and answers not_found", async () => {
    const { f, runId, runner, task, number } = await withTask();
    await hook(runId, (r) => ({
      afterLogPut: async () => {
        await r.erase(f.repo.id);
      },
    }));
    await connectError(
      await sendLog(runner, { taskId: task.id, index: 0, rows: rowsAt(0, 50) }),
      "not_found",
      404,
    );
    expect(await inRun(runId, (r) => r.engine.rows("SELECT * FROM ci_logs"))).toEqual([]);
    expect(await inRun(runId, (r) => r.engine.rows("SELECT * FROM ci_log_chunks"))).toEqual([]);
    expect(await objectsOf(runId, number)).toEqual([]);
  });

  it("a flush whose run is erased before its object is written answers not_found and writes nothing", async () => {
    const { f, runId, runner, task, number } = await withTask();
    await hook(runId, (r) => ({
      beforeLogStore: async () => {
        await r.erase(f.repo.id);
      },
    }));
    await connectError(
      await sendLog(runner, {
        taskId: task.id,
        index: 0,
        rows: rowsAt(0, 50, (i) => (i === 0 ? "::add-mask::an-added-value" : `line ${i}`)),
      }),
      "not_found",
      404,
    );
    expect(await inRun(runId, (r) => r.engine.rows("SELECT * FROM ci_logs"))).toEqual([]);
    expect(await objectsOf(runId, number)).toEqual([]);
  });

  it("a failed object write moves no ack and gives back its memory", async () => {
    const { runId, runner, task, number } = await withTask();
    const before = await inRun(
      runId,
      (r) => r.memory.stats().reservedBytes - r.maskCacheBytesHeld(),
    );
    await inRun(runId, (r) => {
      const host = r as unknown as { env: Env };
      const bucket = host.env.CI;
      Object.defineProperty(host.env, "CI", {
        configurable: true,
        value: new Proxy(bucket, {
          get(target, prop) {
            if (prop === "put")
              return () => {
                Object.defineProperty(host.env, "CI", { configurable: true, value: bucket });
                throw new Error("R2 is unavailable");
              };
            const value = Reflect.get(target, prop);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      });
    });
    await connectError(
      await sendLog(runner, { taskId: task.id, index: 0, rows: rowsAt(0, 50) }),
      "unavailable",
      503,
    );
    expect(await inRun(runId, (r) => r.memory.stats().reservedBytes - r.maskCacheBytesHeld())).toBe(
      before,
    );
    expect(await logOf(runId, number)).toBeUndefined();
    expect(await objectsOf(runId, number)).toEqual([]);
    // The runner resends, and the write now succeeds.
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: rowsAt(0, 50) })).toBe(50);
  });

  it("stores a re-run's late rows from the previous attempt's task in that task's log only", async () => {
    const { f, runId, runner, task, number } = await withTask();
    await runStub(runId).cancel(f.owner.principalId, "force");
    await drain(runId);
    expect((await runStub(runId).rerun(f.owner.principalId)).ok).toBe(true);
    await drain(runId);
    const next = await registerRunner(f.org.login, f.owner);
    const retry = (await fetchTask(next, 0)).task;
    if (!retry) throw new Error("no task");
    const retryNumber = (await taskRow(retry.id))?.task as number;
    expect(retryNumber).not.toBe(number);
    expect(
      await ackOf(runner, { taskId: task.id, index: 0, rows: rowsAt(0, 5), noMore: true }),
    ).toBe(5);
    expect(await logOf(runId, number)).toMatchObject({ ack_index: 5, state: "complete" });
    expect(await logOf(runId, retryNumber)).toBeUndefined();
    expect((await chunksOf(runId, number))[0]?.r2_key).toMatch(
      new RegExp(`^runs/${runId}/1/\\d+/${number}/`),
    );
  });

  it("never logs the runner's or the job's token", async () => {
    const { runner, task } = await withTask();
    const jobToken = jobTokenOf(task);
    await ackOf(runner, { taskId: task.id, index: 0, rows: rowsAt(0, 50) });
    await sendLog(runner, { taskId: task.id, index: 99, rows: rowsAt(99, 1) });
    await ackOf(runner, { taskId: task.id, index: 50, rows: [], noMore: true });
    expect(logs.lines.filter((l) => l.includes(runner.token) || l.includes(jobToken))).toEqual([]);
  });
});

const varintBytes = (value: number) =>
  value < 2 ** 7 ? 1 : value < 2 ** 14 ? 2 : value < 2 ** 21 ? 3 : value < 2 ** 28 ? 4 : 5;

/**
 * The most content bytes a row at `index` (with a time, as `rowsAt` writes)
 * can carry while ending within the Worker's prefix as the first row of a
 * request from `index`: the prefix holds the task id, the index and the
 * row's own framing too.
 */
function largestFitting(taskId: number, index: number): number {
  const header = encodeUpdateLogRequest({ taskId, index }).length;
  const time = encodeLogRow(rowsAt(index, 1, () => "")[0] as LogRow).length;
  const size = (n: number) => {
    const row = time + 1 + varintBytes(n) + n;
    return header + 1 + varintBytes(row) + row;
  };
  let n = UPDATE_LOG_PREFIX_BYTES;
  while (size(n) > UPDATE_LOG_PREFIX_BYTES) n--;
  return n;
}

const join = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/**
 * A length-delimited field whose length varint has `pad` redundant bytes: a
 * reader takes it as the canonical field, which is `pad` bytes shorter.
 */
function paddedField(field: number, content: Uint8Array, pad: number): Uint8Array {
  const length: number[] = [];
  let rest = content.length;
  while (rest > 0x7f) {
    length.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  length.push(rest);
  if (pad > 0) {
    length[length.length - 1] = (length[length.length - 1] as number) | 0x80;
    for (let k = 1; k < pad; k++) length.push(0x80);
    length.push(0);
  }
  return join(Uint8Array.of(field * 8 + 2), Uint8Array.from(length), content);
}

describe("a row too large for any request", () => {
  /** Exactly 4 MiB of content: with its framing, it cannot fit in a 4 MiB prefix. */
  const huge = (index: number) => rowsAt(index, 1, () => "x".repeat(4 * MiB));
  const declared = (rows: LogRow[]) => encodeLogRow(rows[0] as LogRow).length;

  it("is recorded as omitted at its position; the rows after it are stored, the log never completes, the result stands", async () => {
    const { runId, runner, task, number } = await withTask();
    const big = huge(0);
    const tail = rowsAt(1, 3, (i) => `tail ${i}`);
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: [...big, ...tail] })).toBe(1);
    expect(await storedLines(runId, number)).toEqual([
      { i: 0, omitted: LOG_ROW_TOO_LARGE, bytes: declared(big) },
    ]);
    expect(await logOf(runId, number)).toMatchObject({
      ack_index: 1,
      rows: 0,
      omitted_rows: 1,
      state: "streaming",
    });
    expect(logs.lines.some((l) => l.includes("log row omitted: too large for any request"))).toBe(
      true,
    );
    // The runner drops the row the ack passed and sends the rest in its final call.
    expect(await ackOf(runner, { taskId: task.id, index: 1, rows: tail, noMore: true })).toBe(4);
    const lines = await storedLines(runId, number);
    expect(lines.map((l) => l.i)).toEqual([0, 1, 2, 3]);
    expect(lines.slice(1).map((l) => l.c)).toEqual(tail.map(() => "***"));
    expect(await logOf(runId, number)).toMatchObject({
      ack_index: 4,
      rows: 3,
      omitted_rows: 1,
      state: "incomplete",
    });
    await updateTask(runner, task.id, Result.SUCCESS);
    expect(await instanceLog(runId, number)).toMatchObject({
      status: "completed",
      conclusion: "success",
      log_complete: 0,
    });
    // Late and repeated final calls, in either runner's form, never complete it.
    expect(await ackOf(runner, { taskId: task.id, index: 1, rows: tail, noMore: true })).toBe(4);
    expect(await ackOf(runner, { taskId: task.id, index: 4, rows: [], noMore: true })).toBe(4);
    expect(await logOf(runId, number)).toMatchObject({ state: "incomplete", omitted_rows: 1 });
    expect((await instanceLog(runId, number))?.log_complete).toBe(0);
    expect((await chunksOf(runId, number)).map((c) => [c.start_index, c.end_index])).toEqual([
      [0, 1],
      [1, 4],
    ]);
  });

  it("resent below the ack (a lost answer) is held and recorded once", async () => {
    const { runId, runner, task, number } = await withTask();
    const sent = [...huge(0), ...rowsAt(1, 2)];
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: sent })).toBe(1);
    for (let k = 0; k < 3; k++)
      expect(await ackOf(runner, { taskId: task.id, index: 0, rows: sent })).toBe(1);
    expect(await logOf(runId, number)).toMatchObject({ ack_index: 1, omitted_rows: 1 });
    expect((await chunksOf(runId, number)).length).toBe(1);
    expect((await objectsOf(runId, number)).length).toBe(1);
  });

  it.each<[string, LogRow[], number]>([
    ["the newer runner's empty final call", [], 1],
    ["the older runner's sentinel", [{ content: "" }], 2],
  ])(
    "ended right after it by %s stores only the record and stays incomplete",
    async (_form, rows, ack) => {
      const { runId, runner, task, number } = await withTask();
      expect(await ackOf(runner, { taskId: task.id, index: 0, rows: huge(0) })).toBe(1);
      expect(await ackOf(runner, { taskId: task.id, index: 1, rows, noMore: true })).toBe(ack);
      expect(await storedLines(runId, number)).toEqual([
        { i: 0, omitted: LOG_ROW_TOO_LARGE, bytes: declared(huge(0)) },
      ]);
      expect(await logOf(runId, number)).toMatchObject({
        ack_index: ack,
        rows: 0,
        omitted_rows: 1,
        state: "incomplete",
      });
    },
  );

  it("before the older runner's sentinel leaves the log incomplete", async () => {
    const { runId, runner, task, number } = await withTask();
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: huge(0) })).toBe(1);
    expect(
      await ackOf(runner, { taskId: task.id, index: 1, rows: [{ content: "" }], noMore: true }),
    ).toBe(2);
    expect(await logOf(runId, number)).toMatchObject({
      ack_index: 2,
      rows: 0,
      omitted_rows: 1,
      state: "incomplete",
    });
    await updateTask(runner, task.id, Result.FAILURE);
    expect(await instanceLog(runId, number)).toMatchObject({
      conclusion: "failure",
      log_complete: 0,
    });
  });

  it("is a row past the largest that fits with its framing; one that fits, to the byte, is stored", async () => {
    const { runId, runner, task, number } = await withTask();
    const send = (index: number, rows: LogRow[]) => ackOf(runner, { taskId: task.id, index, rows });
    const exactly = (index: number, content: (n: number) => string) => {
      const n = largestFitting(task.id, index);
      expect(n).toBeLessThan(4 * MiB);
      return rowsAt(index, 1, () => content(n));
    };
    // A whole body of exactly the prefix: not cut, stored.
    const whole = exactly(0, (n) => "a".repeat(n));
    expect(encodeUpdateLogRequest({ taskId: task.id, index: 0, rows: whole }).length).toBe(
      UPDATE_LOG_PREFIX_BYTES,
    );
    expect(await send(0, whole)).toBe(1);
    // A row ending exactly at the prefix's end, with more after it: the body is cut, the row is not.
    const atEnd = exactly(1, (n) => "b".repeat(n));
    expect(await send(1, [...atEnd, ...rowsAt(2, 1)])).toBe(2);
    // One byte more: omitted.
    const over = exactly(2, (n) => "c".repeat(n + 1));
    expect(await send(2, [...over, ...rowsAt(3, 1)])).toBe(3);
    const protectedPrefix = await inRun(
      runId,
      (r) =>
        r.engine.rows<{ gap_remaining: number }>(
          "SELECT gap_remaining FROM ci_logs WHERE task = ?",
          number,
        )[0]?.gap_remaining ?? 0,
    );
    expect(protectedPrefix).toBe(btoa(jobTokenOf(task)).length - 1);
    // Multibyte content: a two-byte character ending exactly at the prefix's end is stored whole …
    const wide = exactly(3, (n) => `${"d".repeat(n - 2)}é`);
    expect(await send(3, [...wide, ...rowsAt(4, 1)])).toBe(4);
    // … and cut between its bytes, the row is omitted, not refused as invalid UTF-8.
    const split = exactly(4, (n) => `${"e".repeat(n - 1)}é`);
    expect(await send(4, [...split, ...rowsAt(5, 1)])).toBe(5);
    expect(
      await ackOf(runner, { taskId: task.id, index: 5, rows: rowsAt(5, 1), noMore: true }),
    ).toBe(6);
    const lines = await storedLines(runId, number);
    expect(lines.map((l) => l.i)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(lines.map((l) => (l.omitted ? "omitted" : l.c?.length))).toEqual([
      whole[0]?.content.length,
      atEnd[0]?.content.length,
      "omitted",
      (wide[0]?.content.length ?? 0) - protectedPrefix + 3,
      "omitted",
      "***".length,
    ]);
    expect(lines[0]?.c).toBe(whole[0]?.content);
    expect(lines[3]?.c).toBe(`***${wide[0]?.content.slice(protectedPrefix)}`);
    expect(lines[2]).toEqual({ i: 2, omitted: LOG_ROW_TOO_LARGE, bytes: declared(over) });
    expect(await logOf(runId, number)).toMatchObject({
      ack_index: 6,
      rows: 4,
      omitted_rows: 2,
      state: "incomplete",
    });
  });

  it("is not a row that fits once framed as the runner frames it: a repeated task id or a padded length is held, never omitted", async () => {
    const { runId, runner, task, number } = await withTask();
    const raw = async (body: Uint8Array) =>
      ackOfRaw(await runnerCall("UpdateLog", body, { credentials: runner }));
    const framed = (index: number, rows: LogRow[], repeat: number, pad: number) => {
      const header = encodeUpdateLogRequest({ taskId: task.id, index });
      const row = encodeLogRow(rows[0] as LogRow);
      return join(...Array.from({ length: repeat }, () => header), paddedField(3, row, pad));
    };
    const fits = rowsAt(0, 1, (i) => "f".repeat(largestFitting(task.id, i)));
    const canonical = encodeUpdateLogRequest({ taskId: task.id, index: 0, rows: fits });
    expect(canonical.length).toBe(UPDATE_LOG_PREFIX_BYTES);
    expect(framed(0, fits, 1, 0)).toEqual(canonical);
    // Each framing is longer than the prefix and is cut inside the row: held, nothing recorded.
    for (const body of [framed(0, fits, 2, 0), framed(0, fits, 1, 1)]) {
      expect(body.length).toBeGreaterThan(UPDATE_LOG_PREFIX_BYTES);
      expect(await raw(body)).toBe(0);
    }
    expect(await chunksOf(runId, number)).toEqual([]);
    expect(await objectsOf(runId, number)).toEqual([]);
    // The runner's framing of the same row: stored whole.
    expect(await raw(canonical)).toBe(1);
    // One content byte more, in the same framings: no request carries it, so it is omitted.
    const over = rowsAt(1, 1, (i) => "g".repeat(largestFitting(task.id, i) + 1));
    expect(await raw(framed(1, over, 2, 0))).toBe(2);
    const padded = rowsAt(2, 1, (i) => "h".repeat(largestFitting(task.id, i) + 1));
    expect(await raw(framed(2, padded, 1, 1))).toBe(3);
    const lines = await storedLines(runId, number);
    expect(lines.map((l) => l.omitted ?? l.c)).toEqual([
      fits[0]?.content,
      LOG_ROW_TOO_LARGE,
      LOG_ROW_TOO_LARGE,
    ]);
    expect(lines.slice(1).map((l) => l.bytes)).toEqual([declared(over), declared(padded)]);
    expect(await logOf(runId, number)).toMatchObject({ ack_index: 3, rows: 1, omitted_rows: 2 });
  });

  it("is not a row cut only by the rows before it: that one is stored from the resend", async () => {
    const { runId, runner, task, number } = await withTask();
    const rows = [
      ...rowsAt(0, 3, (i) => `${i}`.padEnd(MiB, "m")),
      ...rowsAt(3, 1, () => "n".repeat(2 * MiB)),
      ...rowsAt(4, 1),
    ];
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows })).toBe(3);
    expect(await ackOf(runner, { taskId: task.id, index: 3, rows: rows.slice(3) })).toBe(5);
    expect((await storedLines(runId, number)).map((l) => l.c)).toEqual(rows.map((r) => r.content));
    expect(await logOf(runId, number)).toMatchObject({ omitted_rows: 0, rows: 5 });
  });

  it("is never inferred from a cut body with no decoded row: a large unknown field before a small row is held", async () => {
    const { runId, runner, task, number } = await withTask();
    const body = new Writer()
      .uint64(1, task.id)
      .bytes(15, new Uint8Array(5 * MiB))
      .message(3, encodeLogRow({ content: "small" }))
      .finish();
    for (let k = 0; k < 2; k++)
      expect(await ackOfRaw(await runnerCall("UpdateLog", body, { credentials: runner }))).toBe(0);
    expect(await chunksOf(runId, number)).toEqual([]);
    expect(await objectsOf(runId, number)).toEqual([]);
  });

  it("is not proven by a prefix shorter than the Worker's", async () => {
    const { runId, runner, task, number } = await withTask();
    const short = encodeUpdateLogRequest({
      taskId: task.id,
      rows: [{ content: "x".repeat(100) }],
    }).subarray(0, 40);
    const answer = await runStub(runId).appendLog(task.id, short, true, runner.id);
    if (!answer.ok) throw new Error(answer.message);
    expect(decodeUpdateLogResponse(answer.response).ackIndex).toBe(0);
    expect(await chunksOf(runId, number)).toEqual([]);
  });

  it("after its record is written, before the manifest: the resend records it once", async () => {
    const { runId, runner, task, number } = await withTask();
    await resetOnce(runId, "afterLogPut");
    await connectError(
      await sendLog(runner, { taskId: task.id, index: 0, rows: huge(0) }),
      "unavailable",
      503,
    );
    await reset(runId);
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: huge(0) })).toBe(1);
    expect((await chunksOf(runId, number)).map((c) => [c.start_index, c.end_index])).toEqual([
      [0, 1],
    ]);
    expect(await logOf(runId, number)).toMatchObject({ ack_index: 1, omitted_rows: 1 });
    // The first record is an orphan nothing names, left for retention.
    expect((await objectsOf(runId, number)).length).toBe(2);
  });

  it("after the manifest, before the answer: the resend is held at the ack", async () => {
    const { runId, runner, task, number } = await withTask();
    await resetOnce(runId, "afterLogCommit");
    await connectError(
      await sendLog(runner, { taskId: task.id, index: 0, rows: huge(0) }),
      "unavailable",
      503,
    );
    await reset(runId);
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: huge(0) })).toBe(1);
    expect(await logOf(runId, number)).toMatchObject({ ack_index: 1, omitted_rows: 1 });
    expect((await objectsOf(runId, number)).length).toBe(1);
  });

  it("whose run is erased while its record is written records nothing and deletes the record", async () => {
    const { f, runId, runner, task, number } = await withTask();
    await hook(runId, (r) => ({
      afterLogPut: async () => {
        await r.erase(f.repo.id);
      },
    }));
    await connectError(
      await sendLog(runner, { taskId: task.id, index: 0, rows: huge(0) }),
      "not_found",
      404,
    );
    expect(await inRun(runId, (r) => r.engine.rows("SELECT * FROM ci_logs"))).toEqual([]);
    expect(await objectsOf(runId, number)).toEqual([]);
  });

  it("while its task has a request in progress, or the pool is taken, is answered with the stored ack, unread", async () => {
    const f = await orgRepo();
    const runId = await started(f, two);
    const a = await registerRunner(f.org.login, f.owner);
    const b = await registerRunner(f.org.login, f.owner);
    const taskA = (await fetchTask(a, 0)).task;
    const taskB = (await fetchTask(b, 0)).task;
    if (!taskA || !taskB) throw new Error("no tasks");
    const numberA = (await taskRow(taskA.id))?.task as number;
    const numberB = (await taskRow(taskB.id))?.task as number;
    const held = gate();
    await hook(runId, () => ({ beforeLogStore: () => held.hold() }));
    // 60 rows of 64 KiB: about 11.8 MiB of the 16 MiB pool while held.
    const first = sendLog(a, {
      taskId: taskA.id,
      index: 0,
      rows: rowsAt(0, 60, (i) => `${i}`.padEnd(64 * KiB, "x")),
    }).then(ackOfRaw);
    await held.started;
    expect(await ackOf(a, { taskId: taskA.id, index: 0, rows: huge(0) })).toBe(0);
    expect(await ackOf(b, { taskId: taskB.id, index: 0, rows: huge(0) })).toBe(0);
    held.release();
    expect(await first).toBe(60);
    await hook(runId, () => ({}));
    expect(await logOf(runId, numberA)).toMatchObject({ ack_index: 60, omitted_rows: 0 });
    expect(await logOf(runId, numberB)).toBeUndefined();
    // Resent with room: recorded.
    expect(await ackOf(b, { taskId: taskB.id, index: 0, rows: huge(0) })).toBe(1);
    expect(await logOf(runId, numberB)).toMatchObject({ ack_index: 1, omitted_rows: 1 });
  });
});
