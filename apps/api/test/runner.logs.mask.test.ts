// Masking job logs before they are stored: the task's job token and the
// values its rows register with `::add-mask::` are replaced by `***` in every
// stored line, in its encoded forms too, whole or split across rows, requests and
// resets. A log that closes drops its masks: at once when it completes, 10
// minutes after the task ended when it ends incomplete, after which its rows
// are refused.
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { buildVariants } from "@fyrden/domain/ci";
import { describe, expect, it } from "vitest";
import { type LogRow, Result } from "../src/runner/proto/messages.js";
import { insertPlainMask, openedMasksOf } from "./helpers/log-masks.js";
import {
  decodeFetchTaskResponse,
  decodeUpdateLogResponse,
  encodeFetchTaskRequest,
  encodeUpdateLogRequest,
} from "./helpers/runner-proto.js";
import {
  type Credentials,
  connectError,
  fetchTask,
  gate,
  jobTokenOf,
  jobTokensOf,
  orgRepo,
  pendingOf,
  proto,
  registerRunner,
  runnerCall,
  taskRow,
  tasksVersionOf,
  updateTask,
} from "./helpers/runners.js";
import {
  advance,
  at,
  drain,
  inRun,
  job,
  jobNamed,
  now,
  runStub,
  started,
  T0,
  workflow,
} from "./helpers/runs.js";
import { logs } from "./setup/log-capture.js";

const one = workflow(job("a"));
const MIN = 60_000;
const LATE_MS = 10 * MIN;

/** A run in a new organization, with a runner holding its first task. */
async function withTask(source = one) {
  const f = await orgRepo();
  const runId = await started(f, source);
  const runner = await registerRunner(f.org.login, f.owner);
  const task = (await fetchTask(runner, 0)).task;
  if (!task) throw new Error("no task");
  const number = (await taskRow(task.id))?.task;
  if (typeof number !== "number") throw new Error("the task was not recorded");
  return { f, runId, runner, task, number, token: jobTokenOf(task) };
}

async function withTwoTasks() {
  const first = await withTask(workflow([job("a"), job("b")].join("\n")));
  await updateTask(first.runner, first.task.id);
  const runner = await registerRunner(first.f.org.login, first.f.owner);
  const task = (await fetchTask(runner, 0)).task;
  if (!task) throw new Error("no second task");
  const number = (await taskRow(task.id))?.task;
  if (typeof number !== "number") throw new Error("the second task was not recorded");
  expect(task.id).not.toBe(first.task.id);
  return { first, second: { runner, task, number } };
}

const row = (content: string): LogRow => ({ content });
/** Filler rows `[from, from + n)`. */
const filler = (from: number, n: number): LogRow[] =>
  Array.from({ length: n }, (_, k) => row(`line ${from + k}`));

type LogRequest = { taskId: number; index: number; rows?: LogRow[]; noMore?: boolean };

const sendLog = (runner: Credentials, request: LogRequest) =>
  runnerCall("UpdateLog", encodeUpdateLogRequest(request), { credentials: runner });

async function ackOf(runner: Credentials, request: LogRequest): Promise<number> {
  return decodeUpdateLogResponse(await proto(await sendLog(runner, request))).ackIndex;
}

interface Line {
  i: number;
  t: number | null;
  c: string;
}

/** The stored lines of every chunk the manifest names, checked contiguous and never repeated. */
async function storedLines(runId: string, task: number): Promise<Line[]> {
  const chunks = await inRun(runId, (r) =>
    r.engine.rows<{ start_index: number; end_index: number; r2_key: string }>(
      "SELECT start_index, end_index, r2_key FROM ci_log_chunks WHERE task = ? ORDER BY start_index",
      task,
    ),
  );
  const lines: Line[] = [];
  let next = 0;
  for (const chunk of chunks) {
    expect(chunk.start_index).toBe(next);
    const object = await env.CI.get(chunk.r2_key);
    if (!object) throw new Error(`the manifest names ${chunk.r2_key}, which is not stored`);
    const chunkLines = (await object.text())
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Line);
    expect(chunkLines.map((line) => line.i)).toEqual(
      Array.from({ length: chunk.end_index - chunk.start_index }, (_, i) => chunk.start_index + i),
    );
    lines.push(...chunkLines);
    next = chunk.end_index;
  }
  expect(lines.map((l) => l.i)).toEqual(Array.from({ length: lines.length }, (_, i) => i));
  return lines;
}

const contents = async (runId: string, task: number) =>
  (await storedLines(runId, task)).map((l) => l.c);

/** Every R2 object written under the task's prefix, as text (chunks the manifest names or not). */
async function everyObject(runId: string, task: number): Promise<string> {
  const listed = await env.CI.list({ prefix: `runs/${runId}/` });
  const texts: string[] = [];
  for (const o of listed.objects) {
    if (o.key.split("/")[4] !== String(task)) continue;
    texts.push((await (await env.CI.get(o.key))?.text()) ?? "");
  }
  return texts.join("\n");
}

/** No form of `value` the masker covers appears in `text`. */
function expectNoForm(text: string, value: string) {
  for (const variant of buildVariants(value)) expect(text).not.toContain(variant.text);
}

/** The task's masks, their values opened (they are sealed at rest). */
const masksOf = (runId: string, task: number) => openedMasksOf(runId, task);

const logOf = (runId: string, task: number) =>
  inRun(
    runId,
    (r) =>
      r.engine.rows<{
        ack_index: number;
        state: string;
        mask_carry: string | null;
        ended_at: number | null;
      }>("SELECT ack_index, state, mask_carry, ended_at FROM ci_logs WHERE task = ?", task)[0],
  );

/** A reset: the next request finds a new instance, with nothing in memory. */
async function reset(runId: string) {
  await evictDurableObject(runStub(runId));
  await at(runId, now(runId));
}

async function waitAtGate(held: ReturnType<typeof gate>, request: Promise<unknown>): Promise<void> {
  await Promise.race([
    held.started,
    request.then((answer) => {
      const status =
        typeof answer === "object" && answer !== null && "status" in answer
          ? ` (${String(answer.status)})`
          : "";
      throw new Error(`The request settled before its gate${status}.`);
    }),
  ]);
}

describe("a masking race's gate wait", () => {
  it("reports an early response instead of waiting for a gate it never reaches", async () => {
    await expect(
      waitAtGate(gate(), Promise.resolve(new Response(null, { status: 503 }))),
    ).rejects.toThrow("before its gate (503)");
  });

  it("preserves a request error before its gate", async () => {
    const failure = new Error("assignment failed before mint");
    await expect(waitAtGate(gate(), Promise.reject(failure))).rejects.toBe(failure);
  });
});

async function releaseHeld(
  runId: string,
  holds: readonly ReturnType<typeof gate>[],
  pending: readonly Promise<unknown>[],
): Promise<void> {
  for (const held of holds) held.release();
  try {
    await Promise.allSettled(pending);
  } finally {
    await inRun(runId, (r) => {
      r.hooks = {};
    });
  }
}

/** The `ci.mask_dropped` points written while `fn` runs, as [run, task, reason, value]. */
async function maskDropped(fn: () => Promise<void>): Promise<[string, string, string, number][]> {
  const dataset = env.METRICS as unknown as { writeDataPoint: (point: unknown) => void };
  const write = dataset.writeDataPoint;
  const seen: [string, string, string, number][] = [];
  dataset.writeDataPoint = (point: unknown) => {
    const p = point as { indexes?: string[]; blobs?: string[]; doubles?: number[] };
    if (p.indexes?.[0] === "ci.mask_dropped") {
      const [run = "", task = "", reason = ""] = p.blobs ?? [];
      seen.push([run, task, reason, p.doubles?.[0] ?? 0]);
    }
    write.call(dataset, point);
  };
  try {
    await fn();
  } finally {
    dataset.writeDataPoint = write;
  }
  return seen;
}

describe("the job token", () => {
  it("is registered for the task before the task is answered, once", async () => {
    const { runId, number, token } = await withTask();
    expect(await masksOf(runId, number)).toEqual([
      { seq: 0, kind: "job_token", from_index: 0, value: token },
    ]);
  });

  it("is masked plainly, base64-encoded at three alignments, inside JSON and inside a URL", async () => {
    const { runId, runner, task, number, token } = await withTask();
    const printed = [
      `token=${token}`,
      btoa(token),
      `x ${btoa(`x${token}`)} y`,
      btoa(`xx${token}`),
      JSON.stringify({ auth: { token } }),
      `https://x-access-token:${encodeURIComponent(token)}@example.com/o/r.git`,
    ];
    const rows = [...printed.map(row), ...filler(printed.length, 50 - printed.length)];
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows })).toBe(50);
    const lines = await contents(runId, number);
    expectNoForm(lines.join("\n"), token);
    for (const line of lines.slice(0, printed.length)) expect(line).toContain("***");
    expect(lines[0]).toBe("token=***");
    expect(lines[4]).toBe('{"auth":{"token":"***"}}');
    expect(lines[5]).toBe("https://x-access-token:***@example.com/o/r.git");
    expect(lines.slice(printed.length)).toEqual(
      filler(printed.length, 50 - printed.length).map((r) => r.content),
    );
  });

  it("re-minted for a lost answer is registered beside the first, and both are masked", async () => {
    const { runId, runner, lost, number, version } = await lostAnswer();
    const again = (await fetchTask(runner, version)).task;
    if (!again) throw new Error("no task");
    expect(again.id).toBe(lost.id);
    const first = jobTokenOf(lost);
    const second = jobTokenOf(again);
    expect(second).not.toBe(first);
    expect(await masksOf(runId, number)).toEqual([
      { seq: 0, kind: "job_token", from_index: 0, value: first },
      { seq: 1, kind: "job_token", from_index: 0, value: second },
    ]);
    const rows = [row(`new ${second}`), row(`old ${first}`), ...filler(2, 48)];
    expect(await ackOf(runner, { taskId: again.id, index: 0, rows })).toBe(50);
    expect((await contents(runId, number)).slice(0, 2)).toEqual(["new ***", "old ***"]);
  });

  it("past 8 tokens, a poll returns no task without minting another token", async () => {
    const { runId, runner, lost, number, version } = await lostAnswer();
    for (let i = 0; i < 7; i++) expect((await fetchTask(runner, version)).task?.id).toBe(lost.id);
    expect((await masksOf(runId, number)).filter((m) => m.kind === "job_token")).toHaveLength(8);
    const minted = (await jobTokensOf(lost.id)).length;
    expect(minted).toBe(8);
    for (let i = 0; i < 2; i++) {
      expect((await fetchTask(runner, version)).task).toBeUndefined();
    }
    expect((await jobTokensOf(lost.id)).length).toBe(minted);
    expect((await masksOf(runId, number)).filter((m) => m.kind === "job_token")).toHaveLength(8);
  });

  for (const first of ["A", "B"] as const) {
    it(`two re-offers racing for the 8th token, ${first} released first: the answered token stays live, and only it`, async () => {
      const { runId, runner, lost, number, version } = await lostAnswer();
      for (let i = 0; i < 6; i++) expect((await fetchTask(runner, version)).task?.id).toBe(lost.id);
      expect((await masksOf(runId, number)).filter((m) => m.kind === "job_token")).toHaveLength(7);
      const gates = { A: gate(), B: gate() };
      let calls = 0;
      await inRun(runId, (r) => {
        r.hooks = { afterMint: () => (calls++ === 0 ? gates.A : gates.B).hold() };
      });
      // Each answer is read in the chain that sent it: the test resumes inside the run object
      // after a hook, where another request's body cannot be read.
      const call = () =>
        runnerCall("FetchTask", encodeFetchTaskRequest({ tasksVersion: version }), {
          credentials: runner,
        }).then(async (res) => ({
          status: res.status,
          task: res.status === 200 ? decodeFetchTaskResponse(await proto(res)).task : undefined,
        }));
      // A minted first; B minted second, after A's token was recorded for the task.
      const pending: Promise<unknown>[] = [];
      try {
        const a = call();
        pending.push(a);
        await waitAtGate(gates.A, a);
        const b = call();
        pending.push(b);
        await waitAtGate(gates.B, b);
        const answers = { A: a, B: b };
        const second = first === "A" ? "B" : "A";
        gates[first].release();
        const won = await answers[first];
        expect(won.status).toBe(200);
        const delivered = won.task;
        gates[second].release();
        const lostRace = await answers[second];
        await inRun(runId, (r) => {
          r.hooks = {};
        });
        expect(lostRace.status).toBe(200);
        expect(lostRace.task).toBeUndefined();
        if (!delivered) throw new Error("no task");
        const token = jobTokenOf(delivered);
        expect(await revokedAt(token)).toBeNull();
        const tokens = await jobTokensOf(lost.id);
        expect(tokens).toHaveLength(9);
        expect(tokens.filter((t) => t.revoked_at === null)).toHaveLength(1);
        expect((await masksOf(runId, number)).filter((m) => m.kind === "job_token")).toHaveLength(
          8,
        );
      } finally {
        await releaseHeld(runId, [gates.A, gates.B], pending);
      }
    });
  }

  it("a re-offer whose token cannot be registered revokes that token and keeps the earlier one", async () => {
    const { runId, runner, lost, number, version } = await lostAnswer();
    await inRun(runId, (r) => {
      r.hooks = {
        beforeTokenMask: () => {
          throw new Error("the mask write failed");
        },
      };
    });
    const res = await runnerCall("FetchTask", encodeFetchTaskRequest({ tasksVersion: version }), {
      credentials: runner,
    });
    await inRun(runId, (r) => {
      r.hooks = {};
    });
    await connectError(res, "unavailable", 503);
    const tokens = await jobTokensOf(lost.id);
    expect(tokens).toHaveLength(2);
    expect(tokens.map((t) => t.revoked_at === null)).toEqual([true, false]);
    const earlier = jobTokenOf(lost);
    expect(await revokedAt(earlier)).toBeNull();
    expect(await masksOf(runId, number)).toEqual([
      { seq: 0, kind: "job_token", from_index: 0, value: earlier },
    ]);
  });

  it("re-offers finishing out of order: the token the runner read is masked, and the other too", async () => {
    const { runId, runner, lost, number, version } = await lostAnswer();
    const held = gate();
    let calls = 0;
    await inRun(runId, (r) => {
      r.hooks = { afterMint: () => (++calls === 1 ? held.hold() : undefined) };
    });
    // An assignment that outlives its poll; the runner polls again and reads the second.
    const pending: Promise<unknown>[] = [];
    try {
      const slow = fetchTask(runner, version);
      pending.push(slow);
      await waitAtGate(held, slow);
      const received = (await fetchTask(runner, version)).task;
      if (!received) throw new Error("no task");
      held.release();
      const discarded = (await slow).task;
      if (!discarded) throw new Error("no task");
      await inRun(runId, (r) => {
        r.hooks = {};
      });
      const token = jobTokenOf(received);
      expect((await masksOf(runId, number)).map((m) => m.value)).toEqual([
        jobTokenOf(lost),
        token,
        jobTokenOf(discarded),
      ]);
      const rows = [row(`credential=${token}`)];
      expect(await ackOf(runner, { taskId: received.id, index: 0, rows, noMore: true })).toBe(1);
      expect(await contents(runId, number)).toEqual(["credential=***"]);
      expect((await everyObject(runId, number)).includes(token)).toBe(false);
    } finally {
      await releaseHeld(runId, [held], pending);
    }
  });

  it("re-offered while a forced store of a token's prefix is being written: the stored carry still masks the suffix", async () => {
    const { runId, runner, number, version } = await lostAnswer();
    const held = gate();
    const put = gate();
    let calls = 0;
    await inRun(runId, (r) => {
      r.hooks = { afterMint: () => (++calls === 1 ? held.hold() : undefined) };
    });
    const pending: Promise<unknown>[] = [];
    try {
      const slow = fetchTask(runner, version);
      pending.push(slow);
      await waitAtGate(held, slow);
      const received = (await fetchTask(runner, version)).task;
      if (!received) throw new Error("no task");
      const token = jobTokenOf(received);
      const rows = [row("start"), row(`credential=${token.slice(0, 20)}`)];
      await at(runId, T0 + 1_000);
      expect(await ackOf(runner, { taskId: received.id, index: 0, rows })).toBe(0);
      await at(runId, T0 + 16_000);
      await inRun(runId, (r) => {
        r.hooks.afterLogPut = () => put.hold();
      });
      const storing = ackOf(runner, { taskId: received.id, index: 0, rows });
      pending.push(storing);
      await waitAtGate(put, storing);
      held.release();
      await slow;
      await inRun(runId, (r) => {
        r.hooks = {};
      });
      put.release();
      expect(await storing).toBe(2);
      const rest = [row(`${token.slice(20)} tail`), ...filler(3, 49)];
      expect(await ackOf(runner, { taskId: received.id, index: 2, rows: rest })).toBe(52);
      expect((await contents(runId, number)).slice(0, 3)).toEqual([
        "start",
        "credential=***",
        "*** tail",
      ]);
    } finally {
      await releaseHeld(runId, [held, put], pending);
    }
  });

  it("refuses a re-offer confirmed while the log completes and keeps its masks deleted", async () => {
    const { runId, runner, lost, number, version } = await lostAnswer();
    const held = gate();
    await inRun(runId, (r) => {
      r.hooks = { afterMint: () => held.hold() };
    });
    const pending: Promise<unknown>[] = [];
    try {
      const reoffer = fetchTask(runner, version);
      pending.push(reoffer);
      await waitAtGate(held, reoffer);
      expect(
        await ackOf(runner, { taskId: lost.id, index: 0, rows: filler(0, 3), noMore: true }),
      ).toBe(3);
      expect(await masksOf(runId, number)).toEqual([]);
      held.release();
      const again = (await reoffer).task;
      expect(again).toBeUndefined();
      await inRun(runId, (r) => {
        r.hooks = {};
      });
      expect(await masksOf(runId, number)).toEqual([]);
      await updateTask(runner, lost.id, Result.SUCCESS);
      await advance(runId, LATE_MS);
      expect(await masksOf(runId, number)).toEqual([]);
    } finally {
      await releaseHeld(runId, [held], pending);
    }
  });

  it("add-mask values filling the caps leave room for 8 job tokens", async () => {
    const { runId, runner, lost, number, version } = await lostAnswer();
    const first = jobTokenOf(lost);
    const cap = 16 * 1024;
    // Three 4,000-byte values and one that would fill the cap beside the first token alone.
    const sizes = [4_000, 4_000, 4_000, cap - first.length - 12_000];
    const values = sizes.map((n, k) => {
      const c = "PQRS".charAt(k);
      return `${c}-${c.repeat(n - 2)}`;
    });
    // Seven re-offers each minted a token and are paused before registering it.
    const gates = Array.from({ length: 7 }, () => gate());
    let calls = 0;
    await inRun(runId, (r) => {
      r.hooks = { afterMint: () => gates[calls++]?.hold() };
    });
    const reoffers = [];
    try {
      for (const g of gates) {
        const reoffer = fetchTask(runner, version);
        reoffers.push(reoffer);
        await waitAtGate(g, reoffer);
      }
      const rows = [...values.map((v) => row(`::add-mask::${v}`)), ...filler(4, 46)];
      expect(await ackOf(runner, { taskId: lost.id, index: 0, rows })).toBe(50);
      expect((await masksOf(runId, number)).map((m) => m.kind)).toEqual([
        "job_token",
        "add_mask",
        "add_mask",
        "add_mask",
      ]);
      for (const g of gates) g.release();
      const answered = await Promise.all(reoffers);
      await inRun(runId, (r) => {
        r.hooks = {};
      });
      expect(answered.every((answer) => answer.task === undefined)).toBe(true);
      expect(await revokedAt(first)).toBeNull();
      const masks = await masksOf(runId, number);
      expect(masks.filter((m) => m.kind === "job_token")).toHaveLength(8);
      expect(masks.length).toBeLessThanOrEqual(256);
      const bytes = masks.reduce((n, m) => n + new TextEncoder().encode(m.value).length, 0);
      expect(bytes).toBeLessThanOrEqual(cap);
      expect(
        await ackOf(runner, {
          taskId: lost.id,
          index: 50,
          rows: [row(`t ${first}`)],
          noMore: true,
        }),
      ).toBe(51);
      expect((await contents(runId, number))[50]).toBe("t ***");
    } finally {
      await releaseHeld(runId, gates, reoffers);
    }
  });

  it("split across two rows of one request is masked in both", async () => {
    const { runId, runner, task, number, token } = await withTask();
    const rows = [row(`a ${token.slice(0, 20)}`), row(`${token.slice(20)} b`), ...filler(2, 48)];
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows })).toBe(50);
    expect((await contents(runId, number)).slice(0, 2)).toEqual(["a ***", "*** b"]);
  });

  it("split across two requests: the first part's row is held unacked, then both are stored masked", async () => {
    const { runId, runner, task, number, token } = await withTask();
    const head = row(`token: ${token.slice(0, 20)}`);
    const first = [...filler(0, 49), head];
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: first })).toBe(49);
    expect((await logOf(runId, number))?.mask_carry).toBeNull();
    const rest = [head, row(`${token.slice(20)} end`), ...filler(51, 49)];
    expect(await ackOf(runner, { taskId: task.id, index: 49, rows: rest })).toBe(100);
    const lines = await contents(runId, number);
    expect(lines.slice(48, 51)).toEqual(["line 48", "token: ***", "*** end"]);
    expect(lines).toHaveLength(100);
    expectNoForm(await everyObject(runId, number), token);
  });

  it("split across a reset: the runner resends from its ack and the value is masked, contiguous, once", async () => {
    const { runId, runner, task, number, token } = await withTask();
    const head = row(`token: ${token.slice(0, 20)}`);
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: [...filler(0, 49), head] })).toBe(
      49,
    );
    await reset(runId);
    const rest = [head, row(`${token.slice(20)} end`), ...filler(51, 49)];
    expect(await ackOf(runner, { taskId: task.id, index: 49, rows: rest })).toBe(100);
    const lines = await contents(runId, number);
    expect(lines).toHaveLength(100);
    expect(lines.slice(49, 51)).toEqual(["token: ***", "*** end"]);
    expectNoForm(await everyObject(runId, number), token);
  });

  it("keeps the first-seen clock when a partial masked flush fails before commit", async () => {
    const { runId, runner, task, number, token } = await withTask();
    const rows = [...filler(0, 49), row(`token: ${token.slice(0, 20)}`)];
    await at(runId, T0 + 1_000);
    await inRun(runId, (r) => {
      r.hooks.afterLogPut = () => {
        throw new Error("write failed before manifest commit");
      };
    });
    try {
      expect((await sendLog(runner, { taskId: task.id, index: 0, rows })).status).toBe(503);
    } finally {
      await inRun(runId, (r) => {
        r.hooks = {};
      });
    }
    expect((await logOf(runId, number))?.ack_index ?? 0).toBe(0);
    await at(runId, T0 + 1_000 + 15_000);
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows })).toBe(50);
    expect((await contents(runId, number))[49]).toBe("token: ***");
  });

  it("forced out by age: the stored prefix is masked, and the next row's suffix through the stored carry, across a reset", async () => {
    const { runId, runner, task, number, token } = await withTask();
    const rows = [row("start"), row(`token: ${token.slice(0, 20)}`)];
    await at(runId, T0 + 1_000);
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows })).toBe(0);
    await at(runId, T0 + 1_000 + 15_000);
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows })).toBe(2);
    expect(await contents(runId, number)).toEqual(["start", "token: ***"]);
    const carry = (await logOf(runId, number))?.mask_carry;
    expect(carry).not.toBeNull();
    expect(carry).not.toContain(token.slice(0, 4));
    await reset(runId);
    const rest = [row(`${token.slice(20)} tail`), ...filler(3, 49)];
    expect(await ackOf(runner, { taskId: task.id, index: 2, rows: rest })).toBe(52);
    expect((await contents(runId, number)).slice(0, 3)).toEqual([
      "start",
      "token: ***",
      "*** tail",
    ]);
    expect((await logOf(runId, number))?.mask_carry).toBeNull();
    expectNoForm(await everyObject(runId, number), token);
  });
});

describe("persisted mask activation", () => {
  it("keeps a later mask out of the earlier carried prefix after a reset", async () => {
    const { runId, runner, task, number } = await withTask();
    await inRun(runId, (r) => {
      insertPlainMask(r, number, "add_mask", 48, "XabcdefghZ", 1);
      insertPlainMask(r, number, "add_mask", 49, "abcdefgh", 2);
    });
    expect(
      await ackOf(runner, {
        taskId: task.id,
        index: 0,
        rows: [...filler(0, 48), row("Xa"), row("b")],
      }),
    ).toBe(50);
    const stored = (await logOf(runId, number))?.mask_carry;
    expect(JSON.parse(stored ?? "null")).toMatchObject({
      mask: 1,
      length: 3,
      starts: [{ index: 49, offset: -1 }],
    });
    await reset(runId);
    expect(
      await ackOf(runner, {
        taskId: task.id,
        index: 50,
        rows: [row("cdefgh SAFE"), ...filler(51, 49)],
      }),
    ).toBe(100);
    expect((await contents(runId, number)).slice(48, 51)).toEqual(["Xa", "b", "cdefgh SAFE"]);
  });
});

describe("::add-mask::", () => {
  it("masks the value in later rows and its own, not in rows before it", async () => {
    const { runId, runner, task, number } = await withTask();
    const value = "s3cr3t-Value-0042";
    expect(
      await ackOf(runner, {
        taskId: task.id,
        index: 0,
        rows: [row(`early ${value}`), ...filler(1, 49)],
      }),
    ).toBe(50);
    const rows = [
      row(`before ${value}`),
      row(`::add-mask::${value}`),
      row(`after ${value}`),
      ...filler(53, 47),
    ];
    expect(await ackOf(runner, { taskId: task.id, index: 50, rows })).toBe(100);
    const lines = await contents(runId, number);
    expect(lines[0]).toBe(`early ${value}`);
    expect(lines.slice(50, 53)).toEqual([`before ${value}`, "::add-mask::***", "after ***"]);
    expect((await masksOf(runId, number)).slice(1)).toEqual([
      { seq: 1, kind: "add_mask", from_index: 51, value },
    ]);
    // Later requests mask it from storage.
    expect(
      await ackOf(runner, {
        taskId: task.id,
        index: 100,
        rows: [row(`late ${value}`)],
        noMore: true,
      }),
    ).toBe(101);
    expect((await contents(runId, number))[100]).toBe("late ***");
  });

  it("unescapes the value as the runner does, and stores the command row masked", async () => {
    const { runId, runner, task, number } = await withTask();
    const rows = [row("::add-mask::p%25q-secret-77"), row("got p%q-secret-77!"), ...filler(2, 48)];
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows })).toBe(50);
    expect((await contents(runId, number)).slice(0, 2)).toEqual(["::add-mask::***", "got ***!"]);
  });

  it("of a multi-line value masks each of its lines printed as rows", async () => {
    const { runId, runner, task, number } = await withTask();
    const pem = ["-----BEGIN KEY-----", "MIIEvQIBADANBgkqhkiG9w0BAQEF", "-----END KEY-----"];
    const rows = [row(`::add-mask::${pem.join("%0A")}`), ...pem.map(row), ...filler(4, 46)];
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows })).toBe(50);
    expect((await contents(runId, number)).slice(0, 4)).toEqual([
      "::add-mask::***",
      "***",
      "***",
      "***",
    ]);
  });

  it("registered and then split by a forced store has its suffix masked through the carry, across a reset", async () => {
    const { runId, runner, task, number } = await withTask();
    const value = "added-secret-ABCDEFGHIJ";
    const rows = [row(`::add-mask::${value}`), row(`v ${value.slice(0, 10)}`)];
    await at(runId, T0 + 1_000);
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows })).toBe(0);
    await at(runId, T0 + 1_000 + 15_000);
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows })).toBe(2);
    expect(await contents(runId, number)).toEqual(["::add-mask::***", "v ***"]);
    expect(JSON.parse((await logOf(runId, number))?.mask_carry ?? "null")).toMatchObject({
      mask: 1,
      length: 10,
    });
    await reset(runId);
    const rest = [row(`${value.slice(10)} x`), ...filler(3, 49)];
    expect(await ackOf(runner, { taskId: task.id, index: 2, rows: rest })).toBe(52);
    expect((await contents(runId, number))[2]).toBe("*** x");
  });

  it("past the value cap is not registered, logged without its value, and its row still masked", async () => {
    const { runId, runner, task, number } = await withTask();
    // Eight values are kept for job tokens: 248 more fit.
    const values = Array.from(
      { length: 249 },
      (_, i) => `capped-value-${String(i).padStart(4, "0")}`,
    );
    const rows = [...values.map((v) => row(`::add-mask::${v}`)), row(values.join(" "))];
    const dropped = await maskDropped(async () => {
      expect(await ackOf(runner, { taskId: task.id, index: 0, rows, noMore: true })).toBe(250);
    });
    expect(dropped).toEqual([[runId, String(number), "values", 1]]);
    const lines = await contents(runId, number);
    expect(lines.slice(0, 249).every((l) => l === "::add-mask::***")).toBe(true);
    const last = values.at(-1) as string;
    expect(lines[249]).toBe(`${Array.from({ length: 248 }, () => "***").join(" ")} ${last}`);
    const warned = logs.entries().filter((e) => e.msg === "mask value not registered");
    expect(warned).toEqual([
      expect.objectContaining({ level: "warn", task: number, index: 248, reason: "values" }),
    ]);
    expect(logs.lines.filter((l) => values.some((v) => l.includes(v)))).toEqual([]);
  });

  it("registered while the first token is still being assigned, keeps room for it", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner);
    const runId = await started(f, one);
    const held = gate();
    await inRun(runId, (r) => {
      r.hooks = { afterMint: () => held.hold() };
    });
    const pending: Promise<unknown>[] = [];
    try {
      const assigning = fetchTask(runner, 0);
      pending.push(assigning);
      await waitAtGate(held, assigning);
      // The runner's assignment is recorded before its token is: rows can name it already.
      const task = await inRun(
        runId,
        (r) =>
          r.engine.rows<{ wire_id: number; task: number }>("SELECT wire_id, task FROM ci_tasks")[0],
      );
      if (!task) throw new Error("no task");
      const value = `K-${"X".repeat(16 * 1024 - 4)}-Z`;
      const rows = [row(`::add-mask::${value}`), ...filler(1, 49)];
      expect(await ackOf(runner, { taskId: task.wire_id, index: 0, rows })).toBe(50);
      held.release();
      expect((await assigning).task).toBeUndefined();
      await inRun(runId, (r) => {
        r.hooks = {};
      });
      const masks = await masksOf(runId, task.task);
      const bytes = masks.reduce((n, m) => n + new TextEncoder().encode(m.value).length, 0);
      expect(bytes).toBeLessThanOrEqual(16 * 1024);
      expect(masks.map((m) => m.kind)).toEqual(["job_token"]);
    } finally {
      await releaseHeld(runId, [held], pending);
    }
  });

  it("past 16 KiB of value text is not registered, logged and counted without its value", async () => {
    const { runId, runner, task, number, token } = await withTask();
    // 4,000-byte values (whole, under the 4 KiB line-only limit): beside room for 8 tokens, four
    // fit and the fifth would pass 16,384 bytes.
    const values = ["A", "B", "C", "D", "E"].map((c) => `${c}-${c.repeat(3_998)}`);
    expect(8 * token.length + 4 * 4_000).toBeLessThanOrEqual(16 * 1024);
    const rows = [
      ...values.map((v) => row(`::add-mask::${v}`)),
      row(`d ${values[3]}`),
      row(`e ${values[4]}`),
    ];
    const dropped = await maskDropped(async () => {
      expect(await ackOf(runner, { taskId: task.id, index: 0, rows, noMore: true })).toBe(7);
    });
    expect(dropped).toEqual([[runId, String(number), "bytes", 1]]);
    const lines = await contents(runId, number);
    expect(lines.slice(0, 5).every((l) => l === "::add-mask::***")).toBe(true);
    expect(lines.slice(5)).toEqual(["d ***", `e ${values[4]}`]);
    const warned = logs.entries().filter((e) => e.msg === "mask value not registered");
    expect(warned).toEqual([
      expect.objectContaining({ level: "warn", task: number, index: 4, reason: "bytes" }),
    ]);
    expect(logs.lines.filter((l) => l.includes("E".repeat(64)))).toEqual([]);
  });
});

describe("a closed log", () => {
  it("keeps the older runner's sentinel and the newer runner's empty final as they were", async () => {
    const a = await withTask();
    expect(await ackOf(a.runner, { taskId: a.task.id, index: 0, rows: filler(0, 50) })).toBe(50);
    expect(
      await ackOf(a.runner, { taskId: a.task.id, index: 50, rows: [row("")], noMore: true }),
    ).toBe(51);
    expect(await logOf(a.runId, a.number)).toMatchObject({ ack_index: 51, state: "complete" });
    expect(await contents(a.runId, a.number)).toHaveLength(50);
    const b = await withTask();
    expect(await ackOf(b.runner, { taskId: b.task.id, index: 0, rows: filler(0, 50) })).toBe(50);
    expect(await ackOf(b.runner, { taskId: b.task.id, index: 50, rows: [], noMore: true })).toBe(
      50,
    );
    expect(await logOf(b.runId, b.number)).toMatchObject({ ack_index: 50, state: "complete" });
  });

  it("complete: its masks and carry are deleted with the final store, and a later request stores nothing", async () => {
    const { runId, runner, task, number, token } = await withTask();
    const rows = [row("::add-mask::another-secret-1"), row(token), ...filler(2, 3)];
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows, noMore: true })).toBe(5);
    expect(await logOf(runId, number)).toMatchObject({ state: "complete", mask_carry: null });
    expect(await masksOf(runId, number)).toEqual([]);
    expect(
      await ackOf(runner, { taskId: task.id, index: 5, rows: [row(token), ...filler(6, 60)] }),
    ).toBe(5);
    expect(await contents(runId, number)).toEqual([
      "::add-mask::***",
      "***",
      ...filler(2, 3).map((r) => r.content),
    ]);
    expect(await masksOf(runId, number)).toEqual([]);
  });

  it("incomplete: takes rows masked for 10 minutes after its task ended, then refuses them; the close job deletes its masks", async () => {
    const { runId, runner, task, number, token } = await withTask();
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows: filler(0, 10) })).toBe(0);
    await at(runId, T0 + MIN);
    await updateTask(runner, task.id, Result.SUCCESS);
    expect(await logOf(runId, number)).toMatchObject({ state: "incomplete", ended_at: T0 + MIN });
    await at(runId, T0 + MIN + LATE_MS - 1);
    const rows = [...filler(0, 10), row(`late ${token}`), ...filler(11, 39)];
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows })).toBe(50);
    expect((await contents(runId, number))[10]).toBe("late ***");
    expect((await masksOf(runId, number)).length).toBe(1);
    await at(runId, T0 + MIN + LATE_MS);
    await connectError(
      await sendLog(runner, { taskId: task.id, index: 50, rows: filler(50, 50) }),
      "not_found",
      404,
    );
    expect((await logOf(runId, number))?.ack_index).toBe(50);
    expect(await runDurableObjectAlarm(runStub(runId))).toBe(true);
    expect(await masksOf(runId, number)).toEqual([]);
    expect((await logOf(runId, number))?.mask_carry).toBeNull();
  });

  it("deletes expired masks while preserving a streaming task in the same run", async () => {
    const { first, second } = await withTwoTasks();
    const { runId } = first;
    expect(
      await ackOf(second.runner, {
        taskId: second.task.id,
        index: 0,
        rows: filler(0, 50),
      }),
    ).toBe(50);
    const streamingMasks = await masksOf(runId, second.number);
    expect(streamingMasks.length).toBeGreaterThan(0);
    await at(runId, T0 + MIN);
    await updateTask(first.runner, first.task.id, Result.SUCCESS);
    await at(runId, T0 + MIN + LATE_MS);
    await updateTask(second.runner, second.task.id);
    await drain(runId);
    expect(await masksOf(runId, first.number)).toEqual([]);
    expect((await logOf(runId, second.number))?.state).toBe("streaming");
    expect(await masksOf(runId, second.number)).toEqual(streamingMasks);
  });

  it("retains the later close deadline when masks arrive after the earlier cleanup", async () => {
    const { first, second } = await withTwoTasks();
    const { runId } = first;
    await at(runId, T0 + MIN);
    await updateTask(first.runner, first.task.id, Result.SUCCESS);
    await inRun(runId, (r) => {
      r.engine.exec("DELETE FROM ci_log_masks WHERE task = ?", second.number);
    });
    await at(runId, T0 + 2 * MIN);
    await updateTask(second.runner, second.task.id, Result.SUCCESS);
    expect(await masksOf(runId, second.number)).toEqual([]);
    await at(runId, T0 + MIN + LATE_MS);
    await drain(runId);
    expect(await masksOf(runId, first.number)).toEqual([]);
    expect(await masksOf(runId, second.number)).toEqual([]);
    const value = "late-window-registered-value";
    expect(
      await ackOf(second.runner, {
        taskId: second.task.id,
        index: 0,
        rows: [row(`::add-mask::${value}`), ...filler(1, 49)],
      }),
    ).toBe(50);
    expect((await contents(runId, second.number))[0]).toBe("::add-mask::***");
    expect((await masksOf(runId, second.number)).map((m) => m.value)).toEqual([value]);
    await at(runId, T0 + 2 * MIN + LATE_MS);
    await drain(runId);
    expect(await masksOf(runId, second.number)).toEqual([]);
  });

  for (const [how, end] of [
    [
      "a forced cancel",
      async (runId: string, f: Awaited<ReturnType<typeof withTask>>["f"]) => {
        await runStub(runId).cancel(f.owner.principalId, "force");
        await drain(runId);
      },
    ],
    [
      "a lost heartbeat",
      async (runId: string) => {
        await advance(runId, 10 * MIN);
      },
    ],
  ] as const) {
    it(`completed by a whole final, then ended by ${how}: the job's log stays complete`, async () => {
      const { f, runId, runner, task, number } = await withTask();
      expect(
        await ackOf(runner, { taskId: task.id, index: 0, rows: filler(0, 3), noMore: true }),
      ).toBe(3);
      expect((await logOf(runId, number))?.state).toBe("complete");
      await end(runId, f);
      expect(await jobNamed(runId, "a")).toMatchObject({ status: "completed", logComplete: true });
      expect((await logOf(runId, number))?.state).toBe("complete");
    });
  }

  for (const [how, end] of [
    [
      "a forced cancel",
      async (runId: string, f: Awaited<ReturnType<typeof withTask>>["f"]) => {
        await runStub(runId).cancel(f.owner.principalId, "force");
        await drain(runId);
        return now(runId);
      },
    ],
    [
      "a lost heartbeat",
      async (runId: string) => {
        await advance(runId, 10 * MIN);
        return now(runId);
      },
    ],
    [
      "an expired cancel grace",
      async (runId: string, f: Awaited<ReturnType<typeof withTask>>["f"]) => {
        await runStub(runId).cancel(f.owner.principalId, "graceful");
        await drain(runId);
        await advance(runId, 2 * MIN);
        return now(runId);
      },
    ],
  ] as const) {
    it(`ended by ${how}, with no report from the runner: ended incomplete, masks deleted after the window`, async () => {
      const { f, runId, runner, task, number } = await withTask();
      expect(await ackOf(runner, { taskId: task.id, index: 0, rows: filler(0, 3) })).toBe(0);
      const ended = await end(runId, f);
      expect(
        await inRun(
          runId,
          (r) =>
            r.engine.rows<{ status: string }>(
              "SELECT status FROM run_instances WHERE task = ?",
              number,
            )[0],
        ),
      ).toEqual({ status: "completed" });
      expect(await logOf(runId, number)).toMatchObject({ state: "incomplete", ended_at: ended });
      expect((await masksOf(runId, number)).length).toBe(1);
      await at(runId, ended + LATE_MS - 1);
      await drain(runId);
      expect((await masksOf(runId, number)).length).toBe(1);
      await advance(runId, 1);
      expect(await masksOf(runId, number)).toEqual([]);
      await connectError(
        await sendLog(runner, { taskId: task.id, index: 0, rows: filler(0, 50) }),
        "not_found",
        404,
      );
    });
  }
});

describe("masks", () => {
  it("are erased with the run", async () => {
    const { f, runId, runner, task, number } = await withTask();
    const rows = [row("::add-mask::erased-secret-9"), ...filler(1, 49)];
    expect(await ackOf(runner, { taskId: task.id, index: 0, rows })).toBe(50);
    expect((await masksOf(runId, number)).length).toBe(2);
    await runStub(runId).erase(f.repo.id);
    expect(await inRun(runId, (r) => r.engine.rows("SELECT * FROM ci_log_masks"))).toEqual([]);
  });

  it("never appear in a log line, nor does the job token", async () => {
    const { runId, runner, task, number, token } = await withTask();
    const value = "logged-never-secret-5";
    const head = row(`t ${token.slice(0, 20)}`);
    await ackOf(runner, {
      taskId: task.id,
      index: 0,
      rows: [row(`::add-mask::${value}`), ...filler(1, 48), head],
    });
    await reset(runId);
    await ackOf(runner, {
      taskId: task.id,
      index: 49,
      rows: [head, row(`${token.slice(20)} ${value}`)],
    });
    await ackOf(runner, {
      taskId: task.id,
      index: 49,
      rows: [head, row(token.slice(20))],
      noMore: true,
    });
    expect((await logOf(runId, number))?.state).toBe("complete");
    expect(
      logs.lines.filter(
        (l) => l.includes(token) || l.includes(token.slice(0, 20)) || l.includes(value),
      ),
    ).toEqual([]);
  });
});

/** A version the organization's runners were told of, with nothing pending: a poll at it may be a lost answer's repeat. */
async function primed(f: Awaited<ReturnType<typeof orgRepo>>): Promise<number> {
  const runId = await started(f, one);
  await runStub(runId).cancel(f.owner.principalId, "graceful");
  await drain(runId);
  expect(await pendingOf(runId)).toEqual([]);
  const version = await tasksVersionOf(f.org.id);
  expect(version).toBeGreaterThan(0);
  return version;
}

/** A run whose first task's answer was lost: the runner holds its task, and repeating `version` re-offers it. */
async function lostAnswer() {
  const f = await orgRepo();
  const runner = await registerRunner(f.org.login, f.owner);
  const version = await primed(f);
  const runId = await started(f, one);
  const lost = (await fetchTask(runner, version)).task;
  if (!lost) throw new Error("no task");
  const number = (await taskRow(lost.id))?.task as number;
  return { f, runId, runner, lost, number, version };
}

/** When the token was revoked, by its hash in the directory (null: live). */
async function revokedAt(token: string): Promise<number | null | undefined> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const row = await env.DIRECTORY.prepare("SELECT revoked_at FROM tokens WHERE token_hash = ?")
    .bind(hash)
    .first<{ revoked_at: number | null }>();
  return row?.revoked_at;
}
