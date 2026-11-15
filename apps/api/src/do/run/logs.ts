import type { DoMemoryBudget } from "@fyrden/adapters-cloudflare/git";
import { countSubrequests, type Logger, type Metrics } from "@fyrden/adapters-cloudflare/obs";
import { decideLogFlush, type LogFlushDecision } from "@fyrden/domain/ci";
import type { ConnectCode } from "../../runner/connect.js";
import {
  INVALID_MESSAGE,
  LOG_INDEX_AHEAD,
  TASK_ID_MISMATCH,
  TASK_NOT_FOUND,
} from "../../runner/errors.js";
import {
  type DecodedUpdateLog,
  decodeUpdateLogRequest,
  encodeUpdateLogResponse,
  type Timestamp,
  UPDATE_LOG_MAX_CONTENT_BYTES,
  UPDATE_LOG_MAX_ROWS,
} from "../../runner/proto/messages.js";
import { ProtoError } from "../../runner/proto/wire.js";
import type { TaskAnswer, TaskRef } from "../RunDO.js";
import type { RunEngine } from "./engine.js";

/*
 * A task's log inside its run's object. The runner keeps every row past the
 * ack it was sent and resends all of them on each call, so nothing is
 * buffered here: a request's new rows are either stored as one NDJSON object
 * in R2 (bucket `CI`), named in the manifest, and acked, or not acked at all
 * and sent again. The ack is durable before it is sent, so a reset loses
 * nothing that was acked.
 */

/** What `appendLog` answers: an encoded UpdateLogResponse, or a Connect error. */
export type AppendLogAnswer =
  | { readonly ok: true; readonly response: Uint8Array }
  | {
      readonly ok: false;
      readonly code: Extract<ConnectCode, "not_found" | "invalid_argument">;
      readonly message: string;
    };

/** Pause or fail points for tests. */
export interface LogHooks {
  /** A request's new rows are to be stored, before their object is written. */
  beforeLogStore?: () => Promise<void> | void;
  /** After a chunk's object (`key`) is written, before the manifest records it. */
  afterLogPut?: (key: string) => Promise<void> | void;
  /** After the manifest and the ack are committed, before the answer. */
  afterLogCommit?: () => Promise<void> | void;
}

/** What the log work needs from its object. */
export interface LogsHost {
  readonly env: Env;
  readonly engine: RunEngine;
  readonly hooks: LogHooks;
  readonly metrics: Metrics;
  readonly log: Logger;
  /** The object's memory pool: each request reserves from it on arrival, or is not taken. */
  readonly memory: DoMemoryBudget;
  now(): number;
  erased(): boolean;
  tx<T>(fn: () => T): T;
  /** The task's first report: the directory records it, once. */
  confirm(wireId: number, runnerId: number): Promise<void>;
  updateTask(ref: TaskRef): TaskAnswer<{ cancel: boolean }>;
  markLogComplete(ref: TaskRef): void;
}

/**
 * A request reserves this many times its body: the body, the decoded rows
 * and the NDJSON written from them. Proposed.
 */
const MEMORY_PER_BODY_BYTE = 3;
const BUCKET = "fyrden-ci";

interface MapRow {
  job_id: number;
  task: number;
  confirmed_at: number | null;
}

type Flush = Extract<LogFlushDecision, { kind: "flush" }>;

export class RunLogs {
  /** Tasks with a request in progress: another request for one is answered at once. */
  readonly #busy = new Set<number>();
  /** When the oldest unacked row of each task was first seen; lost on a reset, which only restarts that clock. */
  readonly #firstSeen = new Map<number, number>();

  constructor(private readonly host: LogsHost) {}

  /** The rows of task `task` stored contiguously from position 0. */
  ackOf(task: number): number {
    return (
      this.host.engine.rows<{ ack_index: number }>(
        "SELECT ack_index FROM ci_logs WHERE task = ?",
        task,
      )[0]?.ack_index ?? 0
    );
  }

  /** Whether every row of task `task` is stored: a whole final request committed. */
  complete(task: number): boolean {
    return (
      this.host.engine.rows<{ state: string }>("SELECT state FROM ci_logs WHERE task = ?", task)[0]
        ?.state === "complete"
    );
  }

  /**
   * Task `task` completed: a log not complete by then ends incomplete. A
   * whole final request arriving later still completes it. Call in the
   * completion's transaction.
   */
  taskEnded(task: number): void {
    this.host.engine.exec(
      `INSERT INTO ci_logs (task, state, updated_at) VALUES (?, 'incomplete', ?)
       ON CONFLICT (task) DO UPDATE SET
         state = CASE WHEN state = 'streaming' THEN 'incomplete' ELSE state END,
         updated_at = excluded.updated_at`,
      task,
      this.host.now(),
    );
  }

  /**
   * An UpdateLog for wire task `wireId` (`truncated`: `body` is a prefix of
   * a longer one). A request for a task that already has one in progress,
   * or that the memory pool cannot take now, is answered with the stored ack
   * before it is decoded: the runner keeps the rows and sends them again.
   */
  async append(
    wireId: number,
    body: Uint8Array,
    truncated: boolean,
    runnerId: number,
  ): Promise<AppendLogAnswer> {
    const { host } = this;
    if (host.erased()) return notFound();
    const map = host.engine.rows<MapRow>(
      "SELECT job_id, task, confirmed_at FROM ci_tasks WHERE wire_id = ?",
      wireId,
    )[0];
    if (!map) return notFound();
    const ref: TaskRef = { jobId: map.job_id, task: map.task };
    if (this.#busy.has(ref.task)) {
      host.log.debug("log request answered while another is in progress", {
        taskId: wireId,
        task: ref.task,
      });
      return acked(this.ackOf(ref.task));
    }
    const bytes = Math.max(1, MEMORY_PER_BODY_BYTE * body.byteLength);
    const reservation =
      bytes <= host.memory.stats().totalBytes ? host.memory.tryReserve(bytes) : undefined;
    if (!reservation) {
      host.log.warn("log request not admitted: the memory pool is taken", {
        taskId: wireId,
        task: ref.task,
        bytes,
      });
      return acked(this.ackOf(ref.task));
    }
    this.#busy.add(ref.task);
    try {
      return await this.#append(wireId, ref, map.confirmed_at === null, body, truncated, runnerId);
    } finally {
      this.#busy.delete(ref.task);
      reservation.release();
    }
  }

  async #append(
    wireId: number,
    ref: TaskRef,
    unconfirmed: boolean,
    body: Uint8Array,
    truncated: boolean,
    runnerId: number,
  ): Promise<AppendLogAnswer> {
    const { host } = this;
    let request: DecodedUpdateLog;
    try {
      request = decodeUpdateLogRequest(body, {
        truncated,
        maxRows: UPDATE_LOG_MAX_ROWS,
        maxContentBytes: UPDATE_LOG_MAX_CONTENT_BYTES,
      });
    } catch (error) {
      if (error instanceof ProtoError) return invalid(INVALID_MESSAGE);
      throw error;
    }
    if (request.taskId !== wireId) return invalid(TASK_ID_MISMATCH);
    if (unconfirmed) await host.confirm(wireId, runnerId);
    // A heartbeat too. Rows for a finished task are still taken: a cancelled job's last rows,
    // or a final call that lands after the runner reported its result.
    const beat = host.updateTask(ref);
    if (!beat.ok && beat.code !== "task_finished") return notFound();

    const ackIndex = this.ackOf(ref.task);
    const decision = decideLogFlush(
      { ackIndex, firstUnackedSeenAt: this.#firstSeen.get(ref.task) },
      request,
      host.now(),
    );
    if (decision.kind === "ahead") {
      // The ack is durable before it is sent, so only lost state lets a runner start past it.
      host.log.error("log index ahead of stored rows: an invariant is broken", {
        taskId: wireId,
        task: ref.task,
        index: request.index,
        ackIndex,
      });
      return invalid(LOG_INDEX_AHEAD);
    }
    if (decision.kind === "hold") {
      if (decision.firstUnackedSeenAt === undefined) this.#firstSeen.delete(ref.task);
      else this.#firstSeen.set(ref.task, decision.firstUnackedSeenAt);
      return acked(decision.ackIndex);
    }
    await host.hooks.beforeLogStore?.();
    const ack = await this.#store(wireId, ref, decision, request);
    if (ack === "erased") return notFound();
    await host.hooks.afterLogCommit?.();
    return acked(ack);
  }

  /**
   * Writes the flush's lines as a new object, then records it in the
   * manifest and advances the ack from `start` to `end` in one transaction,
   * only if the ack is still `start` and the run was not erased meanwhile.
   * A flush that loses, or whose run is gone, deletes its own object (its key
   * is its alone). The stored ack, or `erased`.
   */
  async #store(
    wireId: number,
    ref: TaskRef,
    flush: Flush,
    request: DecodedUpdateLog,
  ): Promise<number | "erased"> {
    const { host } = this;
    const { start, end, lines, final } = flush;
    let chunk: { key: string; bytes: number } | undefined;
    if (lines.length > 0) {
      const from = start - request.index;
      const text = lines
        .map((content, k) =>
          JSON.stringify({ i: start + k, t: unixMs(request.rows[from + k]?.time), c: content }),
        )
        .join("\n");
      const encoded = new TextEncoder().encode(`${text}\n`);
      const key = this.#key(ref, start, end);
      host.metrics.count("r2.class_a", { bucket: BUCKET, op: "put_log_chunk" });
      await host.env.CI.put(key, encoded, {
        httpMetadata: { contentType: "application/x-ndjson" },
      });
      chunk = { key, bytes: encoded.byteLength };
      await host.hooks.afterLogPut?.(key);
    }
    const outcome = host.tx((): "won" | "lost" | "erased" => {
      // Erasure removes every log row: nothing may be written after it.
      if (host.erased()) return "erased";
      const now = host.now();
      host.engine.exec(
        "INSERT INTO ci_logs (task, updated_at) VALUES (?, ?) ON CONFLICT (task) DO NOTHING",
        ref.task,
        now,
      );
      if (this.ackOf(ref.task) !== start) return "lost";
      if (chunk)
        host.engine.exec(
          `INSERT INTO ci_log_chunks (task, start_index, end_index, bytes, r2_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          ref.task,
          start,
          end,
          chunk.bytes,
          chunk.key,
          now,
        );
      host.engine.exec(
        `UPDATE ci_logs SET ack_index = ?, rows = rows + ?, bytes = bytes + ?,
           state = CASE WHEN ? THEN 'complete' ELSE state END, updated_at = ?
         WHERE task = ? AND ack_index = ?`,
        end,
        lines.length,
        chunk?.bytes ?? 0,
        final ? 1 : 0,
        now,
        ref.task,
        start,
      );
      return "won";
    });
    if (outcome !== "won") {
      host.log.info(
        outcome === "erased"
          ? "log chunk not recorded: the run was erased"
          : "log chunk lost to another flush of its rows",
        { taskId: wireId, task: ref.task, start, end },
      );
      if (chunk) await this.#deleteOwn(wireId, ref, chunk.key);
      return outcome === "erased" ? "erased" : this.ackOf(ref.task);
    }
    this.#firstSeen.delete(ref.task);
    // The run may have completed the task first, with its log incomplete: now it is complete.
    if (final && host.engine.instance(ref.jobId)?.status === "completed") host.markLogComplete(ref);
    return end;
  }

  /** Deletes an object this request wrote and nothing names; best effort. */
  async #deleteOwn(wireId: number, ref: TaskRef, key: string): Promise<void> {
    // R2 deletes are free (not Class A: https://developers.cloudflare.com/r2/pricing/#free-operations),
    // but each is still a call against the invocation's internal budget.
    countSubrequests("internal");
    try {
      await this.host.env.CI.delete(key);
    } catch (error) {
      // Unreferenced either way: retention sweeps the run's prefix.
      this.host.log.warn("log chunk not deleted", {
        taskId: wireId,
        task: ref.task,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** `runs/<run>/<attempt>/<job>/<task>/<start>-<end>-<write id>.ndjson`: a key no other flush uses. */
  #key(ref: TaskRef, start: number, end: number): string {
    const run = this.host.engine.run();
    const instance = this.host.engine.instance(ref.jobId);
    if (!run || !instance) throw new Error("the task's run or instance is gone");
    const writeId = [...crypto.getRandomValues(new Uint8Array(16))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const range = `${pad(start)}-${pad(end)}`;
    return `runs/${run.run_id}/${instance.attempt}/${ref.jobId}/${ref.task}/${range}-${writeId}.ndjson`;
  }
}

const pad = (n: number) => String(n).padStart(10, "0");

/** A row's time in Unix milliseconds; null when the runner sent none. */
function unixMs(time: Timestamp | undefined): number | null {
  return time ? time.seconds * 1000 + Math.floor(time.nanos / 1_000_000) : null;
}

const acked = (ackIndex: number): AppendLogAnswer => ({
  ok: true,
  response: encodeUpdateLogResponse({ ackIndex }),
});
const notFound = (): AppendLogAnswer => ({
  ok: false,
  code: "not_found",
  message: TASK_NOT_FOUND,
});
const invalid = (message: string): AppendLogAnswer => ({
  ok: false,
  code: "invalid_argument",
  message,
});
