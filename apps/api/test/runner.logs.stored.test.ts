// Finding a position in a stored log: one row of the manifest, however many
// chunks the log has and wherever the position is.
import { describe, expect, it } from "vitest";
import type { RunDO } from "../src/do/RunDO.js";
import { fetchTask, orgRepo, registerRunner } from "./helpers/runners.js";
import { inRun, job, started, workflow } from "./helpers/runs.js";

const CHUNKS = 400;

/** A running job whose log has `CHUNKS` chunks of 3 lines, but for the one at `hole`. */
async function chunked(hole?: number) {
  const f = await orgRepo();
  const runId = await started(f, workflow(job("a")));
  const runner = await registerRunner(f.org.login, f.owner);
  if (!(await fetchTask(runner, 0)).task) throw new Error("no task");
  await inRun(runId, (run) => {
    run.engine.exec(
      `INSERT INTO ci_logs (task, ack_index, updated_at) VALUES (1, ?1, 0)
       ON CONFLICT (task) DO UPDATE SET ack_index = ?1`,
      CHUNKS * 3,
    );
    for (let k = 0; k < CHUNKS; k++)
      if (k !== hole)
        run.engine.exec(
          "INSERT INTO ci_log_chunks (task, start_index, end_index, bytes, r2_key, created_at) VALUES (1, ?, ?, 10, ?, 0)",
          k * 3,
          k * 3 + 3,
          `chunk-${k}`,
        );
  });
  return runId;
}

/** What `fn` answers, and the rows of the object's tables it read. */
function counted<T>(run: RunDO, fn: () => T) {
  const { sql } = run.context.storage;
  const exec = sql.exec.bind(sql);
  const cursors: { rowsRead: number }[] = [];
  sql.exec = ((query: string, ...bindings: unknown[]) => {
    const cursor = exec(query, ...(bindings as []));
    cursors.push(cursor);
    return cursor;
  }) as typeof sql.exec;
  try {
    const value = fn();
    return { value, read: cursors.reduce((sum, c) => sum + c.rowsRead, 0) };
  } finally {
    sql.exec = exec as typeof sql.exec;
  }
}

describe("a stored log", () => {
  it("is found at any position, and its end, in a few rows read", async () => {
    const runId = await chunked();
    const found = await inRun(runId, (run) => {
      const log = counted(run, () => run.storedLogs.jobLog(1));
      const late = counted(run, () => run.storedLogs.chunkAt(1, CHUNKS * 3 - 1));
      return { log, late };
    });
    expect(found.log.value).toEqual({
      task: 1,
      ended: false,
      state: null,
      linesEnd: CHUNKS * 3,
      unmasked: false,
    });
    expect(found.late.value).toEqual({
      task: 1,
      start: CHUNKS * 3 - 3,
      end: CHUNKS * 3,
      bytes: 10,
      key: `chunk-${CHUNKS - 1}`,
    });
    // The job, its log and its last chunk.
    expect(found.log.read).toBeLessThanOrEqual(3);
    expect(found.late.read).toBeLessThanOrEqual(1);
  });

  it("has a chunk for a position only when one holds it", async () => {
    const runId = await chunked(5);
    const keys = await inRun(runId, (run) =>
      [0, 2, 3, 14, 15, 17, 18, CHUNKS * 3 - 1, CHUNKS * 3].map(
        (i) => run.storedLogs.chunkAt(1, i)?.key ?? null,
      ),
    );
    expect(keys).toEqual([
      "chunk-0",
      "chunk-0",
      "chunk-1",
      "chunk-4",
      null,
      null,
      "chunk-6",
      `chunk-${CHUNKS - 1}`,
      null,
    ]);
  });
});
