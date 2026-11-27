import { expect } from "vitest";
import type { LogRow, StepState, Task } from "../../../apps/api/src/runner/proto/messages.js";
import {
  decodeFetchTaskResponse,
  decodeRunnerResponse,
  decodeUpdateLogResponse,
  encodeDeclareRequest,
  encodeFetchTaskRequest,
  encodeRegisterRequest,
  encodeUpdateLogRequest,
  encodeUpdateTaskRequest,
} from "../../../apps/api/test/helpers/runner-proto.js";
import { eventually } from "./forge.js";

export interface PlayedRunner {
  readonly uuid: string;
  readonly token: string;
}

/** Rows one UpdateLog carries at most (limits.md "Job logs"). */
const ROWS_A_REQUEST = 10_000;
const BYTES_A_REQUEST = 3 * 1024 * 1024;

async function call(
  origin: string,
  method: string,
  body: Uint8Array,
  runner?: PlayedRunner,
): Promise<Uint8Array> {
  const res = await fetch(`${origin}/api/actions/runner.v1.RunnerService/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/proto",
      "connect-protocol-version": "1",
      ...(runner && { "x-runner-uuid": runner.uuid, "x-runner-token": runner.token }),
    },
    body: Buffer.from(body),
  });
  expect(res.status, `${method}: ${res.status}`).toBe(200);
  return new Uint8Array(await res.arrayBuffer());
}

/** A runner of `org`, registered and declared as the pinned runner does. */
export async function registerRunner(
  origin: string,
  adminToken: string,
  org: string,
): Promise<PlayedRunner> {
  const minted = await fetch(`${origin}/api/orgs/${org}/actions/runners/registration-token`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: "{}",
  });
  expect(minted.status, await minted.clone().text()).toBe(201);
  const { token } = (await minted.json()) as { token: string };
  const { runner } = decodeRunnerResponse(
    await call(
      origin,
      "Register",
      encodeRegisterRequest({
        name: `e2e-${crypto.randomUUID().slice(0, 8)}`,
        token,
        agentLabels: [],
        customLabels: [],
        version: "v6.0.0",
        labels: ["ubuntu-latest"],
        ephemeral: false,
        capabilities: [],
      }),
    ),
  );
  if (!runner) throw new Error("no runner");
  const played = { uuid: runner.uuid, token: runner.token };
  await call(
    origin,
    "Declare",
    encodeDeclareRequest({ version: "v6.0.0", labels: ["ubuntu-latest"], capabilities: [] }),
    played,
  );
  return played;
}

export function fetchTask(origin: string, runner: PlayedRunner): Promise<Task> {
  return eventually("a task for the runner", async () => {
    const answer = decodeFetchTaskResponse(
      await call(origin, "FetchTask", encodeFetchTaskRequest({ tasksVersion: 0 }), runner),
    );
    return answer.task;
  });
}

/**
 * Sends `rows` from row `from`, as many requests as the bounds take, each
 * acknowledged in full; the last says it ends the log when `ends`.
 */
export async function sendLog(
  origin: string,
  runner: PlayedRunner,
  taskId: number,
  rows: readonly LogRow[],
  from = 0,
  ends = true,
): Promise<void> {
  let index = from;
  while (index - from < rows.length) {
    const batch: LogRow[] = [];
    let bytes = 0;
    while (index - from + batch.length < rows.length && batch.length < ROWS_A_REQUEST) {
      const row = rows[index - from + batch.length] as LogRow;
      bytes += row.content.length * 3 + 32;
      if (bytes > BYTES_A_REQUEST && batch.length > 0) break;
      batch.push(row);
    }
    const { ackIndex } = decodeUpdateLogResponse(
      await call(
        origin,
        "UpdateLog",
        encodeUpdateLogRequest({
          taskId,
          index,
          rows: batch,
          noMore: ends && index - from + batch.length === rows.length,
        }),
        runner,
      ),
    );
    expect(ackIndex).toBe(index + batch.length);
    index = ackIndex;
  }
}

/** Reports the task finished with `result` (1 success, 2 failure) and its steps. */
export async function finishTask(
  origin: string,
  runner: PlayedRunner,
  taskId: number,
  result: number,
  steps: readonly StepState[],
): Promise<void> {
  const now = { seconds: Math.floor(Date.now() / 1000), nanos: 0 };
  await call(
    origin,
    "UpdateTask",
    encodeUpdateTaskRequest({
      state: {
        id: taskId,
        result,
        startedAt: now,
        stoppedAt: now,
        steps: [],
        reportedSteps: [...steps],
      },
      outputs: new Map(),
    }),
    runner,
  );
}
