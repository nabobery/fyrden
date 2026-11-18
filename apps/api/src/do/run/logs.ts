import type { DoMemoryBudget, SliceResult } from "@fyrden/adapters-cloudflare/git";
import { countSubrequests, type Logger, type Metrics } from "@fyrden/adapters-cloudflare/obs";
import { tokenLength } from "@fyrden/domain";
import {
  decideLogFlush,
  LOG_ROW_TOO_LARGE,
  type LogMask,
  type LogMaskCarry,
  type MaskRowsResult,
  maskGapLength,
  maskRows,
  type StoredLogLine,
  settleFlush,
} from "@fyrden/domain/ci";
import { type ConnectCode, UPDATE_LOG_PREFIX_BYTES } from "../../runner/connect.js";
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
import { type LogLine, logLine, viewerHooks } from "./viewers.js";

/*
 * A task's log inside its run's object. The runner keeps every row past the
 * ack it was sent and resends all of them on each call, so nothing is
 * buffered here: a request's new rows are either stored as one NDJSON object
 * in R2 (bucket `CI`), named in the manifest, and acked, or not acked at all
 * and sent again. The ack is durable before it is sent, so a reset loses
 * nothing that was acked.
 *
 * Rows are masked before they are stored: the task's job tokens and the
 * values its rows register with `::add-mask::` become `***`, whole or split
 * across rows. Rows whose masked text a later row could still change are
 * left unacked for the runner to resend (a few, for a while); the partial
 * match in progress at the ack is stored with it, so a resend after a reset
 * masks the same. The values are kept until the log closes: when it
 * completes, or `LOG_LATE_MS` after its task ended incomplete, after which its
 * rows are refused.
 *
 * While a job is watched live, each request's rows that are final as masked
 * (stored now, or settled and left unacked) are published to its sockets:
 * settled rows are masked with what the store will use (the stored masks,
 * the carry at the ack), so they are the rows stored later, byte for byte.
 */

/** How long an incomplete log takes rows after its task ended (a spent runner's report margin). Proposed. */
export const LOG_LATE_MS = 10 * 60_000;
/**
 * Job tokens a task's log is masked with at most: its first and the
 * re-mints of lost answers. Each is kept, so overlapping re-offers that
 * finish in any order all stay masked. Proposed.
 */
export const MAX_JOB_TOKEN_MASKS = 8;
/**
 * The room the caps on `::add-mask::` values keep for a task's job tokens,
 * the same from its first row whether or not any token is stored yet, so a
 * token registered late never changes which values register.
 */
const TOKEN_RESERVE = {
  values: MAX_JOB_TOKEN_MASKS,
  bytes: MAX_JOB_TOKEN_MASKS * tokenLength("job"),
} as const;
/** Closed logs whose masks one pass of the close job deletes. */
const CLOSE_PAGE = 256;

/**
 * More values to mask a task's rows with, fetched again on every request
 * rather than stored here (none yet). They follow the stored masks, so a
 * partial match of one of them is not carried past a request's ack.
 */
export interface MaskSource {
  masksFor(ref: TaskRef): Promise<readonly string[]>;
}

export const NO_MASK_SOURCE: MaskSource = { masksFor: async () => [] };

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

/** Where a request's final rows go: the job's live sockets (`viewers.ts`). */
export interface LogPublisher {
  /** Pauses catch-up reservations until release; yielding waits for active readers to release memory. */
  beginUpload(): { yieldMemory(): Promise<void>; release(): void };
  logsExpired(): void;
  watched(jobId: number): boolean;
  /** `rows` from position `base` are final as masked (stored, or settled). */
  publish(jobId: number, task: number, base: number, rows: readonly LogLine[]): void;
  /** Gives back the memory held for sockets. */
  dropCaches(): void;
}

/** What the log work needs from its object. */
export interface LogsHost {
  readonly env: Env;
  readonly engine: RunEngine;
  readonly hooks: LogHooks;
  readonly metrics: Metrics;
  readonly log: Logger;
  /** Each request reserves before decoding; stored-log catch-up yields first when needed. */
  readonly memory: DoMemoryBudget;
  now(): number;
  erased(): boolean;
  tx<T>(fn: () => T): T;
  /** The task's first report: the directory records it, once. */
  confirm(wireId: number, runnerId: number): Promise<void>;
  updateTask(ref: TaskRef): TaskAnswer<{ cancel: boolean }>;
  markLogComplete(ref: TaskRef): void;
  /** Has the close job run by `runAt` (sooner if it already will). */
  ensureLogClose(runAt: number): void;
  readonly masks: MaskSource;
  readonly viewers: LogPublisher;
}

/**
 * A request reserves this many times its body: the body, the decoded rows,
 * their masked text and the NDJSON written from them. Masking copies only
 * the rows it changes, and `***` for a matched value of at least 2 chars
 * makes a row at most a third longer (a 2-char value between separators),
 * so a fourth share covers it. Proposed.
 */
const MEMORY_PER_BODY_BYTE = 4;
const BUCKET = "fyrden-ci";

interface MapRow {
  job_id: number;
  task: number;
  confirmed_at: number | null;
}

interface LogRow {
  ack_index: number;
  state: "streaming" | "complete" | "incomplete";
  mask_carry: string | null;
  ended_at: number | null;
  omitted_rows: number;
  gap_remaining: number;
  finalized: number;
}

/** What a request stores: lines `[start, end)` (a final sentinel is acked, not a line) and what goes with them. */
interface Store {
  readonly start: number;
  readonly end: number;
  readonly lines: readonly StoredLogLine[];
  readonly rows: number;
  readonly omitted: number;
  readonly gapRemaining: number | ((storedMasks: readonly LogMask[]) => number);
  readonly final: boolean;
  /** `::add-mask::` values the stored rows registered, in order, with their rows. */
  readonly added: readonly { readonly value: string; readonly index: number }[];
  /** The carry at `end`, given the number of stored masks when it commits (null: none). */
  readonly carry: (storedMasks: number) => LogMaskCarry | null;
}

/** Whether a log is sealed or past its late window. */
function closed(log: LogRow | undefined, now: number): boolean {
  if (!log) return false;
  if (log.state === "complete" || log.finalized === 1) return true;
  return log.state === "incomplete" && log.ended_at !== null && log.ended_at + LOG_LATE_MS <= now;
}

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

  /** Whether a whole final request committed with no omitted row. */
  complete(task: number): boolean {
    return (
      this.host.engine.rows<{ state: string }>("SELECT state FROM ci_logs WHERE task = ?", task)[0]
        ?.state === "complete"
    );
  }

  /**
   * Task `task`'s instance completed at `endedAt`: a log not complete by then
   * ends incomplete, and takes rows for `LOG_LATE_MS` more (a whole final
   * request in that time still completes it); then its masks are deleted.
   * The first end counts. Call in the completion's transaction.
   */
  taskEnded(task: number, endedAt: number): void {
    const { engine } = this.host;
    engine.exec(
      `INSERT INTO ci_logs (task, state, ended_at, updated_at) VALUES (?, 'incomplete', ?, ?)
       ON CONFLICT (task) DO UPDATE SET
         state = CASE WHEN state = 'streaming' THEN 'incomplete' ELSE state END,
         ended_at = COALESCE(ended_at, excluded.ended_at),
         updated_at = excluded.updated_at`,
      task,
      endedAt,
      this.host.now(),
    );
    this.#closeLater(task);
  }

  /**
   * Registers job token `value` to be masked in every row of task `task`,
   * unless the task has it already. Every token minted for a task is kept
   * (masks only ever append, so a stored carry's position never moves), at
   * most `MAX_JOB_TOKEN_MASKS` of them, room the caps on `::add-mask::`
   * values keep free. A finalized log takes no more rows, so it gets none.
   * False when the task has its last token already: that token must not be
   * handed out.
   */
  addMask(task: number, value: string): boolean {
    const { host } = this;
    return host.tx(() => {
      if (host.erased() || this.#log(task)?.finalized === 1) return true;
      const tokens = host.engine.rows<{ value: string }>(
        "SELECT value FROM ci_log_masks WHERE task = ? AND kind = 'job_token'",
        task,
      );
      if (tokens.some((t) => t.value === value)) return true;
      if (tokens.length >= MAX_JOB_TOKEN_MASKS) return false;
      host.engine.exec(
        `INSERT INTO ci_log_masks (task, seq, kind, from_index, value)
         VALUES (?1, COALESCE((SELECT MAX(seq) + 1 FROM ci_log_masks WHERE task = ?1), 0), 'job_token', 0, ?2)`,
        task,
        value,
      );
      // A task that ended meanwhile still has its masks deleted.
      this.#closeLater(task);
      return true;
    });
  }

  /** Whether task `task` holds `MAX_JOB_TOKEN_MASKS` job tokens already. */
  jobTokensFull(task: number): boolean {
    return (
      (this.host.engine.rows<{ n: number }>(
        "SELECT COUNT(*) AS n FROM ci_log_masks WHERE task = ? AND kind = 'job_token'",
        task,
      )[0]?.n ?? 0) >= MAX_JOB_TOKEN_MASKS
    );
  }

  /** Has the close job visit an ended, incomplete log once its late window ends. */
  #closeLater(task: number): void {
    const log = this.#log(task);
    if (log?.state === "incomplete" && log.finalized === 0 && log.ended_at !== null)
      this.host.ensureLogClose(log.ended_at + LOG_LATE_MS);
  }

  /**
   * One pass of the close job: deletes the masks and carries of logs that
   * closed (complete, or incomplete past the late window), a page at a time,
   * then waits for the next window to end while any remains.
   */
  closeSlice(): SliceResult {
    const { host } = this;
    host.viewers.logsExpired();
    return host.tx((): SliceResult => {
      if (host.erased()) return { done: true };
      const now = host.now();
      const due = now - LOG_LATE_MS;
      const tasks = host.engine.rows<{ task: number }>(
        `SELECT task FROM ci_logs
         WHERE (finalized = 1 OR state = 'complete' OR (state = 'incomplete' AND ended_at <= ?))
           AND (gap_remaining > 0 OR mask_carry IS NOT NULL OR EXISTS (SELECT 1 FROM ci_log_masks m WHERE m.task = ci_logs.task))
         LIMIT ?`,
        due,
        CLOSE_PAGE,
      );
      for (const { task } of tasks) {
        host.engine.exec("DELETE FROM ci_log_masks WHERE task = ?", task);
        host.engine.exec(
          "UPDATE ci_logs SET mask_carry = NULL, gap_remaining = 0 WHERE task = ?",
          task,
        );
      }
      if (tasks.length === CLOSE_PAGE) return { done: false, cursor: null, runAfterMs: 0 };
      const next = host.engine.rows<{ ended_at: number | null }>(
        `SELECT MIN(ended_at) AS ended_at FROM ci_logs
         WHERE state = 'incomplete' AND finalized = 0 AND ended_at > ?`,
        due,
      )[0]?.ended_at;
      return next === null || next === undefined
        ? { done: true }
        : { done: false, cursor: null, runAfterMs: Math.max(0, next + LOG_LATE_MS - now) };
    });
  }

  #log(task: number): LogRow | undefined {
    return this.host.engine.rows<LogRow>(
      "SELECT ack_index, state, mask_carry, ended_at, omitted_rows, gap_remaining, finalized FROM ci_logs WHERE task = ?",
      task,
    )[0];
  }

  /** The task's stored masks, in the order they were added; its job tokens count inside `TOKEN_RESERVE`. */
  #masks(task: number): LogMask[] {
    return this.host.engine
      .rows<{ value: string; from_index: number; kind: string }>(
        "SELECT value, from_index, kind FROM ci_log_masks WHERE task = ? ORDER BY seq",
        task,
      )
      .map((m) => ({
        value: m.value,
        fromIndex: m.from_index,
        reserved: m.kind === "job_token",
      }));
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
    this.#busy.add(ref.task);
    const priority = host.viewers.beginUpload();
    let reservation: ReturnType<DoMemoryBudget["tryReserve"]>;
    try {
      const bytes = Math.max(1, MEMORY_PER_BODY_BYTE * body.byteLength);
      const fits = bytes <= host.memory.stats().totalBytes;
      reservation = fits ? host.memory.tryReserve(bytes) : undefined;
      if (!reservation && fits) {
        host.viewers.dropCaches();
        reservation = host.memory.tryReserve(bytes);
      }
      if (!reservation && fits) {
        await priority.yieldMemory();
        if (host.erased()) return notFound();
        reservation = host.memory.tryReserve(bytes);
      }
      if (!reservation) {
        host.log.warn("log request not admitted: the memory pool is taken", {
          taskId: wireId,
          task: ref.task,
          bytes,
        });
        return acked(this.ackOf(ref.task));
      }
      return await this.#append(wireId, ref, map.confirmed_at === null, body, truncated, runnerId);
    } finally {
      this.#busy.delete(ref.task);
      reservation?.release();
      priority.release();
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
    if (request.oversizedFirstRow && !(truncated && body.byteLength >= UPDATE_LOG_PREFIX_BYTES))
      delete request.oversizedFirstRow;
    if (unconfirmed) await host.confirm(wireId, runnerId);
    // A heartbeat too. Rows for a finished task are still taken: a cancelled job's last rows,
    // or a final call that lands after the runner reported its result.
    const beat = host.updateTask(ref);
    if (!beat.ok && beat.code !== "task_finished") return notFound();

    const now = host.now();
    const log = this.#log(ref.task);
    const ackIndex = log?.ack_index ?? 0;
    // A complete log answers its final ack and stores nothing more; an incomplete one past its
    // late window has no masks left, so nothing can be stored safely: the runner gives up.
    if (log?.state === "complete" || log?.finalized === 1) return acked(ackIndex);
    if (closed(log, now)) return notFound();
    const state = { ackIndex, firstUnackedSeenAt: this.#firstSeen.get(ref.task) };
    const decision = decideLogFlush(state, request, now);
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
    const timeOf = (index: number) => unixMs(request.rows[index - request.index]?.time);
    const lineAt = (start: number) => (content: string, k: number) =>
      logLine(start + k, timeOf(start + k), content);
    if (decision.kind === "hold") {
      if (decision.firstUnackedSeenAt === undefined) this.#firstSeen.delete(ref.task);
      else this.#firstSeen.set(ref.task, decision.firstUnackedSeenAt);
      // Watched: its settled rows go live, masked as they will be stored; nothing is kept.
      const fresh = request.rows.slice(ackIndex - request.index).map((row) => row.content);
      if (fresh.length > 0 && host.viewers.watched(ref.jobId)) {
        const settled = await this.#settled(ref, log, ackIndex, fresh);
        await this.#publish(ref, ackIndex, settled.map(lineAt(ackIndex)));
      }
      return acked(decision.ackIndex);
    }
    const stored = this.#masks(ref.task);
    const fetched = await host.masks.masksFor(ref);
    const masks = [...stored, ...fetched.map((value) => ({ value, fromIndex: 0 }))];
    if (decision.kind === "omit") {
      host.log.warn("log row omitted: too large for any request", {
        taskId: wireId,
        task: ref.task,
        index: decision.index,
        bytes: decision.bytes,
      });
      if (!this.#firstSeen.has(ref.task)) this.#firstSeen.set(ref.task, now);
      await host.hooks.beforeLogStore?.();
      const ack = await this.#store(wireId, ref, {
        start: decision.index,
        end: decision.index + 1,
        lines: [{ i: decision.index, omitted: LOG_ROW_TOO_LARGE, bytes: decision.bytes }],
        rows: 0,
        omitted: 1,
        final: false,
        added: [],
        carry: () => null,
        gapRemaining: (current) =>
          maskGapLength(
            [...current, ...fetched.map((value) => ({ value, fromIndex: 0 }))],
            decision.index,
          ),
      });
      if (ack === "erased" || ack === "closed") return notFound();
      this.#firstSeen.delete(ref.task);
      await host.hooks.afterLogCommit?.();
      return acked(ack);
    }
    const carry = parseCarry(log?.mask_carry ?? null);
    const mask = (force: boolean): MaskRowsResult =>
      maskRows(masks, carry, decision.lines, {
        start: decision.start,
        final: decision.final,
        force,
        reserve: TOKEN_RESERVE,
        gapRemaining: log?.gap_remaining ?? 0,
      });
    const first = mask(false);
    const settle = settleFlush(decision, first.settled, state, now);
    if (settle.kind === "hold") {
      this.#firstSeen.set(ref.task, settle.firstUnackedSeenAt);
      if (host.viewers.watched(ref.jobId))
        await this.#publish(
          ref,
          decision.start,
          first.lines.slice(0, first.settled).map(lineAt(decision.start)),
        );
      return acked(settle.ackIndex);
    }
    const masked = settle.force ? mask(true) : first;
    const count = Math.min(settle.end - settle.start, decision.lines.length);
    const boundary = settle.final ? null : masked.carryAt(count);
    if (!this.#firstSeen.has(ref.task)) this.#firstSeen.set(ref.task, now);
    await host.hooks.beforeLogStore?.();
    const from = settle.start - request.index;
    const ack = await this.#store(wireId, ref, {
      start: settle.start,
      end: settle.end,
      lines: masked.lines.slice(0, count).map((content, k) => ({
        i: settle.start + k,
        t: unixMs(request.rows[from + k]?.time),
        c: content,
      })),
      rows: count,
      omitted: 0,
      gapRemaining: masked.gapRemainingAt(count),
      final: settle.final,
      added: masked.added.filter((a) => a.index < settle.end),
      carry: (storedMasks) => storedCarry(boundary, stored.length, fetched.length, storedMasks),
    });
    if (ack === "erased" || ack === "closed") return notFound();
    if (ack === settle.end) {
      if (settle.firstUnackedSeenAt === undefined) this.#firstSeen.delete(ref.task);
      else this.#firstSeen.set(ref.task, settle.firstUnackedSeenAt);
      this.#dropped(wireId, ref, masked, settle.end);
    }
    await host.hooks.afterLogCommit?.();
    return acked(ack);
  }

  /**
   * The masked text of the leading rows of `fresh` (from `start`, the ack)
   * that no later row can change, exactly as a store would mask them: the
   * stored masks and those fetched, the carry stored with the ack, unforced.
   * Nothing is committed: values the rows register count within these rows
   * only, and none is reported dropped (their store reports them).
   */
  async #settled(
    ref: TaskRef,
    log: LogRow | undefined,
    start: number,
    fresh: readonly string[],
  ): Promise<readonly string[]> {
    const stored = this.#masks(ref.task);
    const fetched = await this.host.masks.masksFor(ref);
    const masked = maskRows(
      [...stored, ...fetched.map((value) => ({ value, fromIndex: 0 }))],
      parseCarry(log?.mask_carry ?? null),
      fresh,
      {
        start,
        final: false,
        force: false,
        reserve: TOKEN_RESERVE,
        gapRemaining: log?.gap_remaining ?? 0,
      },
    );
    return masked.lines.slice(0, masked.settled);
  }

  /** Publishes final rows to the job's sockets (a test may pause first). */
  async #publish(ref: TaskRef, base: number, rows: readonly LogLine[]): Promise<void> {
    const hook = viewerHooks.beforePublish;
    if (hook) await hook(this.host.engine.run()?.run_id ?? "");
    if (this.host.erased()) return;
    this.host.viewers.publish(ref.jobId, ref.task, base, rows);
  }

  /** Reports the `::add-mask::` values of stored rows that the caps kept from being registered. */
  #dropped(wireId: number, ref: TaskRef, masked: MaskRowsResult, end: number): void {
    const runId = this.host.engine.run()?.run_id ?? "";
    for (const { index, reason } of masked.dropped) {
      if (index >= end) continue;
      this.host.log.warn("mask value not registered", {
        runId,
        taskId: wireId,
        task: ref.task,
        index,
        reason,
      });
      this.host.metrics.count("ci.mask_dropped", { run: runId, task: String(ref.task), reason });
    }
  }

  /**
   * Writes the masked lines as a new object, then records it in the
   * manifest, advances the ack from `start` to `end`, registers the values
   * the stored rows added and stores the carry at `end` in one transaction,
   * only if the ack is still `start`, the log still takes rows and the run
   * was not erased meanwhile. A final store seals ingestion and deletes its
   * masks and carry; omissions keep the sealed log incomplete. A store that loses, or whose run or log closed, deletes
   * its own object (its key is its alone). The stored ack, `erased` or
   * `closed`.
   */
  async #store(wireId: number, ref: TaskRef, flush: Store): Promise<number | "erased" | "closed"> {
    const { host } = this;
    const { start, end, lines, final } = flush;
    let chunk: { key: string; bytes: number } | undefined;
    if (lines.length > 0) {
      const text = lines.map((line) => JSON.stringify(line)).join("\n");
      const encoded = new TextEncoder().encode(`${text}\n`);
      const key = this.#key(ref, start, end);
      host.metrics.count("r2.class_a", { bucket: BUCKET, op: "put_log_chunk" });
      await host.env.CI.put(key, encoded, {
        httpMetadata: { contentType: "application/x-ndjson" },
      });
      chunk = { key, bytes: encoded.byteLength };
      await host.hooks.afterLogPut?.(key);
    }
    const outcome = host.tx((): "complete" | "won" | "lost" | "erased" | "closed" => {
      // Erasure removes every log row: nothing may be written after it.
      if (host.erased()) return "erased";
      const now = host.now();
      host.engine.exec(
        "INSERT INTO ci_logs (task, updated_at) VALUES (?, ?) ON CONFLICT (task) DO NOTHING",
        ref.task,
        now,
      );
      const log = this.#log(ref.task) as LogRow;
      if (log.finalized === 1 || log.state === "complete" || log.ack_index !== start) return "lost";
      // Its masks may be gone already: nothing is stored without them.
      if (closed(log, now)) return "closed";
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
      let carry: LogMaskCarry | null = null;
      if (final) host.engine.exec("DELETE FROM ci_log_masks WHERE task = ?", ref.task);
      else {
        const count =
          host.engine.rows<{ n: number }>(
            "SELECT COUNT(*) AS n FROM ci_log_masks WHERE task = ?",
            ref.task,
          )[0]?.n ?? 0;
        // Added values take the positions after the masks stored now, in order.
        carry = flush.carry(count);
        for (const { value, index } of flush.added)
          host.engine.exec(
            `INSERT INTO ci_log_masks (task, seq, kind, from_index, value)
             VALUES (?1, COALESCE((SELECT MAX(seq) + 1 FROM ci_log_masks WHERE task = ?1), 0), 'add_mask', ?2, ?3)`,
            ref.task,
            index,
            value,
          );
      }
      const gapRemaining = final
        ? 0
        : typeof flush.gapRemaining === "number"
          ? flush.gapRemaining
          : flush.gapRemaining(this.#masks(ref.task));
      host.engine.exec(
        `UPDATE ci_logs SET ack_index = ?1, rows = rows + ?2, bytes = bytes + ?3,
           omitted_rows = omitted_rows + ?4,
           state = CASE WHEN NOT ?5 THEN state
             WHEN omitted_rows + ?4 = 0 THEN 'complete' ELSE 'incomplete' END,
           finalized = CASE WHEN ?5 THEN 1 ELSE finalized END,
           mask_carry = ?6, gap_remaining = ?7, updated_at = ?8
         WHERE task = ?9 AND ack_index = ?10`,
        end,
        flush.rows,
        chunk?.bytes ?? 0,
        flush.omitted,
        final ? 1 : 0,
        carry === null ? null : JSON.stringify(carry),
        gapRemaining,
        now,
        ref.task,
        start,
      );
      return final && this.complete(ref.task) ? "complete" : "won";
    });
    if (outcome !== "won" && outcome !== "complete") {
      host.log.info(
        outcome === "erased"
          ? "log chunk not recorded: the run was erased"
          : outcome === "closed"
            ? "log chunk not recorded: the log closed"
            : "log chunk lost to another flush of its rows",
        { taskId: wireId, task: ref.task, start, end },
      );
      if (chunk) await this.#deleteOwn(wireId, ref, chunk.key);
      if (outcome === "lost") {
        const ack = this.ackOf(ref.task);
        await this.#publish(ref, ack, []);
        return ack;
      }
      return outcome;
    }
    // The run may have completed the task first, with its log incomplete: now it is complete.
    if (outcome === "complete" && host.engine.instance(ref.jobId)?.status === "completed")
      host.markLogComplete(ref);
    await this.#publish(ref, start, lines);
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

/** A stored carry, or null when it is missing or not one (a partial match is then only lost). */
function parseCarry(text: string | null): LogMaskCarry | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<LogMaskCarry> | null;
    const { mask, variant, length, starts } = value ?? {};
    if (typeof mask !== "number" || typeof variant !== "number" || typeof length !== "number")
      return null;
    if (starts === undefined) return { mask, variant, length };
    if (
      !Array.isArray(starts) ||
      !starts.every(
        (start: unknown) =>
          start !== null &&
          typeof start === "object" &&
          "index" in start &&
          typeof start.index === "number" &&
          Number.isSafeInteger(start.index) &&
          start.index >= 0 &&
          "offset" in start &&
          typeof start.offset === "number" &&
          Number.isSafeInteger(start.offset) &&
          start.offset > -length &&
          start.offset <= 0,
      )
    )
      return null;
    return { mask, variant, length, starts };
  } catch {
    return null;
  }
}

/**
 * The carry as stored, by mask positions among the stored masks. The masker
 * numbered masks as given: `loaded` stored ones, then `fetched` from the
 * mask source, then the values the rows added. Added values are stored after
 * the `storedMasks` there are when the store commits (a job token re-minted
 * meanwhile included), so they move along; a fetched mask's partial match is
 * not carried, as its position is not stable.
 */
function storedCarry(
  carry: LogMaskCarry | null,
  loaded: number,
  fetched: number,
  storedMasks: number,
): LogMaskCarry | null {
  if (carry === null || carry.mask < loaded) return carry;
  if (carry.mask < loaded + fetched) return null;
  return { ...carry, mask: storedMasks + (carry.mask - loaded - fetched) };
}

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
