import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { isLogOmission, LOG_ROW_TOO_LARGE, type StoredLogLine } from "@fyrden/domain/ci";
import { describe, expect, it } from "vitest";
import type { LogRow } from "../src/runner/proto/messages.js";
import { decodeUpdateLogResponse, encodeUpdateLogRequest } from "./helpers/runner-proto.js";
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
} from "./helpers/runners.js";
import { at, inRun, job, now, runStub, started, workflow } from "./helpers/runs.js";

const one = workflow(job("a"));
const row = (content: string): LogRow => ({ content });
const huge = () => row("x".repeat(4 * 1024 * 1024));
const emptyRows = (count: number): LogRow[] => Array.from({ length: count }, () => row(""));
const batch = (content: string): LogRow[] => [row(content), ...emptyRows(48), row("\0")];

type LogRequest = { taskId: number; index: number; rows?: LogRow[]; noMore?: boolean };

const sendLog = (runner: Credentials, request: LogRequest) =>
  runnerCall("UpdateLog", encodeUpdateLogRequest(request), { credentials: runner });

async function ackOf(runner: Credentials, request: LogRequest): Promise<number> {
  return decodeUpdateLogResponse(await proto(await sendLog(runner, request))).ackIndex;
}

async function withTask() {
  const f = await orgRepo();
  const runId = await started(f, one);
  const runner = await registerRunner(f.org.login, f.owner);
  const task = (await fetchTask(runner, 0)).task;
  if (!task) throw new Error("no task");
  const number = (await taskRow(task.id))?.task;
  if (typeof number !== "number") throw new Error("the task was not recorded");
  return { runId, runner, task, number, token: jobTokenOf(task) };
}

interface LogState {
  ack_index: number;
  state: string;
  rows: number;
  omitted_rows: number;
  mask_carry: string | null;
  gap_remaining: number;
  finalized: number;
}

const stateOf = (runId: string, task: number) =>
  inRun(runId, (r) => {
    const log = r.engine.rows<LogState>(
      `SELECT ack_index, state, rows, omitted_rows, mask_carry, gap_remaining, finalized
       FROM ci_logs WHERE task = ?`,
      task,
    )[0];
    if (!log) throw new Error("no stored log");
    return log;
  });

const chunksOf = (runId: string, task: number) =>
  inRun(runId, (r) =>
    r.engine.rows<{ start_index: number; end_index: number; r2_key: string }>(
      "SELECT start_index, end_index, r2_key FROM ci_log_chunks WHERE task = ? ORDER BY start_index",
      task,
    ),
  );

async function storedLines(runId: string, task: number): Promise<StoredLogLine[]> {
  const lines: StoredLogLine[] = [];
  for (const chunk of await chunksOf(runId, task)) {
    const object = await env.CI.get(chunk.r2_key);
    if (!object) throw new Error("the manifest names a missing object");
    for (const text of (await object.text()).split("\n"))
      if (text !== "") lines.push(JSON.parse(text) as StoredLogLine);
  }
  return lines;
}

const masksOf = (runId: string, task: number) =>
  inRun(runId, (r) => r.engine.rows("SELECT * FROM ci_log_masks WHERE task = ?", task));

async function reset(runId: string): Promise<void> {
  await evictDurableObject(runStub(runId));
  await at(runId, now(runId));
}

describe("masking across omitted log rows", () => {
  it("masks an unknown token prefix's suffix across short and empty rows, requests and eviction", async () => {
    const { runId, runner, task, number, token } = await withTask();
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: [huge()] })).toBe(1);
    const initial = await stateOf(runId, number);
    expect(initial.gap_remaining).toBeGreaterThan(9);
    expect(initial.mask_carry).toBeNull();
    const suffix = token.slice(-9);

    expect(
      await ackOf(runner, { taskId: task.id, index: 1, rows: batch(suffix.slice(0, 3)) }),
    ).toBe(51);
    expect(await stateOf(runId, number)).toMatchObject({
      ack_index: 51,
      gap_remaining: initial.gap_remaining - 4,
    });
    await reset(runId);
    expect(
      await ackOf(runner, { taskId: task.id, index: 51, rows: batch(suffix.slice(3, 6)) }),
    ).toBe(101);
    const remaining = (await stateOf(runId, number)).gap_remaining;
    expect(remaining).toBe(initial.gap_remaining - 8);
    const tail = [row(suffix.slice(6)), row(`${"\0".repeat(remaining - 3)}visible tail`)];
    expect(await ackOf(runner, { taskId: task.id, index: 101, rows: tail, noMore: true })).toBe(
      103,
    );

    const lines = await storedLines(runId, number);
    expect(lines[0]).toMatchObject({ i: 0, omitted: LOG_ROW_TOO_LARGE });
    const contents = lines
      .filter((line): line is Extract<StoredLogLine, { c: string }> => !isLogOmission(line))
      .map((line) => line.c);
    expect(contents[0]).toBe("***");
    expect(contents[50]).toBe("***");
    expect(contents[100]).toBe("***");
    expect(contents[101]).toBe("***visible tail");
    expect(contents.join("")).not.toContain(suffix);
    expect(contents.join("")).not.toContain(token);
    expect(await stateOf(runId, number)).toMatchObject({
      ack_index: 103,
      omitted_rows: 1,
      state: "incomplete",
      finalized: 1,
    });
  });

  it("does not reset or consume prefix protection again for a resend below the acknowledgement", async () => {
    const { runId, runner, task, number, token } = await withTask();
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: [huge()] })).toBe(1);
    expect(await ackOf(runner, { taskId: task.id, index: 1, rows: batch(token.slice(-3)) })).toBe(
      51,
    );
    const before = await stateOf(runId, number);
    const chunks = await chunksOf(runId, number);
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: [huge()] })).toBe(51);
    expect(await stateOf(runId, number)).toEqual(before);
    expect(await chunksOf(runId, number)).toEqual(chunks);
  });

  it("renews protection after a second omission once the earlier prefix was consumed", async () => {
    const { runId, runner, task, number, token } = await withTask();
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: [huge()] })).toBe(1);
    const first = (await stateOf(runId, number)).gap_remaining;
    expect(
      await ackOf(runner, { taskId: task.id, index: 1, rows: batch("\0".repeat(first)) }),
    ).toBe(51);
    expect((await stateOf(runId, number)).gap_remaining).toBe(0);
    expect(await ackOf(runner, { taskId: task.id, index: 51, rows: [huge()] })).toBe(52);
    expect(await stateOf(runId, number)).toMatchObject({ gap_remaining: first, omitted_rows: 2 });
    expect(await ackOf(runner, { taskId: task.id, index: 52, rows: batch(token.slice(-6)) })).toBe(
      102,
    );
    expect((await stateOf(runId, number)).gap_remaining).toBe(first - 7);
    const last = (await storedLines(runId, number)).find((line) => line.i === 52);
    expect(last).toEqual({ i: 52, t: null, c: "***" });
  });

  it("stores a masked partial prefix before advancing past an oversized row", async () => {
    const { runId, runner, task, number, token } = await withTask();
    const prefix = row(token.slice(0, 20));
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: [prefix, huge()] })).toBe(1);
    expect(await storedLines(runId, number)).toEqual([{ i: 0, t: null, c: "***" }]);
    expect((await stateOf(runId, number)).mask_carry).not.toBeNull();
    expect(await ackOf(runner, { taskId: task.id, index: 1, rows: [huge()] })).toBe(2);
    expect(await stateOf(runId, number)).toMatchObject({ ack_index: 2, mask_carry: null });
    expect(
      await ackOf(runner, {
        taskId: task.id,
        index: 2,
        rows: [row(token.slice(20))],
        noMore: true,
      }),
    ).toBe(3);
    const last = (await storedLines(runId, number)).find((line) => line.i === 2);
    expect(last).toEqual({ i: 2, t: null, c: "***" });
    expect(await stateOf(runId, number)).toMatchObject({ state: "incomplete", omitted_rows: 1 });
  });

  it("keeps the acknowledgement and prefix budget unchanged when R2 refuses a write", async () => {
    const { runId, runner, task, number, token } = await withTask();
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: [huge()] })).toBe(1);
    const before = await stateOf(runId, number);
    const chunks = await chunksOf(runId, number);
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
    const request = { taskId: task.id, index: 1, rows: batch(token.slice(-3)) };
    await connectError(await sendLog(runner, request), "unavailable", 503);
    expect(await stateOf(runId, number)).toEqual(before);
    expect(await chunksOf(runId, number)).toEqual(chunks);
    expect(await ackOf(runner, request)).toBe(51);
    expect((await stateOf(runId, number)).gap_remaining).toBe(before.gap_remaining - 4);
  });

  it("does not consume a winning flush's prefix budget twice when its compare-and-set loses", async () => {
    const { runId, runner, task, number, token } = await withTask();
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: [huge()] })).toBe(1);
    const before = await stateOf(runId, number);
    let winner = "";
    await inRun(runId, (r) => {
      r.hooks.afterLogPut = async (key: string) => {
        winner = key.replace(/-[0-9a-f]{32}\.ndjson$/, `-${"0".repeat(32)}.ndjson`);
        const object = await env.CI.get(key);
        if (!object) throw new Error("no candidate chunk");
        await env.CI.put(winner, await object.text());
        r.engine.exec(
          `INSERT INTO ci_log_chunks (task, start_index, end_index, bytes, r2_key, created_at)
           VALUES (?, 1, 51, ?, ?, 0)`,
          number,
          object.size,
          winner,
        );
        r.engine.exec(
          `UPDATE ci_logs SET ack_index = 51, rows = rows + 50, bytes = bytes + ?,
             gap_remaining = ?, mask_carry = NULL WHERE task = ?`,
          object.size,
          before.gap_remaining - 4,
          number,
        );
      };
    });
    expect(await ackOf(runner, { taskId: task.id, index: 1, rows: batch(token.slice(-3)) })).toBe(
      51,
    );
    await inRun(runId, (r) => {
      r.hooks = {};
    });
    expect(await stateOf(runId, number)).toMatchObject({
      ack_index: 51,
      gap_remaining: before.gap_remaining - 4,
      omitted_rows: 1,
      rows: 50,
    });
    expect((await chunksOf(runId, number)).map((chunk) => chunk.r2_key).at(-1)).toBe(winner);
    const listed = await env.CI.list({ prefix: `runs/${runId}/` });
    const owned = listed.objects.filter((object) => object.key.split("/")[4] === String(number));
    expect(owned.map((object) => object.key).sort()).toEqual(
      (await chunksOf(runId, number)).map((chunk) => chunk.r2_key).sort(),
    );
  });

  it.each<[string, LogRow[], number]>([
    ["empty final", [], 1],
    ["sentinel final", [row("")], 2],
  ])("seals an incomplete log on %s before deleting its masks", async (_form, rows, finalAck) => {
    const { runId, runner, task, number, token } = await withTask();
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: [huge()] })).toBe(1);
    expect(await ackOf(runner, { taskId: task.id, index: 1, rows, noMore: true })).toBe(finalAck);
    expect(await stateOf(runId, number)).toMatchObject({
      ack_index: finalAck,
      state: "incomplete",
      omitted_rows: 1,
      finalized: 1,
    });
    expect(await masksOf(runId, number)).toEqual([]);
    const chunks = await chunksOf(runId, number);
    const lines = await storedLines(runId, number);
    await reset(runId);
    expect(
      await ackOf(runner, {
        taskId: task.id,
        index: finalAck,
        rows: [row(token), ...emptyRows(49)],
        noMore: true,
      }),
    ).toBe(finalAck);
    expect(await chunksOf(runId, number)).toEqual(chunks);
    expect(await storedLines(runId, number)).toEqual(lines);
    expect(await stateOf(runId, number)).toMatchObject({ state: "incomplete", finalized: 1 });
  });
});
