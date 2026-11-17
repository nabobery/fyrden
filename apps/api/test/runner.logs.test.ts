// UpdateLog: a runner's log rows. The Worker reads at most 4 MiB and routes
// by the task id it scans; the task's run decodes the rows, stores the new
// ones as one NDJSON object in R2 named in its manifest, and acks only what
// is stored. The runner keeps and resends every row past its ack, so rows
// that are not stored yet are never lost: a held request, a busy task, a
// full memory pool or a reset only means the runner sends them again.
import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { RunDO } from "../src/do/RunDO.js";
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

/** A run of `source` in a new organization, with a runner holding its first task. */
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

/** Rows at positions `[from, from + n)`, each line naming its position, printed one second apart. */
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

/** UpdateLog; the ack it answers. */
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
        "SELECT task, ack_index, state, rows, bytes FROM ci_logs WHERE task = ?",
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

/** Every object stored under the task's log prefix. */
async function objectsOf(runId: string, task: number): Promise<string[]> {
  const listed = await env.CI.list({ prefix: `runs/${runId}/` });
  return listed.objects.map((o) => o.key).filter((key) => key.split("/")[4] === String(task));
}

interface Line {
  i: number;
  t: number | null;
  c: string;
}

/** The lines of every chunk the manifest names, in order, checked contiguous with no duplicates. */
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
      r.engine.rows<{ status: string; log_complete: number | null; heartbeat_at: number | null }>(
        "SELECT status, log_complete, heartbeat_at FROM run_instances WHERE task = ?",
        task,
      )[0],
  );

/** Sets the run's log hooks for the rest of the object's life (an eviction clears them). */
const hook = (runId: string, set: (run: RunDO) => RunDO["hooks"]) =>
  inRun(runId, (r) => {
    r.hooks = set(r);
  });

/** A reset: the next request finds a new instance, with nothing in memory. */
async function reset(runId: string) {
  await evictDurableObject(runStub(runId));
  await at(runId, now(runId));
}

/** A gate a hook waits on: `started` resolves when the hook is reached, `release` lets it go. */
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
    // 60 rows of 64 KiB: just under 4 MiB, so a request reserves about 11.8 MiB of the 16.
    const big = (from: number) => rowsAt(from, 60, (i) => `${i}`.padEnd(64 * KiB, "x"));
    const held = gate();
    await hook(runId, () => ({ beforeLogStore: () => held.hold() }));
    const first = sendLog(a, { taskId: taskA.id, index: 0, rows: big(0) }).then(ackOfRaw);
    await held.started;
    const during = await inRun(runId, (r) => r.memory.stats());
    expect(during.reservedBytes).toBeGreaterThan(11 * MiB);
    expect(await ackOf(b, { taskId: taskB.id, index: 0, rows: big(0) })).toBe(0);
    const refused = await inRun(runId, (r) => r.memory.stats());
    // Retained input stays within the pool: the refused body reserved nothing.
    expect(refused.reservedBytes).toBe(during.reservedBytes);
    expect(refused.peakBytes).toBeLessThanOrEqual(16 * MiB);
    expect(await objectsOf(runId, numberB)).toEqual([]);
    held.release();
    expect(await first).toBe(60);
    await hook(runId, () => ({}));
    expect((await inRun(runId, (r) => r.memory.stats())).reservedBytes).toBe(0);
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

describe("a reset", () => {
  /** Has the hook throw once, as a reset there would, then drops the object's memory. */
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

  it("a failed object write moves no ack and gives back its memory", async () => {
    const { runId, runner, task, number } = await withTask();
    const before = await inRun(runId, (r) => r.memory.stats().reservedBytes);
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
    expect(await inRun(runId, (r) => r.memory.stats().reservedBytes)).toBe(before);
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
